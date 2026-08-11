// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/lifecycle.integration.spec.ts
//
// an upstream media server-study implementation run, Lane A1 — the three END-TO-END
// proofs for items C1 (graceful shutdown terminates in-flight runs) and
// C2 (pid persistence + boot crash reaper), against a REAL ffmpeg, a REAL
// Postgres, and the REAL platform process inspector. The unit specs
// (run-registry.spec.ts, boot-reaper.spec.ts) pin the decision logic with
// everything injected; this file is where the claims about actual OS
// processes are made good:
//
//   (a) A graceful worker restart leaves NO orphaned ffmpeg. Verified with
//       `ps` against the real pid, not against this runtime's own
//       bookkeeping.
//   (b) The boot reaper reclaims a simulated HARD-KILL orphan: a real,
//       live, detached ffmpeg from a previous worker generation is
//       identified by pid + cmdline and killed, and a live process that is
//       NOT this session's ffmpeg is left strictly alone.
//   (c) The admission cap holds across a restart cycle: no slot is ever
//       freed while its process is still running. Asserted as an ORDERING
//       invariant, from inside the reaper's own callback — the session is
//       only allowed to become terminal (which is what frees the slot,
//       countActiveTranscodeSessions) after the process is already dead.
//
// Skips cleanly without ffmpeg, same convention as
// session.integration.spec.ts (and the same LOOMBRE_REQUIRE_FFMPEG hard
// failure on CI).

import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, countActiveTranscodeSessions, createPlaybackSession, endPlaybackSession, resolveTestDatabaseUrl } from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import { listReapableTranscodeSessions, markSessionFailed, recordSessionWorkerProcess, markSessionStarting } from "@loombre/db/internal";
import { plan, type DeviceProfile, type MediaInfo, type NetworkConditions, type PlanInput, type ServerPolicy, type TrackSelection, type VerifiedCapabilities } from "@loombre/playback-engine";
import { resolveFfmpeg } from "../../src/probe/ffprobe.js";
import { runTranscodeSession } from "../../src/transcode/runner.js";
import { activeTranscodeRunCount, terminateAllTranscodeRuns } from "../../src/transcode/run-registry.js";
import { createProcessInspector, reapOrphanedTranscodeSessions } from "../../src/transcode/reaper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const FIXTURE_PATH = join(REPO_ROOT, "test-fixtures", "media", "session_long.mp4");
const DB_PKG_ROOT = join(REPO_ROOT, "packages", "db");

const DATABASE_URL = resolveTestDatabaseUrl();
const ffmpegAvailable = ffmpegAvailableStrict();
const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);

