// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The per-session state machine (docs/PLAYBACK.md §9): drives ONE
 * `playback_sessions` row from `created` through to `ended`/`failed`,
 * polling its own row at a short interval and reacting — see
 * apps/worker/src/transcode/index.ts's module header for the full seam
 * contract this implements. Every sub-concern (token substitution,
 * process supervision, playlist folding, throttle reconciliation, staging
 * paths) lives in its own pure/narrow module (args.ts/process.ts/
 * playlist.ts/throttle.ts/staging.ts) — this file is the orchestration
 * glue, deliberately thin so the actually-tricky logic stays unit
 * testable without a real ffmpeg process or database.
 */
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbOrTx } from "@loombre/db/internal";
import {
  consumeSeekTarget,
  getMediaFileById,
  getTranscodeSessionRow,
  markSessionActive,
  markSessionFailed,
  markSessionStarting,
  updateProducedSegment,
  setThrottleSuspended,
  type TranscodeSessionRow,
} from "@loombre/db/internal";
import { nowMs as clockNowMs } from "@loombre/shared";
import { resolveFfmpeg } from "../probe/ffprobe.js";
import { substituteTokens, injectReadrate } from "./args.js";
import {
  SEGMENT_DURATION_SEC,
  SEGMENT_RETENTION_SEC,
  resolveTranscodePollIntervalMs,
  resolveTranscodeStagingRoot,
} from "./config.js";
import { InvalidStoredPlanError, parseStoredPlan, type StoredPlan } from "./plan-shape.js";
import {
  applyRunUpdate,
  emptyServedPlaylistState,
  highestProducedSegmentIndex,
  parseFfmpegPlaylist,
  pruneRetention,
  renderServedPlaylist,
  type ServedPlaylistState,
} from "./playlist.js";
import { spawnFfmpegRun, type FfmpegRunHandle, type SpawnFn } from "./process.js";
import { rebuildSeekArgs } from "./rebuild-args.js";
import { createRunDir, createSessionDir, deleteRunDir, deleteSessionDir, runDirFor, sessionDirFor } from "./staging.js";
import {
  reconcileThrottle,
  throttleMechanismForPlatform,
  WIN32_READRATE_MULTIPLIER,
  THROTTLE_SUSPEND_AHEAD,
  THROTTLE_RESUME_AHEAD,
  type ThrottleMechanism,
} from "./throttle.js";
import { getWorkerSettingValue, loadWorkerEffectiveSettings } from "../settings/effective-settings.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RunSessionDeps {
  db: DbOrTx;
  /** Overrides ffmpeg resolution (tests). Defaults to resolveFfmpeg(). */
  ffmpegPath?: string;
  stagingRoot?: string;
  pollIntervalMs?: number;
  /** Injected process spawn (tests substitute a fake child process —
   *  process.ts's own header). */
  spawnFn?: SpawnFn;
  /** Overrides the platform-derived throttle mechanism (tests only —
   *  never set in production wiring, consumer.ts). */
  mechanismOverride?: ThrottleMechanism;
  /** TEST-ONLY pacing aid (args.ts's header explains why a test needs
   *  this and why it is orthogonal to the throttle mechanism under test).
   *  Never set by consumer.ts's production wiring. */
  testReadrateMultiplier?: number;
  /** TEST-ONLY observability hook, fired once per spawned run (initial +
   *  every seek-restart) with that run's pid — lets integration tests
   *  verify REAL OS-level process state (`ps -o state=`) independently of
   *  this runtime's own internal bookkeeping. Never set by consumer.ts's
   *  production wiring. */
  onRunSpawned?: (pid: number | undefined, runIndex: number) => void;
  now?: () => number;
  /** TEST-ONLY overrides for transcode.segmentAheadSuspendThreshold/
   *  segmentAheadResumeThreshold (Addendum A registry) — production wiring
   *  (consumer.ts) never sets these; the real values are resolved from
   *  `deps.db` at session start, see runTranscodeSession's header. */
  suspendAheadThresholdOverride?: number;
  resumeAheadThresholdOverride?: number;
}

