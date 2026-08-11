// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/seek-dedup.integration.spec.ts
//
// Process-lifecycle hardening wave (2026-08-11, Lane A1), continuation
// item 1: THE SEEK-RESTART LIVELOCK.
//
// The shape of the bug, end to end. A client asks for a segment index the
// pipeline has not produced yet. The server answers 503-retry-after AND
// records a seek target for it. The client retries — that is what
// retry-after means — so the server records the seek target AGAIN. Nothing
// on the server side is wrong about that: each request really is for a
// segment that is not there yet.
//
// The defect is on THIS side. runner.ts consumed every recorded target
// unconditionally: kill the in-flight ffmpeg, spawn a fresh one at the same
// position, and do it again on the next poll tick, because the retry that
// arrived in the meantime recorded the same target once more. The run never
// survives long enough to produce its first segment, so the client never
// stops retrying, so the runner never stops restarting. It is a livelock:
// both sides are making progress by their own lights and the session
// produces nothing at all, burning exactly the Tier-0 CPU the admission cap
// exists to protect (spawn + input-open + first-keyframe decode is the most
// expensive part of a run, and this repeats it forever).
//
// Real ffmpeg is deliberately NOT used here: the assertion is about how
// many times a process is spawned and how the DB control channel is
// consumed, so an injected fake child process makes the storm timing
// deterministic and lets this suite run on a machine without ffmpeg. The
// real-process half of the lifecycle is covered by
// lifecycle.integration.spec.ts.

import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createPlaybackSession, endPlaybackSession, ensureTestDatabase, requestSeek, resolveTestDatabaseUrl } from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import { plan, type DeviceProfile, type MediaInfo, type NetworkConditions, type PlanInput, type ServerPolicy, type TrackSelection, type VerifiedCapabilities } from "@loombre/playback-engine";
import { runTranscodeSession } from "../../src/transcode/runner.js";
import { terminateAllTranscodeRuns } from "../../src/transcode/run-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DB_PKG_ROOT = join(REPO_ROOT, "packages", "db");
// An ISOLATED per-suite database (packages/db/src/testing.ts's
// ensureTestDatabase), not the shared `<base>_test`: this suite asserts
// spawn counts over several seconds of storm, and a sibling suite's
// `reset` landing mid-run would wipe the schema out from under it and
// present as a product bug. migrate.mjs's advisory lock serializes
// reset-against-reset; only a database of its own removes
// reset-against-a-running-suite.
let DATABASE_URL: string;
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

// ---------------------------------------------------------------------------
// Fake child process (process.spec.ts's convention, extended with a pid so
// terminate()'s real signal path is exercised).
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  closed = false;
  constructor(readonly pid: number) {
    super();
  }
  emitClose(signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", null, signal);
  }
}

/** Fake pids live in a range no real process can occupy here, and the
 *  process.kill spy below refuses anything outside it — so this suite can
 *  never signal a real process even if the runner miscomputes a pid. */
const FAKE_PID_BASE = 990_001;

