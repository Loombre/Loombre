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
  absorbSeekTarget,
  consumePendingRungIndex,
  consumeSeekTarget,
  getMediaFileById,
  getTranscodeSessionRow,
  markSessionActive,
  markSessionFailed,
  markSessionStarting,
  recordActiveRungIndex,
  recordSessionWorkerProcess,
  recordTranscodeRun,
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
import { InvalidStoredPlanError, parseStoredPlan, topRungOf, type StoredPlan } from "./plan-shape.js";
import {
  applyRunUpdate,
  emptyServedPlaylistState,
  highestProducedSegmentIndex,
  parseFfmpegPlaylist,
  pruneRetention,
  renderServedPlaylist,
  servedPlaylistHasEnded,
  type ServedPlaylistState,
} from "./playlist.js";
import { spawnFfmpegRun, type FfmpegRunHandle, type SpawnFn } from "./process.js";
import { registerTranscodeRun } from "./run-registry.js";
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
  /** This worker PROCESS's start time (epoch ms), persisted alongside each
   *  spawned run's pid so the NEXT boot's reaper can tell a session
   *  supervised by a dead predecessor from one this generation owns
   *  (migrations/0041, reaper.ts). Defaults to this module's own
   *  process-start estimate; consumer.ts passes the real one. */
  workerStartedAtMs?: number;
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
  /** Where this run starts in SOURCE time: 0 for run 0, the consumed seek
   *  target for every seek-restart. The de-dup rule below compares an
   *  incoming seek target against this, and migration 0043 persists it
   *  (see recordTranscodeRun in spawnRun). */
  sourceOriginMs: number;
  /** How much of this run's own output has been produced, in source-time
   *  milliseconds (the sum of its segments' EXTINF durations). Together
   *  with sourceOriginMs this is the window this run is ALREADY serving. */
  producedMs: number;
  /** True once retention pruning has dropped any of THIS run's segments.
   *  From that moment the run's produced window is no longer contiguous
   *  from its origin — its head is gone from disk — so the de-dup rule
   *  narrows to exact-origin matching (see the seek block). */
  headPruned: boolean;
  /** This runtime's own tracked physical suspend state (process.ts's
   *  header — there is no queryable "is this pid stopped" OS API). */
  processStopped: boolean;
  /** Which rung of the stored plan's ladder this run is encoding (Wave C2,
   *  docs/PLAYBACK.md §9.1.3). `undefined` for a ladder-empty session,
   *  where no rung applies at all — never defaulted to 0, which is a real
   *  rung. */
  ladderRungIndex: number | undefined;
  /** Idempotent removal from the process-wide live-run registry
   *  (run-registry.ts, item C1) — called from this run's own exit handler
   *  AND from whichever path replaced/tore it down, whichever happens
   *  first. */
  unregister: () => void;
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
  // Node's uptime is the only in-process source for "when did THIS process
  // start" that needs no plumbing; consumer.ts passes index.ts's own
  // WORKER_STARTED_AT_MS, which is the authoritative value.
  const workerStartedAtMs = deps.workerStartedAtMs ?? Math.round(Date.now() - process.uptime() * 1000);

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

  // Wave C2 (§9.1.3): the rung run 0 encodes. `plan()`'s own `ffmpegArgs`
  // target the ladder's TOP rung, so the initial spawn's rung is that
  // rung's INDEX — the same index §9.1.1's master playlist publishes it
  // under, which is what makes a client's `v{K}` comparable to
  // `active_rung_index` at all. `undefined` for a ladder-empty session
  // (direct-stream copy, audio-only transcode): no rung applies, and 0
  // would be a lie about a real rung.
  const initialRungIndex = ((): number | undefined => {
    const top = topRungOf(plan.ladder);
    if (top === undefined) return undefined;
    const index = plan.ladder.indexOf(top);
    return index >= 0 ? index : undefined;
  })();

  async function spawnRun(
    runIndex: number,
    startSeg: number,
    args: string[],
    seekTargetMs?: number,
    ladderRungIndex?: number,
  ): Promise<CurrentRun> {
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
    // Continuation item 2 (migrations/0043): durably record WHERE this run
    // starts, in both coordinate systems it participates in — the global
    // segment counter (`startSeg`) and the SOURCE timeline
    // (`sourceOriginMs`). They are independent: segment numbering only ever
    // moves forward across a session's runs, while a backward seek starts a
    // later run at an earlier source position. Without this row, a run
    // after the first cannot be anchored in source time at all — its own
    // output timestamps restart at zero (spawned with `-ss`, no
    // `-copyts`), so the served playlist's durations describe presentation
    // time, which is exactly the thing that diverged. Run 0 is recorded
    // too, at origin 0: a consumer must never have to special-case "no row
    // means the first run".
    await recordTranscodeRun(db, {
      sessionId,
      runIndex,
      startSegment: startSeg,
      sourceOriginMs: seekTargetMs ?? 0,
      // Wave C2 (migration 0044): WHICH rung this run encoded, so a
      // session's run history says not just where each run started but at
      // what quality. Omitted (-> NULL) for a ladder-empty session.
      ...(ladderRungIndex !== undefined ? { ladderRungIndex } : {}),
      nowMs: now(),
    }).catch(() => undefined);
    // §9.1.3: the row must always name the rung that is REALLY running —
    // the server decides whether an incoming `v{K}` GET is a switch signal
    // by comparing K against this column, so a stale value would either
    // miss a real switch or manufacture a phantom one. Written at every
    // spawn, exactly like `worker_pid` below and for the same reason.
    // Best-effort: a failure here must never take down an otherwise-fine
    // session (the worst case is one redundant handoff).
    if (ladderRungIndex !== undefined) {
      await recordActiveRungIndex(db, sessionId, ladderRungIndex, now()).catch(() => undefined);
    }
    // Item C1: publish the live handle BEFORE anything can await, so a
    // shutdown signal arriving between the spawn and the next poll tick
    // still finds this process to terminate. ffmpeg is spawned detached on
    // POSIX (process.ts) and therefore outlives this worker unless
    // something explicitly kills it.
    const unregister = registerTranscodeRun(handle);
    // Item C2: persist the pid + THIS worker generation on the row, so a
    // hard kill (SIGKILL/OOM/power cut — no shutdown code runs at all)
    // still leaves the next boot's reaper a handle on this process. Every
    // spawn overwrites it, including a seek-restart's: the row must always
    // name the run that is actually alive. Best-effort — a failure here
    // must never take down a session that is otherwise fine (the reaper
    // simply has nothing to go on for it, exactly as before this column
    // existed).
    if (handle.pid !== undefined) {
      await recordSessionWorkerProcess(db, sessionId, {
        workerPid: handle.pid,
        workerStartedAtMs,
        nowMs: now(),
      }).catch(() => undefined);
    }
    const run: CurrentRun = {
      index: runIndex,
      dir: runDir,
      handle,
      exited: false,
      processStopped: false,
      unregister,
      sourceOriginMs: seekTargetMs ?? 0,
      producedMs: 0,
      headPruned: false,
      ladderRungIndex,
    };
    void handle.result.then((r) => {
      run.exited = true;
      run.exitInfo = r;
      // Exited on its own (or in response to our terminate) — it is no
      // longer something shutdown needs to kill.
      unregister();
    });
    return run;
  }

  let currentRun = await spawnRun(0, 0, plan.ffmpegArgs, undefined, initialRungIndex);

  /**
   * THE one restart path — shared by a seek, a §9.1.4 slot handoff, and the
   * §9.1.7 coincident pair. Kill the live run, wait for its OBSERVED exit,
   * rebuild args for `ladderRungIndex`, spawn at `startSeg` with
   * `originMs`. Returns false when the session was failed and the caller
   * must stop driving it.
   *
   * The sequencing is what makes §9.1.4's PROCESS-CENSUS INVARIANT ("at
   * every instant a session has <= 1 live ffmpeg") structural rather than
   * policed: `terminate()` resolves only on observed exit, and the spawn is
   * strictly after that `await`. There is no code path that can start a
   * second encoder while the first is alive — not "forbidden", but
   * inexpressible.
   */
  async function restartAt(
    nextIndex: number,
    startSeg: number,
    originMs: number,
    ladderRungIndex: number | undefined,
  ): Promise<boolean> {
    try {
      await currentRun.handle.terminate();
      currentRun.unregister();
      const args = await rebuildSeekArgs(db, {
        fileId: sessionRow!.file_id!,
        deviceId: sessionRow!.device_id ?? "",
        plan,
        ...(ladderRungIndex !== undefined ? { ladderRungIndex } : {}),
      });
      currentRun = await spawnRun(nextIndex, startSeg, args, originMs, ladderRungIndex);
      return true;
    } catch (err) {
      // A restart that cannot even regenerate args (e.g. the device/file
      // can no longer be resolved, rebuild-args.ts's SeekRebuildError) is a
      // real, unrecoverable pipeline failure — never a silently-stuck
      // 'seeking' row. §9.1.4's failure table, row 1: old process dead, new
      // never started, session -> failed -> terminal -> the admission slot
      // frees only via that terminal status, and the client's existing
      // fatal path surfaces it.
      await markSessionFailed(db, sessionId, {
        errorCode: "transcode-failed",
        stderrTail: err instanceof Error ? err.message : String(err),
        nowMs: now(),
      });
      await deleteSessionDir(stagingRoot, sessionDir).catch(() => undefined);
      return false;
    }
  }

  async function teardown(): Promise<void> {
    await currentRun.handle.terminate().catch(() => undefined);
    currentRun.unregister();
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
      // Source-time extent of what THIS run has produced so far, read from
      // ffmpeg's own per-run playlist (authoritative, and monotonic while
      // the run lives). Feeds the seek de-dup rule below; deliberately
      // taken BEFORE retention pruning, which is about what is still on
      // disk rather than what was produced.
      currentRun.producedMs = Math.round(parsed.segments.reduce((sum, seg) => sum + seg.durationSec, 0) * 1000);
    }
    const producedSegment = highestProducedSegmentIndex(servedState);

    if (producedSegment !== undefined) {
      if (row.status === "starting" || row.status === "seeking") {
        await markSessionActive(db, sessionId, { producedSegment, nowMs: now() });
      } else if (row.produced_segment !== producedSegment) {
        await updateProducedSegment(db, sessionId, producedSegment, now());
      }

      // Retention pruning (binding constraint 5) + served-playlist rewrite.
      //
      // PRUNE-FREEZE (Wave C2, §9.1.5 rule 4): once the served playlist
      // carries a terminal `EXT-X-ENDLIST`, pruning CEASES for this
      // session. RFC 8216 is explicit that a playlist which has ended must
      // not change, and removing its head is a change — a client that has
      // stopped polling would find its already-parsed fragments gone from
      // disk with no signal that anything moved. Disk stays bounded
      // regardless: at ENDLIST no new segments are produced either, so the
      // residual is at most one retention window (§9.1.8), reclaimed at
      // session teardown exactly as always. Tier-0 lens: this strictly
      // REDUCES steady-state I/O after a stream ends.
      const pruned = servedPlaylistHasEnded(servedState)
        ? { nextState: servedState, segmentsToDelete: [], runDirsToDelete: [] }
        : pruneRetention(servedState, SEGMENT_RETENTION_SEC, currentRun.index);
      servedState = pruned.nextState;
      // Once any of the CURRENT run's own segments has been pruned, its
      // produced window no longer starts at its origin — the head is gone
      // from disk — so the seek de-dup rule below must stop trusting
      // [origin, origin+producedMs] and fall back to exact-origin matching.
      if (pruned.segmentsToDelete.some((seg) => seg.runDirName === `run${currentRun.index}`)) {
        currentRun.headPruned = true;
      }
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

    // ── RESTART BLOCK (§9.1.7's SINGLE-RESTART RULE) ─────────────────────
    //
    // Wave C2 made this block serve TWO causes: a seek (`seek_target_ms`)
    // and a slot handoff (`pending_rung_index`). They are independent
    // columns written by independent request paths, and this tick reads
    // BOTH and spawns exactly ONE run — rung = pending rung if set else the
    // live rung, origin = seek target if set else the live-edge
    // continuation origin. Never two restarts, whichever landed first: the
    // interleaving is commutative because the spawned run is always
    // (requested rung, requested origin).
    //
    // Why that matters beyond tidiness: a restart is the most expensive
    // thing this runtime does (kill + observed exit + spawn + input open +
    // seek + encoder init + a full GOP), and the seek-livelock incident
    // proved that paying it twice for one client intention is how a session
    // produces nothing at all.
    //
    // The whole block still takes priority over throttle — a viewer
    // explicitly seeking (or switching quality) should never be blocked by
    // an in-progress throttle reconciliation. That holds physically too:
    // terminate() SIGCONTs before its SIGTERM (process.ts), so restarting a
    // run whose process is currently throttle-SUSPENDED costs no extra kill
    // latency — a stopped ffmpeg would otherwise sit on the pending SIGTERM
    // for the whole graceful window before being SIGKILLed.
    //
    // A PENDING SWITCH ALSO NARROWS SEEK ABSORPTION (§9.1.7): the "the live
    // run is already serving that position" shortcut is only sound when the
    // client wants the same BYTES. Under a pending switch to a different
    // rung it wants different ones, so absorption must not fire.
    const pendingRungIndex = row.pending_rung_index;
    const switchPending = pendingRungIndex !== null && pendingRungIndex !== currentRun.ladderRungIndex;

    if (row.seek_target_ms !== null) {
      // DE-DUPLICATION FIRST (process-lifecycle hardening wave, 2026-08-11,
      // continuation item 1 — THE SEEK-RESTART LIVELOCK).
      //
      // A client retrying a 503-retry-after for one too-far-ahead segment
      // makes the server record the SAME seek target on every retry. This
      // block used to consume each one unconditionally: kill the in-flight
      // ffmpeg, respawn it at the same position, repeat on the next tick
      // because another retry landed meanwhile. The run never survived long
      // enough to produce its first segment, so the client never stopped
      // retrying — a livelock that produced nothing while paying the most
      // expensive part of a run (spawn + input open + first keyframe) over
      // and over. Measured at 17 spawns for a single seek target before
      // this guard existed (seek-dedup.integration.spec.ts).
      //
      // MATCH SEMANTICS. Absorb only when the LIVE run is already serving
      // the requested position:
      //   * exact origin match — the floor, and the case the storm
      //     actually produces (the retries all name one position, which is
      //     the position the current run was just started at);
      //   * plus anything inside [origin, origin + producedMs], i.e. output
      //     this run has ALREADY written, where a restart would rebuild
      //     bytes that exist. Only while nothing of this run has been
      //     pruned: after that the window's lower end is no longer on disk,
      //     so a target there is a real backward seek and must restart.
      // Anything else — earlier, later, or a run that has exited — is a
      // genuine seek and takes the restart path below unchanged.
      //
      // Wave C2 adds ONE conjunct (§9.1.7): absorb only when no switch to a
      // DIFFERENT rung is pending. A seek into already-produced output is
      // "bytes we already have" — unless the client has meanwhile asked for
      // different bytes, in which case those bytes are the OLD rung's and
      // re-serving them is not what was requested.
      const inFlightWindowEndMs = currentRun.headPruned ? currentRun.sourceOriginMs : currentRun.sourceOriginMs + currentRun.producedMs;
      const alreadyServing =
        !currentRun.exited &&
        !switchPending &&
        row.seek_target_ms >= currentRun.sourceOriginMs &&
        row.seek_target_ms <= inFlightWindowEndMs;
      if (alreadyServing) {
        // Clear it without bumping discontinuity_count or touching status —
        // nothing restarted. Guarded on the exact value we just read, so a
        // DIFFERENT target written in the meantime is never swallowed; it
        // simply survives to the next tick and restarts properly.
        await absorbSeekTarget(db, sessionId, row.seek_target_ms, now());
        continue;
      }

      const consumed = await consumeSeekTarget(db, sessionId, now());
      if (consumed) {
        // §9.1.7: this seek restart ALSO carries any pending rung. Consumed
        // in the SAME tick so the coincident pair produces exactly one
        // spawned run rather than a seek restart immediately followed by a
        // handoff restart.
        const coincidentRung = switchPending ? await consumePendingRungIndex(db, sessionId, now()) : undefined;
        const restarted = await restartAt(
          currentRun.index + 1,
          (producedSegment ?? -1) + 1,
          consumed.seekTargetMs,
          coincidentRung ?? currentRun.ladderRungIndex,
        );
        if (!restarted) return;
        continue;
      }
    }

    // ── SLOT HANDOFF (§9.1.4), when no seek is also pending ──────────────
    //
    // Terminate-then-start, ZERO OVERLAP. Bounded overlap (start the new
    // rung, kill the old once the new produces) was considered and rejected
    // in the spec: it doubles encode load for the overlap window, which on
    // a box sized for one pipeline IS the "additional unrestricted
    // transcode" LD-16 forbids, merely time-limited. Zero overlap costs a
    // few seconds of live-edge 503 that the client's 8x1s retry policy —
    // tuned for exactly this server behaviour — already absorbs.
    //
    // The origin is EXACT, not an estimate: `old.sourceOriginMs +
    // old.producedMs` is the precise source instant after the old run's
    // last produced segment, and `producedMs` is read from ffmpeg's OWN
    // per-run playlist, which is append-only (§6 keeps
    // `-hls_playlist_type event` there) and therefore still complete even
    // after retention has pruned the SERVED playlist's head. Presentation
    // time stays continuous across the switch discontinuity, and the
    // spawned run is indistinguishable from any other run to every §9
    // derivation.
    //
    // The admission slot is untouched throughout: it is held by the
    // SESSION, and the session never goes terminal here.
    if (switchPending) {
      const consumedRung = await consumePendingRungIndex(db, sessionId, now());
      if (consumedRung !== undefined && consumedRung !== currentRun.ladderRungIndex) {
        const restarted = await restartAt(
          currentRun.index + 1,
          (producedSegment ?? -1) + 1,
          currentRun.sourceOriginMs + currentRun.producedMs,
          consumedRung,
        );
        if (!restarted) return;
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
