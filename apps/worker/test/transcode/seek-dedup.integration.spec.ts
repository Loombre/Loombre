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
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createPlaybackSession, endPlaybackSession, ensureTestDatabase, requestRungSwitch, requestSeek, resolveTestDatabaseUrl } from "@loombre/db";
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
  let ladderDeviceId: string;
  let itemId: string;
  let fileId: string;
  let storedPlan: Record<string, unknown>;
  /** The same session, planned against a THREE-RUNG ladder — the only
   *  shape in which a rung switch (and therefore §9.1.7's absorption
   *  conjunct) means anything at all. Built alongside `storedPlan` so the
   *  ladder-empty tests above keep the plan they were written against. */
  let storedLadderPlan: Record<string, unknown>;

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

    // A SECOND device whose only difference is a 20 fps ceiling against
    // this 25 fps source — enough to force `video.action = 'transcode'`,
    // which is the precondition for a ladder existing at all (the primary
    // device above direct-streams the video and therefore plans an EMPTY
    // ladder, which is exactly right for the de-dup tests and useless for
    // a rung switch). `rebuildSeekArgs` re-reads the device by id on every
    // restart, so the laddered session needs a real row of its own.
    const ladderDeviceProfile: DeviceProfile = {
      ...deviceProfile,
      profileId: "seek-dedup-ladder-device",
      video: [{ codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 20, maxBitrateBps: null }],
    };
    const ladderDeviceRow = await raw.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'seek-dedup-ladder-device', $2, $3) RETURNING id`,
      [userId, JSON.stringify(ladderDeviceProfile), now],
    );
    ladderDeviceId = ladderDeviceRow.rows[0]!.id;

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

    ctx = { userId, allowedLibraryIds: [libraryId], restrictedCleared: false, surface: "restricted" };

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
      segmentDurationSec: 2,
      hevcEncodePreferred: false,
    };
    const caps: VerifiedCapabilities = { backends: [] };
    const input: PlanInput = { media, device: deviceProfile, network, policy, caps, selection, mode: "stream" };
    const planResult = plan(input);
    expect(planResult.decision).toBe("transcode");
    storedPlan = { ...planResult, selection };

    const ladderPolicy: ServerPolicy = {
      ...policy,
      ladderRungs: [
        { heightPx: 240, videoBitrateBps: 600_000, audioBitrateBps: 128_000, codec: "h264" },
        { heightPx: 180, videoBitrateBps: 300_000, audioBitrateBps: 128_000, codec: "h264" },
        { heightPx: 120, videoBitrateBps: 150_000, audioBitrateBps: 128_000, codec: "h264" },
      ],
    };
    const ladderPlanResult = plan({ ...input, device: ladderDeviceProfile, policy: ladderPolicy });
    expect(ladderPlanResult.decision).toBe("transcode");
    expect(ladderPlanResult.video.action).toBe("transcode");
    expect(ladderPlanResult.ladder).toHaveLength(3);
    storedLadderPlan = { ...ladderPlanResult, selection };

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

  async function createSession(sessionPlan: Record<string, unknown> = storedPlan, sessionDeviceId: string = deviceId): Promise<string> {
    const session = await createPlaybackSession(db, ctx, {
      itemId,
      fileId,
      deviceId: sessionDeviceId,
      plan: sessionPlan,
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

  // -------------------------------------------------------------------------
  // ABSORPTION-WINDOW SUPPORT (pre-D consolidation item 1, C2 review f3).
  //
  // The absorption rule's INTERESTING half needs a run that has already
  // PRODUCED something: `[origin, origin + producedMs]`. `producedMs` is
  // summed from ffmpeg's OWN per-run playlist, and a faked child process
  // writes no such file — which is exactly why nothing in this suite (or
  // any other) had ever exercised a seek strictly INSIDE the live window,
  // only the exact-origin floor. So the playlist is FABRICATED here: it is
  // a plain text file with a documented format that the runtime reads with
  // `readFile` and parses with `parseFfmpegPlaylist`, and writing it by
  // hand makes `producedMs` — and, at 21 segments, retention's first prune
  // of this run's own head — deterministic instead of dependent on real
  // encoder timing.
  // -------------------------------------------------------------------------

  /** Writes a run's own append-only playlist the way ffmpeg would, with
   *  `segmentCount` six-second segments numbered from `firstSegmentIndex`.
   *  ATOMIC (temp + rename) because the poll loop may read it at any
   *  instant — the runtime's own served-playlist writes take the same care
   *  for the same reason. */
  function fabricateRunPlaylist(sessionId: string, runIndex: number, segmentCount: number, firstSegmentIndex = 0): void {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:6", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT", '#EXT-X-MAP:URI="init.mp4"'];
    for (let i = 0; i < segmentCount; i += 1) {
      lines.push("#EXTINF:6.000000,");
      lines.push(`s${String(firstSegmentIndex + i).padStart(6, "0")}.m4s`);
    }
    // No #EXT-X-ENDLIST: this run is still live, which is the only state in
    // which absorption is even considered.
    const runDir = join(stagingRoot, sessionId, `run${runIndex}`);
    const target = join(runDir, "media.m3u8");
    const tmp = `${target}.fabricate.tmp`;
    writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
    renameSync(tmp, target);
  }

  /** Blocks until the runtime has FOLDED the fabricated playlist — the
   *  `produced_segment` column is the observable that says so, and (since
   *  the fold, the prune and the head-pruned flag all happen on one tick)
   *  it also says the retention decision for that playlist has been made. */
  async function waitForProducedSegment(sessionId: string, expected: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await raw.query<{ produced_segment: number | null }>(`SELECT produced_segment FROM playback_sessions WHERE id = $1`, [sessionId]);
      if (rows[0]?.produced_segment === expected) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for produced_segment=${expected}; saw ${String(rows[0]?.produced_segment)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Blocks until the runtime has RECORDED the rung a spawn is encoding.
   *  `waitForSpawnCount` returns the instant `spawnFn` is called, and
   *  `recordActiveRungIndex` is awaited AFTER that inside `spawnRun` — so
   *  reading the column straight after a spawn count is a genuine race
   *  (observed failing ~1 run in 3 as a bare assertion). */
  async function waitForActiveRung(sessionId: string, expected: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await raw.query<{ active_rung_index: number | null }>(`SELECT active_rung_index FROM playback_sessions WHERE id = $1`, [sessionId]);
      if (rows[0]?.active_rung_index === expected) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for active_rung_index=${expected}; saw ${String(rows[0]?.active_rung_index)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async function readRungRow(sessionId: string): Promise<{ active_rung_index: number | null; pending_rung_index: number | null }> {
    const { rows } = await raw.query<{ active_rung_index: number | null; pending_rung_index: number | null }>(
      `SELECT active_rung_index, pending_rung_index FROM playback_sessions WHERE id = $1`,
      [sessionId],
    );
    return rows[0]!;
  }

  /** Blocks until `expected` runs have been RECORDED. Same race as
   *  waitForActiveRung: `recordTranscodeRun` is awaited after the spawn, so
   *  a spawn count is not yet a durable run row. (A ladder-empty session
   *  never calls recordActiveRungIndex at all, so waiting on the rung is
   *  not an option there — this is the general form.) */
  async function waitForRunCount(sessionId: string, expected: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await raw.query<{ n: string }>(`SELECT count(*)::text AS n FROM transcode_runs WHERE session_id = $1`, [sessionId]);
      if (Number(rows[0]?.n ?? 0) >= expected) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expected} recorded run(s); saw ${String(rows[0]?.n)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async function readRuns(sessionId: string): Promise<{ run_index: number; source_origin_ms: number; ladder_rung_index: number | null }[]> {
    const { rows } = await raw.query<{ run_index: number; source_origin_ms: string | number; ladder_rung_index: number | null }>(
      `SELECT run_index, source_origin_ms, ladder_rung_index FROM transcode_runs WHERE session_id = $1 ORDER BY run_index`,
      [sessionId],
    );
    return rows.map((r) => ({ run_index: r.run_index, source_origin_ms: Number(r.source_origin_ms), ladder_rung_index: r.ladder_rung_index }));
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

  // ===========================================================================
  // ABSORPTION NARROWING (pre-D consolidation item 1 — C2 review finding f3).
  //
  // The absorption rule has TWO conjuncts beyond "the target is in the live
  // run's window", and until this block neither was pinned by anything:
  //
  //   (a) docs/PLAYBACK.md §9 — absorb only while NOTHING of this run has
  //       been pruned. Past that the window's lower end is no longer on
  //       disk, so a target there is a real backward seek into bytes that
  //       do not exist and must restart.
  //   (b) docs/PLAYBACK.md §9.1.7 — absorb only when no switch to a
  //       DIFFERENT rung is pending. The shortcut is sound because "we are
  //       already serving that position"; under a pending switch the client
  //       is asking for different BYTES at that position, not the same ones.
  //
  // Both were invisible to mutation because every pre-existing absorption
  // test lands on the exact ORIGIN (0 ms, or the position the run was just
  // restarted at), where `target >= origin && target <= origin` decides the
  // outcome and the window's upper end never participates. These three
  // tests all seek to 12 000 ms — strictly INSIDE a fabricated 24 s/126 s
  // produced window, never equal to the origin — so the window arithmetic
  // and both conjuncts are the only things that can decide them.
  // ===========================================================================

  it(
    "ABSORBS a seek strictly INSIDE the live run's produced window while its head is unpruned (§9)",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        {
          db,
          stagingRoot,
          pollIntervalMs: 25,
          ffmpegPath: "/nonexistent/ffmpeg-never-executed",
          spawnFn: fakeSpawnFn(),
          // The throttle is not under test here and a 21-segment fabricated
          // playlist would trip its suspend threshold; hold it out of the
          // way so the only thing deciding these tests is the seek block.
          suspendAheadThresholdOverride: 10_000,
          resumeAheadThresholdOverride: 5_000,
        },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);

      // 4 x 6 s = a produced window of [0, 24 000] ms, comfortably inside
      // the 120 s retention horizon, so nothing of run 0 is ever pruned.
      fabricateRunPlaylist(sessionId, 0, 4);
      await waitForProducedSegment(sessionId, 3, 10_000 * TIME_SCALE);

      // 12 000 ms: past the origin, well short of the live edge — output
      // this run has ALREADY written. Restarting would rebuild bytes that
      // exist.
      await requestSeek(db, ctx, sessionId, 12_000, Date.now());
      await new Promise((r) => setTimeout(r, 500 * TIME_SCALE));

      expect(children.length, "restarted for a position the live run had already produced").toBe(1);
      const row = await readRow(sessionId);
      expect(row.discontinuity_count, "an absorbed seek produces no discontinuity").toBe(0);
      expect(row.seek_target_ms, "an absorbed target is cleared, never left to re-fire").toBeNull();
      expect(row.status, "absorption never moves the session to 'seeking'").toBe("active");

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  it(
    "RESTARTS for the very same in-window seek once retention has pruned the run's head (§9)",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        {
          db,
          stagingRoot,
          pollIntervalMs: 25,
          ffmpegPath: "/nonexistent/ffmpeg-never-executed",
          spawnFn: fakeSpawnFn(),
          suspendAheadThresholdOverride: 10_000,
          resumeAheadThresholdOverride: 5_000,
        },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);

      // d3-f1: retention is floored by VIEWER EVIDENCE, so a head only ages
      // out once the viewer has moved past it. This test's premise is
      // exactly that state — the client has played through to the live edge
      // — so it is recorded explicitly rather than assumed. d4-f2: the
      // evidence is `highest_served_segment` (apps/server writes it when a
      // segment GET is answered 200); `requested_segment` moves alongside
      // it exactly as a real served GET makes it.
      await raw.query(
        `UPDATE playback_sessions SET requested_segment = 20, highest_served_segment = 20, updated_at_ms = $2 WHERE id = $1`,
        [sessionId, Date.now()],
      );

      // 21 x 6 s = 126 s produced, which is 6 s PAST the 120 s retention
      // horizon: the prune drops s000000 (and only it), so run 0's window
      // no longer starts at its origin — its head is gone from disk.
      fabricateRunPlaylist(sessionId, 0, 21);
      await waitForProducedSegment(sessionId, 20, 15_000 * TIME_SCALE);

      // The SAME 12 000 ms as the absorbing test above, and still inside
      // [origin, origin + producedMs] = [0, 126 000]. The only thing that
      // differs is that the head has been pruned — so this is a real
      // backward seek into bytes that are no longer there.
      await requestSeek(db, ctx, sessionId, 12_000, Date.now());
      await waitForSpawnCount(2, 10_000 * TIME_SCALE);
      await waitForRunCount(sessionId, 2, 10_000 * TIME_SCALE);

      const row = await readRow(sessionId);
      expect(row.discontinuity_count, "a real restart produces exactly one discontinuity").toBe(1);
      const runs = await readRuns(sessionId);
      expect(runs.map((r) => [r.run_index, r.source_origin_ms])).toEqual([
        [0, 0],
        [1, 12_000],
      ]);

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  // ===========================================================================
  // d3-f5 (QA 2026-08-24, P2 — verify-A): A SEEK DURING AN ABR RUNG FLAP.
  //
  // hls.js re-evaluates its level the moment a seek empties the buffer, and
  // on a marginal link it FLAPS: one POST /seek was observed spawning
  // transcode_runs 7 (rung 1) and 8 (rung 0) 0.9 s apart, with the whole
  // session reaching 23 runs — 2-3 full ffmpeg restarts per seek, each one
  // killing the run before it could produce, while the client re-requested
  // the abandoned old run's segments (9x 503) and finally showed a false
  // "Seek timed out" toast at +20 s.
  //
  // The server half of the fix (the client half is A-core d3-a1): a
  // rung-driven restart is DEFERRED for a short cool-down after a seek
  // restart. The deferral is what makes the flap fold — `requestRungSwitch`
  // absorbs a switch naming the ACTIVE rung, and while nothing restarts the
  // active rung does not move, so 1 -> 0 -> 1 collapses into the single
  // pending value the cool-down eventually consumes. Nothing is dropped: a
  // switch that outlives the window still restarts, and a real seek landing
  // inside the window still folds the pending rung into its own single
  // restart (§9.1.7).
  // ===========================================================================

  it(
    "d3-f5: an ABR flap right after a seek restart costs ONE deferred restart, not one per flap",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession(storedLadderPlan, ladderDeviceId);
      const runPromise = runTranscodeSession(
        {
          db,
          stagingRoot,
          pollIntervalMs: 25,
          ffmpegPath: "/nonexistent/ffmpeg-never-executed",
          spawnFn: fakeSpawnFn(),
          suspendAheadThresholdOverride: 10_000,
          resumeAheadThresholdOverride: 5_000,
          // The real cool-down is seconds (config.ts); a shorter one keeps
          // this test quick without changing what it proves. MUST scale with
          // TIME_SCALE: the flap sequence below sleeps 2 × 150 × TIME_SCALE
          // inside this window, so an unscaled 1500ms is eaten by the sleeps
          // alone at scale 10 (macOS CI) and by sleeps + runner overhead at
          // scale 3 (ubuntu CI) — the third switch then lands OUTSIDE the
          // window and legitimately restarts, failing the "expected 2" pin.
          // Deterministic red on ubuntu CI 2026-08-28 (runs 33140861189 ×2)
          // until scaled; reproduced locally at scale 10.
          rungSwitchCooldownMsOverride: 1_500 * TIME_SCALE,
        },
        sessionId,
      );

      try {
        await waitForSpawnCount(1, 10_000 * TIME_SCALE);
        await waitForActiveRung(sessionId, 0, 10_000 * TIME_SCALE);
        fabricateRunPlaylist(sessionId, 0, 4);
        await waitForProducedSegment(sessionId, 3, 10_000 * TIME_SCALE);

        // The user drags the scrubber: a genuine seek, well outside the live
        // run's [0, 24 000] window, so it really restarts.
        await requestSeek(db, ctx, sessionId, 60_000, Date.now());
        await waitForSpawnCount(2, 10_000 * TIME_SCALE);
        await waitForRunCount(sessionId, 2, 10_000 * TIME_SCALE);

        // ...and hls.js's ABR flaps while the buffer refills.
        await requestRungSwitch(db, ctx, sessionId, 1, Date.now());
        await new Promise((r) => setTimeout(r, 150 * TIME_SCALE));
        await requestRungSwitch(db, ctx, sessionId, 0, Date.now());
        await new Promise((r) => setTimeout(r, 150 * TIME_SCALE));
        await requestRungSwitch(db, ctx, sessionId, 1, Date.now());

        // THE PIN: inside the cool-down the flap has cost NOTHING. Before
        // d3-f5 each of those three writes killed the in-flight run and
        // spawned another ~one tick later.
        await new Promise((r) => setTimeout(r, 400 * TIME_SCALE));
        expect(children.length, "a rung flap inside the cool-down must not restart anything").toBe(2);

        // Deferred, never dropped: once the window closes the surviving
        // pending rung is consumed by ONE restart.
        await waitForSpawnCount(3, 10_000 * TIME_SCALE);
        await waitForActiveRung(sessionId, 1, 10_000 * TIME_SCALE);
        await new Promise((r) => setTimeout(r, 400 * TIME_SCALE));
        expect(children.length, "three flaps, ONE restart").toBe(3);

        const runs = await readRuns(sessionId);
        expect(runs).toEqual([
          { run_index: 0, source_origin_ms: 0, ladder_rung_index: 0 },
          { run_index: 1, source_origin_ms: 60_000, ladder_rung_index: 0 },
          // A pure switch continues the timeline: run 1 produced nothing
          // (its playlist is never fabricated), so the handoff origin is its
          // own origin.
          { run_index: 2, source_origin_ms: 60_000, ladder_rung_index: 1 },
        ]);
        expect((await readRungRow(sessionId)).pending_rung_index).toBeNull();

        await endPlaybackSession(db, ctx, sessionId, Date.now());
        await runPromise;
      } finally {
        await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE id = $2 AND status NOT IN ('ended','failed')`, [
          Date.now(),
          sessionId,
        ]);
        await runPromise.catch(() => undefined);
      }
    },
  );

  it(
    "d3-f5: a further seek inside the cool-down FOLDS the deferred rung into its own single restart (§9.1.7)",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession(storedLadderPlan, ladderDeviceId);
      const runPromise = runTranscodeSession(
        {
          db,
          stagingRoot,
          pollIntervalMs: 25,
          ffmpegPath: "/nonexistent/ffmpeg-never-executed",
          spawnFn: fakeSpawnFn(),
          suspendAheadThresholdOverride: 10_000,
          resumeAheadThresholdOverride: 5_000,
          // Scaled for the same reason as the flap case above — this
          // sequence's scaled waits must stay inside the window.
          rungSwitchCooldownMsOverride: 1_500 * TIME_SCALE,
        },
        sessionId,
      );

      try {
        await waitForSpawnCount(1, 10_000 * TIME_SCALE);
        await waitForActiveRung(sessionId, 0, 10_000 * TIME_SCALE);
        fabricateRunPlaylist(sessionId, 0, 4);
        await waitForProducedSegment(sessionId, 3, 10_000 * TIME_SCALE);

        await requestSeek(db, ctx, sessionId, 60_000, Date.now());
        await waitForSpawnCount(2, 10_000 * TIME_SCALE);
        await requestRungSwitch(db, ctx, sessionId, 2, Date.now());

        // A second drag while the first switch is still deferred. The seek
        // restart is happening anyway, so it carries the pending rung —
        // deferring must never turn into "the client waits twice".
        await new Promise((r) => setTimeout(r, 150 * TIME_SCALE));
        await requestSeek(db, ctx, sessionId, 90_000, Date.now());
        await waitForSpawnCount(3, 10_000 * TIME_SCALE);
        await waitForActiveRung(sessionId, 2, 10_000 * TIME_SCALE);

        // Past the cool-down: nothing left to fire — the rung was consumed
        // by the seek restart, not merely postponed behind it.
        await new Promise((r) => setTimeout(r, 2_000 * TIME_SCALE));
        expect(children.length, "one seek + one deferred switch is ONE restart").toBe(3);

        const runs = await readRuns(sessionId);
        expect(runs[2]).toEqual({ run_index: 2, source_origin_ms: 90_000, ladder_rung_index: 2 });
        expect((await readRungRow(sessionId)).pending_rung_index).toBeNull();

        await endPlaybackSession(db, ctx, sessionId, Date.now());
        await runPromise;
      } finally {
        await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE id = $2 AND status NOT IN ('ended','failed')`, [
          Date.now(),
          sessionId,
        ]);
        await runPromise.catch(() => undefined);
      }
    },
  );

  it(
    "RESTARTS an in-window seek when a switch to a DIFFERENT rung is pending, spawning ONE run at (requested rung, requested origin) (§9.1.7)",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession(storedLadderPlan, ladderDeviceId);
      const runPromise = runTranscodeSession(
        {
          db,
          stagingRoot,
          pollIntervalMs: 25,
          ffmpegPath: "/nonexistent/ffmpeg-never-executed",
          spawnFn: fakeSpawnFn(),
          suspendAheadThresholdOverride: 10_000,
          resumeAheadThresholdOverride: 5_000,
        },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);
      // Run 0 encodes the ladder's TOP rung (index 0) — §9.1.3's convention,
      // recorded on the row at spawn (which is strictly after the spawn
      // itself, hence the wait rather than a bare read).
      await waitForActiveRung(sessionId, 0, 10_000 * TIME_SCALE);

      // Same unpruned [0, 24 000] window as the absorbing test.
      fabricateRunPlaylist(sessionId, 0, 4);
      await waitForProducedSegment(sessionId, 3, 10_000 * TIME_SCALE);

      // The COINCIDENT pair, written in ONE statement so the tick under
      // test provably observes both columns together — §9.1.7's "one
      // restart serves both". Written directly rather than through
      // requestSeek + requestRungSwitch because two statements admit a
      // poll tick landing between them, and this test is about what the
      // absorption rule does when both are already set.
      await raw.query(`UPDATE playback_sessions SET seek_target_ms = 12000, pending_rung_index = 2, updated_at_ms = $2 WHERE id = $1`, [sessionId, Date.now()]);

      await waitForSpawnCount(2, 10_000 * TIME_SCALE);
      // The rung write is the LAST of run 1's post-spawn row writes
      // (transcode_runs first, then this), so waiting for it makes every
      // assertion below deterministic rather than settle-timed.
      await waitForActiveRung(sessionId, 2, 10_000 * TIME_SCALE);
      await waitForRunCount(sessionId, 2, 10_000 * TIME_SCALE);
      await new Promise((r) => setTimeout(r, 400 * TIME_SCALE));

      // EXACTLY ONE restart — not an absorb followed by a handoff, and not
      // two restarts.
      expect(children.length, "a coincident seek+switch must spawn exactly one run").toBe(2);

      const row = await readRow(sessionId);
      expect(row.discontinuity_count, "the seek was CONSUMED (a restart), not absorbed").toBe(1);
      expect(row.seek_target_ms).toBeNull();
      const rungRow = await readRungRow(sessionId);
      expect(rungRow.pending_rung_index).toBeNull();
      expect(rungRow.active_rung_index, "the spawned run encodes the REQUESTED rung").toBe(2);

      // The origin is the whole point: absorbing the seek and letting the
      // handoff restart instead would also produce exactly one extra run —
      // but at the live-edge continuation origin (0 + 24 000), not at the
      // position the client asked for.
      const runs = await readRuns(sessionId);
      expect(runs).toEqual([
        { run_index: 0, source_origin_ms: 0, ladder_rung_index: 0 },
        { run_index: 1, source_origin_ms: 12_000, ladder_rung_index: 2 },
      ]);

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );
});