function resetSchema(): void {
  const result = spawnSync(process.execPath, [join(DB_PKG_ROOT, "scripts", "migrate.mjs"), "reset"], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`migrate.mjs reset failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

/** True iff the OS still has this pid as a RUNNING process. Deliberately
 *  `ps`, never this runtime's own state — the whole point is independent
 *  verification.
 *
 *  A 'Z' state is explicitly not alive: a zombie is an un-reaped process
 *  table entry holding no CPU and no memory. It only exists here at all
 *  because these stand-in processes are children of the TEST process,
 *  which reaps them a tick later; a real orphan's parent is dead, so init
 *  reaps it immediately. Counting a zombie as "still running" would fail
 *  these assertions for a state that is precisely the thing they want. */
function pidAlive(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" }).trim();
    return out !== "" && !out.startsWith("Z");
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, opts: { timeoutMs: number; label: string }): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out (${opts.label})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!ffmpegAvailable || process.platform === "win32")(
  "transcode lifecycle integration (real ffmpeg, real Postgres, real process inspector)",
  () => {
    let db: ReturnType<typeof createDb>;
    let raw: pg.Client;
    let stagingRoot: string;
    let ctx: ViewerContext;
    let deviceId: string;
    let itemId: string;
    let fileId: string;
    let storedPlan: Record<string, unknown>;
    let ffmpegPath: string;

    const strayPids: number[] = [];

    beforeAll(async () => {
      execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
      const resolved = resolveFfmpeg();
      if (!resolved.ok) throw new Error("ffmpeg unresolvable after the availability gate said otherwise");
      ffmpegPath = resolved.binary.path;

      resetSchema();
      db = createDb(DATABASE_URL);
      raw = new pg.Client({ connectionString: DATABASE_URL });
      await raw.connect();

      const now = Date.now();
      const userRow = await raw.query<{ id: string }>(
        `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
         VALUES ('lifecycle-int-test', 'lifecycle-int@loombre.local', 'x', $1, $1) RETURNING id`,
        [now],
      );
      const userId = userRow.rows[0]!.id;

      // Same audio-only-transcode device profile session.integration.spec.ts
      // uses: video stream-copies, only a tiny 2ch audio encode runs, so the
      // CPU cost of holding a live ffmpeg open for a few seconds is trivial.
      const deviceProfile: DeviceProfile = {
        profileId: "lifecycle-test-device",
        directPlayContainers: ["mp4"],
        hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
        video: [{ codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null }],
        hdr: { hdr10: false, hlg: false, dolbyVision: false },
        audio: [{ codec: "opus", maxChannels: 2, passthrough: false }],
        subtitles: { renderText: [], hlsVtt: true, renderImage: false },
        maxStreamBitrateBps: null,
      };
      const deviceRow = await raw.query<{ id: string }>(
        `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'lifecycle-test-device', $2, $3) RETURNING id`,
        [userId, JSON.stringify(deviceProfile), now],
      );
      deviceId = deviceRow.rows[0]!.id;

      const libRow = await raw.query<{ id: string }>(
        `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
         VALUES ('Lifecycle Library', 'movie', '{}', $1, $1) RETURNING id`,
        [now],
      );
      const libraryId = libRow.rows[0]!.id;
      await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

      const itemRow = await raw.query<{ id: string }>(
        `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
         VALUES ($1, 'movie', 'Lifecycle Movie', 'lifecycle movie', $2, $2) RETURNING id`,
        [libraryId, now],
      );
      itemId = itemRow.rows[0]!.id;

      const sizeBytes = statSync(FIXTURE_PATH).size;
      const fileRow = await raw.query<{ id: string }>(
        `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
         VALUES ($1, $2, 'lifecycle-hash', $3, 'mp4', 150000, $4) RETURNING id`,
        [itemId, FIXTURE_PATH, sizeBytes, now],
      );
      fileId = fileRow.rows[0]!.id;
      await raw.query(
        `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, frame_rate, is_default, is_forced)
         VALUES ($1, 0, 'video', 'h264', 320, 240, 8, 25, true, false)`,
        [fileId],
      );
      await raw.query(
        `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, channels, sample_rate, is_default, is_forced)
         VALUES ($1, 1, 'audio', 'aac', 2, 48000, true, false)`,
        [fileId],
      );

      ctx = { userId, allowedLibraryIds: [libraryId], restrictedCleared: false };

      const media: MediaInfo = {
        fileId,
        container: "mp4",
        durationMs: 150_000,
        sizeBytes,
        overallBitrateBps: Math.round((sizeBytes * 8) / 150),
        video: [
          { index: 0, codec: "h264", profile: "high", level: null, width: 320, height: 240, bitDepth: 8, frameRate: 25, bitrateBps: null, hdr: "none", dvProfile: null, dvBlCompatId: null, interlaced: false, openGop: false },
        ],
        audio: [{ index: 1, codec: "aac", channels: 2, sampleRate: 48000, bitrateBps: null, language: null, isDefault: true, hasAtmos: false }],
        subtitle: [],
      };
      const selection: TrackSelection = { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null };
      const network: NetworkConditions = { maxBitrateBps: 100_000_000, isLocal: true };
      const policy: ServerPolicy = {
        allowTranscode: true,
        allowToneMapCpu: "tier-gated",
        tier: 0,
        preferredTextSubMode: "hls-vtt",
        preserveAssStyling: false,
        audioTranscodeCodecPriority: ["opus", "aac"],
        maxSimultaneousTranscodes: 10,
        ladderRungs: [],
        segmentDurationSec: 6,
        hevcEncodePreferred: false,
      };
      const caps: VerifiedCapabilities = { backends: [] };
      const input: PlanInput = { media, device: deviceProfile, network, policy, caps, selection, mode: "stream" };
      const planResult = plan(input);
      expect(planResult.decision).toBe("transcode");
      storedPlan = { ...planResult, selection };

      stagingRoot = mkdtempSync(join(tmpdir(), "loombre-lifecycle-"));
    }, 60_000 * TIME_SCALE);

    afterEach(async () => {
      await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE status NOT IN ('ended', 'failed')`, [Date.now()]);
      await terminateAllTranscodeRuns();
      for (const pid of strayPids.splice(0)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone — the normal case */
          }
        }
      }
    });

    afterAll(async () => {
      await db?.destroy();
      await raw?.end();
      rmSync(stagingRoot, { recursive: true, force: true });
    });

    async function createSession(): Promise<string> {
      const session = await createPlaybackSession(db, ctx, {
        itemId,
        fileId,
        deviceId,
        plan: storedPlan,
        engineVersion: "test",
        nowMs: Date.now(),
      });
      return session!.id;
    }

    /** A REAL, detached ffmpeg standing in for one orphaned by a crashed
     *  worker: long-running, and with `stagingDir` in its command line
     *  exactly as a real run's substituted output path would be. */
    function spawnStandInFfmpeg(stagingDir: string): number {
      const child = spawn(
        ffmpegPath,
        ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5", "-t", "600", "-f", "null", `${stagingDir}/orphan-marker`],
        { stdio: "ignore", detached: true },
      );
      child.unref();
      const pid = child.pid!;
      strayPids.push(pid);
      return pid;
    }

    // ---------------------------------------------------------------------
    // (a) graceful restart leaves no orphaned ffmpeg
    // ---------------------------------------------------------------------
    it(
      "(a) a graceful worker shutdown terminates the in-flight ffmpeg — no orphan survives",
      { timeout: 60_000 * TIME_SCALE },
      async () => {
        const sessionId = await createSession();
        let pid: number | undefined;
        const workerStartedAtMs = Date.now();
        const runPromise = runTranscodeSession(
          {
            db,
            stagingRoot,
            testReadrateMultiplier: 4,
            workerStartedAtMs,
            onRunSpawned: (spawned) => {
              pid = spawned;
              if (spawned !== undefined) strayPids.push(spawned);
            },
          },
          sessionId,
        );

        await waitFor(async () => {
          const { rows } = await raw.query<{ status: string; produced_segment: number | null }>(
            `SELECT status, produced_segment FROM playback_sessions WHERE id = $1`,
            [sessionId],
          );
          return rows[0]?.status === "active" && rows[0]?.produced_segment !== null;
        }, { timeoutMs: 30_000 * TIME_SCALE, label: "session active" });

        expect(pid).toBeDefined();
        expect(pidAlive(pid!), "the real ffmpeg must be running before shutdown").toBe(true);
        expect(activeTranscodeRunCount()).toBe(1);

        // C2's other half, proven here on the production path: the runner
        // persisted this pid + generation on the row while it ran.
        const { rows: pidRows } = await raw.query<{ worker_pid: number | null; worker_started_at_ms: number | null }>(
          `SELECT worker_pid, worker_started_at_ms FROM playback_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(pidRows[0]?.worker_pid).toBe(pid);
        expect(pidRows[0]?.worker_started_at_ms).toBe(workerStartedAtMs);

        // THE SHUTDOWN, exactly as apps/worker/src/index.ts's shutdown()
        // performs it.
        const terminated = await terminateAllTranscodeRuns();
        expect(terminated).toBe(1);
        expect(activeTranscodeRunCount()).toBe(0);

        // Independent OS-level verification, not this runtime's bookkeeping.
        expect(pidAlive(pid!), "ffmpeg must be gone once the shutdown path resolved").toBe(false);

        await endPlaybackSession(db, ctx, sessionId, Date.now());
        await runPromise;
      },
    );

    it(
      "(a2) a throttle-SUSPENDED run still dies promptly on shutdown (SIGCONT before SIGTERM)",
      { timeout: 60_000 * TIME_SCALE },
      async () => {
        const sessionId = await createSession();
        let pid: number | undefined;
        const runPromise = runTranscodeSession(
          {
            db,
            stagingRoot,
            testReadrateMultiplier: 12,
            onRunSpawned: (spawned) => {
              pid = spawned;
              if (spawned !== undefined) strayPids.push(spawned);
            },
          },
          sessionId,
        );

        // requested_segment stays NULL (treated as 0) so the throttle
        // suspends the process once it races ahead — a SIGSTOPped process
        // never runs a SIGTERM handler, which is exactly the case
        // terminate()'s SIGCONT-first ordering exists for.
        await waitFor(async () => {
          const { rows } = await raw.query<{ status: string; suspended_by_throttle: boolean }>(
            `SELECT status, suspended_by_throttle FROM playback_sessions WHERE id = $1`,
            [sessionId],
          );
          return rows[0]?.status === "suspended" && rows[0]?.suspended_by_throttle === true;
        }, { timeoutMs: 40_000 * TIME_SCALE, label: "throttle suspend" });

        expect(pid).toBeDefined();
        const startedAt = Date.now();
        await terminateAllTranscodeRuns();
        const elapsed = Date.now() - startedAt;

        expect(pidAlive(pid!)).toBe(false);
        // process.ts's graceful window is 2s before it escalates to
        // SIGKILL. A stopped process that never got SIGCONT would burn the
        // whole window; this asserts it did not.
        expect(elapsed, `stopped ffmpeg took ${elapsed}ms to die — SIGCONT-before-SIGTERM regression?`).toBeLessThan(1_800 * TIME_SCALE);

        await endPlaybackSession(db, ctx, sessionId, Date.now());
        await runPromise;
      },
    );

    // ---------------------------------------------------------------------
    // (b) boot reaper reclaims a simulated hard-kill orphan
    // ---------------------------------------------------------------------
    it(
      "(b) the boot reaper identifies and kills a real live orphan from a previous worker generation",
      { timeout: 60_000 * TIME_SCALE },
      async () => {
        const bootAtMs = Date.now();
        const previousGenerationMs = bootAtMs - 60_000;

        const sessionId = await createSession();
        const sessionDir = join(stagingRoot, sessionId);
        await markSessionStarting(db, sessionId, { stagingDir: sessionDir, nowMs: Date.now() });
        const orphanPid = spawnStandInFfmpeg(sessionDir);
        await recordSessionWorkerProcess(db, sessionId, { workerPid: orphanPid, workerStartedAtMs: previousGenerationMs, nowMs: Date.now() });

        // A second live process whose cmdline does NOT name this session's
        // staging dir — a reused pid, from the reaper's point of view. It
        // must survive.
        const unrelatedSessionId = await createSession();
        await markSessionStarting(db, unrelatedSessionId, { stagingDir: join(stagingRoot, unrelatedSessionId), nowMs: Date.now() });
        const unrelatedPid = spawnStandInFfmpeg(join(stagingRoot, "somewhere-else"));
        await recordSessionWorkerProcess(db, unrelatedSessionId, { workerPid: unrelatedPid, workerStartedAtMs: previousGenerationMs, nowMs: Date.now() });

        await waitFor(() => pidAlive(orphanPid) && pidAlive(unrelatedPid), { timeoutMs: 10_000 * TIME_SCALE, label: "stand-in processes up" });

        const reaped = await reapOrphanedTranscodeSessions({
          listReapable: async () => {
            const rows = await listReapableTranscodeSessions(db, { workerStartedBeforeMs: bootAtMs });
            return rows.map((row) => ({ id: row.id, workerPid: row.worker_pid, workerStartedAtMs: row.worker_started_at_ms, stagingDir: row.staging_dir }));
          },
          failSession: async (id, stderrTail) => {
            await markSessionFailed(db, id, { errorCode: "transcode-failed", stderrTail, nowMs: Date.now() });
          },
          // The REAL platform inspector — /proc on Linux, `ps` on darwin.
          inspector: createProcessInspector({ platform: process.platform }),
          workerStartedAtMs: bootAtMs,
        });

        const byId = new Map(reaped.map((r) => [r.sessionId, r]));
        expect(byId.get(sessionId)?.outcome).toBe("killed");
        expect(byId.get(unrelatedSessionId)?.outcome).toBe("pid-reused");

        await waitFor(() => !pidAlive(orphanPid), { timeoutMs: 10_000 * TIME_SCALE, label: "orphan killed" });
        expect(pidAlive(unrelatedPid), "a process that is not this session's ffmpeg must NEVER be killed").toBe(true);

        const { rows } = await raw.query<{ status: string; error_code: string | null; stderr_tail: string | null }>(
          `SELECT status, error_code, stderr_tail FROM playback_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(rows[0]?.status).toBe("failed");
        expect(rows[0]?.stderr_tail).toMatch(/interrupted/i);
      },
    );

    // ---------------------------------------------------------------------
    // (c) admission cap holds across a restart cycle
    // ---------------------------------------------------------------------
    it(
      "(c) no admission slot is freed while its process is still running, across a restart cycle",
      { timeout: 60_000 * TIME_SCALE },
      async () => {
        const bootAtMs = Date.now();
        const sessionId = await createSession();
        const sessionDir = join(stagingRoot, sessionId);
        await markSessionStarting(db, sessionId, { stagingDir: sessionDir, nowMs: Date.now() });
        const orphanPid = spawnStandInFfmpeg(sessionDir);
        await recordSessionWorkerProcess(db, sessionId, { workerPid: orphanPid, workerStartedAtMs: bootAtMs - 60_000, nowMs: Date.now() });
        await waitFor(() => pidAlive(orphanPid), { timeoutMs: 10_000 * TIME_SCALE, label: "orphan up" });

        // Before the restart: the slot is HELD and the process is alive.
        expect(await countActiveTranscodeSessions(db)).toBe(1);

        // THE INVARIANT, asserted from inside the transition itself: the
        // session may only become terminal — which is the exact moment
        // countActiveTranscodeSessions stops counting it, i.e. the slot is
        // handed to the next viewer — once the process is already dead.
        // This is the defect's whole shape: a freed slot on top of a
        // process still burning a core.
        let processAliveWhenSlotFreed: boolean | undefined;
        await reapOrphanedTranscodeSessions({
          listReapable: async () => {
            const rows = await listReapableTranscodeSessions(db, { workerStartedBeforeMs: bootAtMs });
            return rows.map((row) => ({ id: row.id, workerPid: row.worker_pid, workerStartedAtMs: row.worker_started_at_ms, stagingDir: row.staging_dir }));
          },
          failSession: async (id, stderrTail) => {
            processAliveWhenSlotFreed = pidAlive(orphanPid);
            await markSessionFailed(db, id, { errorCode: "transcode-failed", stderrTail, nowMs: Date.now() });
          },
          inspector: createProcessInspector({ platform: process.platform }),
          workerStartedAtMs: bootAtMs,
        });

        expect(processAliveWhenSlotFreed, "the slot must not be released before the process is dead").toBe(false);
        expect(await countActiveTranscodeSessions(db)).toBe(0);
        expect(pidAlive(orphanPid)).toBe(false);
      },
    );
  },
);