interface CurrentRun {
  index: number;
  dir: string;
  handle: FfmpegRunHandle;
  exited: boolean;
  exitInfo?: { exitCode: number | null; killedByUs: boolean; stderrTail: string };
  /** This runtime's own tracked physical suspend state (process.ts's
   *  header — there is no queryable "is this pid stopped" OS API). */
  processStopped: boolean;
}

/** Reads a run's own ffmpeg-written playlist off disk, tolerating "not
 *  created yet" (ffmpeg hasn't flushed anything, or hasn't even opened the
 *  output file for a brand-new run) as "nothing produced yet" rather than
 *  an error. */
async function readRunPlaylist(runDir: string): Promise<string | undefined> {
  try {
    return await readFile(join(runDir, "media.m3u8"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Drives one session's whole lifecycle. Resolves when the session reaches
 * a terminal DB state (`ended`/`failed`) — this is deliberately the
 * WHOLE-SESSION-DURATION promise consumer.ts's `queue.work('transcode',
 * ...)` handler awaits (CLAUDE.md invariant 6: the job queue is the
 * long-running-work primitive, this function's return IS "the job is
 * done").
 *
 * Addendum A, lane S3 (STATE.md, A3/AD1 read-site migration):
 * transcode.segmentAheadSuspendThreshold/segmentAheadResumeThreshold are
 * resolved ONCE here, at the top of the function — the natural "per
 * transcode admission" boundary (this function is called exactly once per
 * transcode SESSION, by consumer.ts's `queue.work('transcode', ...)`
 * handler) — and held fixed for that session's entire poll loop below.
 * This satisfies the A5 law without any extra machinery: a settings change
 * mid-session never touches an in-flight session's throttle behavior (it
 * keeps using the value resolved when IT started); the very next NEW
 * transcode admission picks up the new value automatically, since it calls
 * this function fresh.
 */
export async function runTranscodeSession(deps: RunSessionDeps, sessionId: string): Promise<void> {
  const db = deps.db;
  const now = deps.now ?? clockNowMs;
  const stagingRoot = deps.stagingRoot ?? resolveTranscodeStagingRoot();
  const pollIntervalMs = deps.pollIntervalMs ?? resolveTranscodePollIntervalMs();
  const mechanism = deps.mechanismOverride ?? throttleMechanismForPlatform(process.platform);

  let suspendAheadThreshold = deps.suspendAheadThresholdOverride ?? THROTTLE_SUSPEND_AHEAD;
  let resumeAheadThreshold = deps.resumeAheadThresholdOverride ?? THROTTLE_RESUME_AHEAD;
  if (deps.suspendAheadThresholdOverride === undefined || deps.resumeAheadThresholdOverride === undefined) {
    const settingsResult = await loadWorkerEffectiveSettings(db);
    if (deps.suspendAheadThresholdOverride === undefined) {
      suspendAheadThreshold = getWorkerSettingValue(settingsResult, "transcode.segmentAheadSuspendThreshold", THROTTLE_SUSPEND_AHEAD);
    }
    if (deps.resumeAheadThresholdOverride === undefined) {
      resumeAheadThreshold = getWorkerSettingValue(settingsResult, "transcode.segmentAheadResumeThreshold", THROTTLE_RESUME_AHEAD);
    }
  }

  let ffmpegPath = deps.ffmpegPath;
  if (!ffmpegPath) {
    const resolved = resolveFfmpeg();
    if (!resolved.ok) {
      await markSessionFailed(db, sessionId, { errorCode: "transcode-failed", stderrTail: resolved.error.message, nowMs: now() });
      return;
    }
    ffmpegPath = resolved.binary.path;
  }

  const sessionRow = await getTranscodeSessionRow(db, sessionId);
  if (!sessionRow) return; // Nothing to do — row vanished before the job ran.
  if (sessionRow.status === "ended" || sessionRow.status === "failed") return; // Already closed out.

  let plan: StoredPlan;
  try {
    plan = parseStoredPlan(sessionRow.plan);
  } catch (err) {
    const message = err instanceof InvalidStoredPlanError ? err.message : String(err);
    await markSessionFailed(db, sessionId, { errorCode: "transcode-failed", stderrTail: message, nowMs: now() });
    return;
  }

  if (!sessionRow.file_id) {
    await markSessionFailed(db, sessionId, { errorCode: "transcode-failed", stderrTail: "session has no file_id", nowMs: now() });
    return;
  }
  const file = await getMediaFileById(db, sessionRow.file_id);
  if (!file) {
    await markSessionFailed(db, sessionId, { errorCode: "transcode-failed", stderrTail: `media file ${sessionRow.file_id} not found`, nowMs: now() });
    return;
  }

  const sessionDir = await createSessionDir(stagingRoot, sessionId);
  await markSessionStarting(db, sessionId, { stagingDir: sessionDir, nowMs: now() });

  const isFmp4 = plan.container === "fmp4-hls";
  let servedState: ServedPlaylistState = emptyServedPlaylistState(SEGMENT_DURATION_SEC, isFmp4);

  function applyPlatformPacing(args: string[]): string[] {
    if (deps.testReadrateMultiplier !== undefined) return injectReadrate(args, deps.testReadrateMultiplier);
    if (process.platform === "win32") return injectReadrate(args, WIN32_READRATE_MULTIPLIER);
    return args;
  }

  async function spawnRun(runIndex: number, startSeg: number, args: string[], seekTargetMs?: number): Promise<CurrentRun> {
    const runDir = await createRunDir(stagingRoot, sessionDir, runIndex);
    const substituted = substituteTokens(args, {
      input: file!.path,
      runDir,
      segDurSec: SEGMENT_DURATION_SEC,
      startSeg,
      ...(seekTargetMs !== undefined ? { seekTargetMs } : {}),
    });
    const paced = applyPlatformPacing(substituted);
    const handle = spawnFfmpegRun(ffmpegPath!, paced, { cwd: runDir, ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}) });
    deps.onRunSpawned?.(handle.pid, runIndex);
    const run: CurrentRun = { index: runIndex, dir: runDir, handle, exited: false, processStopped: false };
    void handle.result.then((r) => {
      run.exited = true;
      run.exitInfo = r;
    });
    return run;
  }

  let currentRun = await spawnRun(0, 0, plan.ffmpegArgs);

  async function teardown(): Promise<void> {
    await currentRun.handle.terminate().catch(() => undefined);
    await deleteSessionDir(stagingRoot, sessionDir).catch(() => undefined);
  }

  for (;;) {
    await sleep(pollIntervalMs);

    const row: TranscodeSessionRow | undefined = await getTranscodeSessionRow(db, sessionId);
    if (!row || row.status === "ended" || row.status === "failed") {
      await teardown();
      return;
    }

    // Unexpected ffmpeg exit (not our own kill) — a real failure
    // (binding constraint 7).
    if (currentRun.exited && currentRun.exitInfo && !currentRun.exitInfo.killedByUs && currentRun.exitInfo.exitCode !== 0) {
      await markSessionFailed(db, sessionId, {
        errorCode: "transcode-failed",
        stderrTail: currentRun.exitInfo.stderrTail,
        nowMs: now(),
      });
      await deleteSessionDir(stagingRoot, sessionDir).catch(() => undefined);
      return;
    }

    // Fold this run's own playlist into served state + advance
    // produced_segment (observability + throttle input, docs/PLAYBACK.md §9).
    const runPlaylistText = await readRunPlaylist(currentRun.dir);
    if (runPlaylistText !== undefined) {
      const parsed = parseFfmpegPlaylist(runPlaylistText);
      servedState = applyRunUpdate(servedState, currentRun.index, `run${currentRun.index}`, parsed);
    }
    const producedSegment = highestProducedSegmentIndex(servedState);

    if (producedSegment !== undefined) {
      if (row.status === "starting" || row.status === "seeking") {
        await markSessionActive(db, sessionId, { producedSegment, nowMs: now() });
      } else if (row.produced_segment !== producedSegment) {
        await updateProducedSegment(db, sessionId, producedSegment, now());
      }

      // Retention pruning (binding constraint 5) + served-playlist rewrite.
      const pruned = pruneRetention(servedState, SEGMENT_RETENTION_SEC, currentRun.index);
      servedState = pruned.nextState;
      for (const seg of pruned.segmentsToDelete) {
        await unlink(join(sessionDir, seg.runDirName, seg.uri)).catch(() => undefined);
      }
      for (const runDirName of pruned.runDirsToDelete) {
        await deleteRunDir(stagingRoot, sessionDir, join(sessionDir, runDirName)).catch(() => undefined);
      }
      // ATOMIC rewrite (write-temp-then-rename), not a plain writeFile:
      // this served playlist is rewritten on EVERY loop iteration while a
      // real client is polling GET /playback/sessions/{id}/hls/media.m3u8.
      // writeFile opens with O_TRUNC, so a concurrent reader can observe
      // the file empty (between truncate and write) or partially written.
      // apps/server's hls-file.controller.ts already refuses a zero-length
      // read and re-polls, which is why this never surfaced as a client
      // bug — but that guard cannot detect a NON-empty partial playlist,
      // and the race also made session.integration.spec.ts flaky on slow
      // CI runners (it read '' where '#EXTM3U' was expected). rename(2) is
      // atomic within a directory on POSIX, and Node's rename replaces an
      // existing destination on Windows too (MOVEFILE_REPLACE_EXISTING),
      // so readers now see either the previous complete playlist or the
      // next one — never a torn state.
      const playlistPath = join(sessionDir, "media.m3u8");
      const playlistTmpPath = `${playlistPath}.tmp`;
      await writeFile(playlistTmpPath, renderServedPlaylist(servedState), "utf8");
      await rename(playlistTmpPath, playlistPath);
    }

    // Seek-restart (binding constraint 5) takes priority over throttle —
    // a viewer explicitly seeking should never be blocked by an
    // in-progress throttle reconciliation. That holds physically too:
    // terminate() SIGCONTs before its SIGTERM (process.ts), so restarting a
    // run whose process is currently throttle-SUSPENDED costs no extra kill
    // latency — a stopped ffmpeg would otherwise sit on the pending SIGTERM
    // for the whole graceful window before being SIGKILLed.
    if (row.seek_target_ms !== null) {
      const consumed = await consumeSeekTarget(db, sessionId, now());
      if (consumed) {
        try {
          await currentRun.handle.terminate();
          const nextIndex = currentRun.index + 1;
          const startSeg = (producedSegment ?? -1) + 1;
          const seekArgs = await rebuildSeekArgs(db, { fileId: sessionRow.file_id, deviceId: sessionRow.device_id ?? "", plan });
          currentRun = await spawnRun(nextIndex, startSeg, seekArgs, consumed.seekTargetMs);
        } catch (err) {
          // A seek-restart that cannot even regenerate args (e.g. the
          // device/file can no longer be resolved, rebuild-args.ts's
          // SeekRebuildError) is a real, unrecoverable pipeline failure —
          // never a silently-stuck 'seeking' row.
          await markSessionFailed(db, sessionId, {
            errorCode: "transcode-failed",
            stderrTail: err instanceof Error ? err.message : String(err),
            nowMs: now(),
          });
          await deleteSessionDir(stagingRoot, sessionDir).catch(() => undefined);
          return;
        }
        continue;
      }
    }

    // Steady-state throttle reconciliation (only meaningful once
    // active/suspended — starting/seeking are handled above).
    if (row.status === "active" || row.status === "suspended") {
      const action = reconcileThrottle({
        mechanism,
        producedSegment,
        requestedSegment: row.requested_segment,
        rowStatus: row.status,
        suspendedByThrottle: row.suspended_by_throttle,
        processStopped: currentRun.processStopped,
        suspendAheadThreshold,
        resumeAheadThreshold,
      });
      switch (action.kind) {
        case "suspend-for-throttle":
          currentRun.handle.suspend();
          currentRun.processStopped = true;
          await setThrottleSuspended(db, sessionId, { suspended: true, nowMs: now() });
          break;
        case "resume-for-throttle":
          currentRun.handle.resume();
          currentRun.processStopped = false;
          await setThrottleSuspended(db, sessionId, { suspended: false, nowMs: now() });
          break;
        case "stop-process-only":
          currentRun.handle.suspend();
          currentRun.processStopped = true;
          break;
        case "rewrite-suspended-only":
          await setThrottleSuspended(db, sessionId, { suspended: true, nowMs: now() });
          break;
        case "none":
          break;
      }
    }
  }
}

// Re-exported for tests that want to compute a session/run directory the
// same way this module does without duplicating the join logic.
export { sessionDirFor, runDirFor };