describe("seek-restart de-duplication (continuation item 1: livelock)", () => {
  let db: ReturnType<typeof createDb>;
  let raw: pg.Client;
  let stagingRoot: string;
  let ctx: ViewerContext;
  let deviceId: string;
  let itemId: string;
  let fileId: string;
  let storedPlan: Record<string, unknown>;

  let children: FakeChild[] = [];
  let killSpy: ReturnType<typeof vi.spyOn> | undefined;

  function installFakeProcessTable(): void {
    const byPid = new Map<number, FakeChild>();
    children = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.kill's overloads do not narrow through a spy
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      const child = byPid.get(Math.abs(Number(pid)));
      if (!child) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err; // killProcessGroup catches this, exactly as for a dead pid
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        // A real ffmpeg exits shortly after SIGTERM; the fake does the same
        // on the next macrotask so terminate() resolves instead of burning
        // its whole graceful window.
        setTimeout(() => child.emitClose(signal), 0);
      }
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    (globalThis as unknown as { __fakeChildren: Map<number, FakeChild> }).__fakeChildren = byPid;
  }

  function fakeSpawnFn(): typeof import("node:child_process").spawn {
    return ((): unknown => {
      const pid = FAKE_PID_BASE + children.length;
      const child = new FakeChild(pid);
      children.push(child);
      (globalThis as unknown as { __fakeChildren: Map<number, FakeChild> }).__fakeChildren.set(pid, child);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
  }

  beforeAll(async () => {
    DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), "worker_seek_dedup_test");
    resetSchema();
    db = createDb(DATABASE_URL);
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();

    const now = Date.now();
    const userRow = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
       VALUES ('seek-dedup-test', 'seek-dedup@loombre.local', 'x', $1, $1) RETURNING id`,
      [now],
    );
    const userId = userRow.rows[0]!.id;

    const deviceProfile: DeviceProfile = {
      profileId: "seek-dedup-device",
      directPlayContainers: ["mp4"],
      hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
      video: [{ codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null }],
      hdr: { hdr10: false, hlg: false, dolbyVision: false },
      audio: [{ codec: "opus", maxChannels: 2, passthrough: false }],
      subtitles: { renderText: [], hlsVtt: true, renderImage: false },
      maxStreamBitrateBps: null,
    };
    const deviceRow = await raw.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'seek-dedup-device', $2, $3) RETURNING id`,
      [userId, JSON.stringify(deviceProfile), now],
    );
    deviceId = deviceRow.rows[0]!.id;

    const libRow = await raw.query<{ id: string }>(
      `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
       VALUES ('Seek Dedup Library', 'movie', '{}', $1, $1) RETURNING id`,
      [now],
    );
    const libraryId = libRow.rows[0]!.id;
    await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

    const itemRow = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', 'Seek Dedup Movie', 'seek dedup movie', $2, $2) RETURNING id`,
      [libraryId, now],
    );
    itemId = itemRow.rows[0]!.id;

    // A real path is never opened (the spawn is faked) but the row must be
    // complete enough for rebuildSeekArgs to re-assemble MediaInfo.
    const fakeMediaPath = join(REPO_ROOT, "test-fixtures", "media", "session_long.mp4");
    let sizeBytes = 1_000_000;
    try {
      sizeBytes = statSync(fakeMediaPath).size;
    } catch {
      /* fixture not generated on this machine — the size is not load-bearing */
    }
    const fileRow = await raw.query<{ id: string }>(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
       VALUES ($1, $2, 'seek-dedup-hash', $3, 'mp4', 150000, $4) RETURNING id`,
      [itemId, fakeMediaPath, sizeBytes, now],
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
      overallBitrateBps: 800_000,
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

    stagingRoot = mkdtempSync(join(tmpdir(), "loombre-seek-dedup-"));
  }, 60_000 * TIME_SCALE);

  afterEach(async () => {
    await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE status NOT IN ('ended', 'failed')`, [Date.now()]);
    await terminateAllTranscodeRuns();
    killSpy?.mockRestore();
    killSpy = undefined;
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

  async function waitForSpawnCount(n: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (children.length < n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} spawn(s); saw ${children.length}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async function readRow(sessionId: string): Promise<{ status: string; discontinuity_count: number; seek_target_ms: number | null }> {
    const { rows } = await raw.query<{ status: string; discontinuity_count: number; seek_target_ms: number | null }>(
      `SELECT status, discontinuity_count, seek_target_ms FROM playback_sessions WHERE id = $1`,
      [sessionId],
    );
    return rows[0]!;
  }

  it(
    "a retry storm on ONE target restarts the pipeline exactly once",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 25, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE); // run 0

      // THE STORM: the same seek target recorded over and over, exactly as a
      // client retrying a 503-retry-after for one too-far-ahead segment
      // makes the server do.
      const target = 60_000;
      for (let i = 0; i < 25; i += 1) {
        await requestSeek(db, ctx, sessionId, target, Date.now());
        await new Promise((r) => setTimeout(r, 20));
      }
      // Let several more poll ticks run with nothing new arriving.
      await new Promise((r) => setTimeout(r, 300 * TIME_SCALE));

      // ONE restart for the whole storm: run 0 + run 1, nothing more.
      expect(children.length, `spawned ${children.length} runs for one seek target`).toBe(2);

      const row = await readRow(sessionId);
      expect(row.discontinuity_count, "one real restart means one discontinuity").toBe(1);
      // The absorbed requests are cleared, never left pending to re-fire.
      expect(row.seek_target_ms).toBeNull();

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  it(
    "a genuinely different target still restarts the pipeline",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 25, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);

      await requestSeek(db, ctx, sessionId, 60_000, Date.now());
      await waitForSpawnCount(2, 10_000 * TIME_SCALE);

      // Same target again — absorbed.
      await requestSeek(db, ctx, sessionId, 60_000, Date.now());
      await new Promise((r) => setTimeout(r, 300 * TIME_SCALE));
      expect(children.length).toBe(2);

      // A different target — a real seek, must restart.
      await requestSeek(db, ctx, sessionId, 90_000, Date.now());
      await waitForSpawnCount(3, 10_000 * TIME_SCALE);
      expect(children.length).toBe(3);

      // And a backward seek is different too.
      await requestSeek(db, ctx, sessionId, 10_000, Date.now());
      await waitForSpawnCount(4, 10_000 * TIME_SCALE);

      const row = await readRow(sessionId);
      expect(row.discontinuity_count).toBe(3);

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  it(
    "a repeat of run 0's implicit origin (0 ms) never restarts anything",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 25, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);

      // run 0 already starts at source time 0 — asking to seek there is a
      // no-op the pipeline is already satisfying.
      for (let i = 0; i < 5; i += 1) {
        await requestSeek(db, ctx, sessionId, 0, Date.now());
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 300 * TIME_SCALE));

      expect(children.length).toBe(1);
      const row = await readRow(sessionId);
      expect(row.discontinuity_count).toBe(0);
      expect(row.seek_target_ms).toBeNull();

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  it(
    "THE SLOT-HANDOFF ORDERING PIN (§9.1.4 steps 2-3): a restart never spawns until the old run's exit is OBSERVED",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      // Deterministic companion to seek-rung-switch.integration.spec.ts's
      // process census (C2 review). The census samples the real OS process
      // table at ~25 ms and asserts <= 1 live ffmpeg — genuine, but
      // SAMPLING: an overlap shorter than its interval is merely
      // unobserved, not impossible. The reason no overlap can exist is the
      // runner's SEQUENCING — `restartAt` spawns strictly after `await
      // terminate()`, which resolves only on the child's observed 'close'
      // (process.spec.ts pins that half) — and this test pins the
      // sequencing itself: hold the old child's 'close' event hostage and
      // prove NO second spawn happens for as long as it is withheld,
      // however long that is. A mutation that moves the spawn ahead of the
      // exit-wait fails here deterministically, not one census coin flip
      // in twenty.
      const byPid = new Map<number, FakeChild>();
      children = [];
      let holdingClose = true;
      const withheldCloses: Array<() => void> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.kill's overloads do not narrow through a spy
      killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
        const child = byPid.get(Math.abs(Number(pid)));
        if (!child) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          const fire = (): void => child.emitClose(signal);
          if (holdingClose) withheldCloses.push(fire);
          else setTimeout(fire, 0);
        }
        return true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);
      (globalThis as unknown as { __fakeChildren: Map<number, FakeChild> }).__fakeChildren = byPid;

      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 25, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      try {
        await waitForSpawnCount(1, 10_000 * TIME_SCALE);

        // A genuine seek — the runner terminates run 0 and must spawn run 1.
        await requestSeek(db, ctx, sessionId, 60_000, Date.now());

        // The old child's SIGTERM (and the 2 s SIGKILL escalation) are both
        // swallowed while `holdingClose` — the process is, as far as the
        // runner can observe, still alive. Many poll intervals pass; the
        // ordering under test is what makes every one of them spawn-free.
        await new Promise((r) => setTimeout(r, 2_500 * TIME_SCALE));
        expect(
          children.length,
          "spawned a replacement run while the old process was still alive — the §9.1.4 observed-exit ordering is broken",
        ).toBe(1);
        expect(children[0]!.closed).toBe(false);

        // Release the exit. Only NOW may the replacement spawn.
        holdingClose = false;
        for (const fire of withheldCloses.splice(0)) fire();
        await waitForSpawnCount(2, 10_000 * TIME_SCALE);
        expect(children[0]!.closed).toBe(true);
      } finally {
        // Never leave a close withheld: afterEach's terminateAllTranscodeRuns
        // awaits observed exits and would hang on one.
        holdingClose = false;
        for (const fire of withheldCloses.splice(0)) fire();
      }

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );
});
