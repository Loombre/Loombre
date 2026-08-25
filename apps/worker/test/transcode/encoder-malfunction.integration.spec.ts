// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/encoder-malfunction.integration.spec.ts
//
// QA finding browser-player-F2 (P1) — HARDWARE ENCODE-SESSION DEATH.
//
// Observed on real media: a 4K HDR10 source tone-mapping to a 1080p
// `hevc_videotoolbox` rung ran for ~6 minutes and then the encoder died
// with `Error encoding frame: -17691` — OSStatus `kVTSessionMalfunctionErr`
// (MacOSX.sdk VideoToolbox/VTErrors.h:61), the out-of-process VideoToolbox
// session malfunctioning, which ffmpeg maps to AVERROR_EXTERNAL and exits
// non-zero on. runner.ts's poll loop treated ANY unexpected non-zero exit
// as terminal, so the session went `failed`/`transcode-failed` mid-watch
// with no attempt to bring the pipeline back.
//
// A dead VT session is a property of the SESSION, not of the frame or the
// file: a fresh compression session usually works, and if it does not, the
// same rung encodes fine in software. This suite drives the whole recovery
// against the REAL poll loop and a REAL Postgres, with an INJECTED fake
// child process (seek-dedup.integration.spec.ts's convention) — no ffmpeg,
// no VideoToolbox, no macOS, so the recovery is exercised identically on
// every CI runner. The crash is delivered by writing the real recorded
// stderr tail into the fake process and closing it non-zero, which is
// exactly the input the runtime sees from a real one.
//
// What real ffmpeg on real hardware still has to prove (integrator, on the
// primary stack) is written up in this lane's report: that the happy path
// still uses hardware, and that a forced malfunction really does recover.

import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createPlaybackSession, ensureTestDatabase } from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import type { DeviceProfile } from "@loombre/playback-engine";
import { runTranscodeSession } from "../../src/transcode/runner.js";
import { terminateAllTranscodeRuns } from "../../src/transcode/run-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DB_PKG_ROOT = join(REPO_ROOT, "packages", "db");
const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);

/** An ISOLATED per-suite database (packages/db/src/testing.ts's
 *  `ensureTestDatabase`), derived from `DATABASE_URL` the way
 *  apps/server/test/*.e2e.spec.ts derive theirs — the base string is used
 *  ONLY as the admin connection that creates `<base>_<suffix>`, and the
 *  database this suite actually resets and writes to is that fresh,
 *  `_test`-suffixed, claimed-disposable one. (The sibling transcode specs
 *  go through `resolveTestDatabaseUrl()` instead, which additionally
 *  requires a `<base>_test` database to already exist to connect through;
 *  deriving straight from `DATABASE_URL` needs nothing pre-provisioned,
 *  which is what lets this suite run unchanged in a lane worktree whose
 *  database was created for it.) */
let DATABASE_URL: string;
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

/** The stderr tail recorded on the failed session, verbatim in shape. */
const VT_MALFUNCTION_STDERR = [
  "[hevc_videotoolbox @ 0x14a8f4e70] Error encoding frame: -17691",
  "[hevc_videotoolbox @ 0x14a8f4e70] Error submitting video frame to the encoder",
  "[out#0/hls @ 0x14a8e0a40] Terminating thread with return code -542398533 (Generic error in an external library)",
].join("\n");

/** Any other non-zero exit — must stay terminal on the FIRST failure. */
const GENERIC_FAILURE_STDERR = "[in#0 @ 0x1] Error opening input: No such file or directory\n";

/** A crash loop must be bounded; this is the ceiling the assertions hold
 *  the runtime to, comfortably above the real budget (2 fresh-session
 *  retries + 1 software fallback = 4 spawns in total). */
const SPAWN_CEILING = 8;

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
// Fake child process (process.spec.ts / seek-dedup.integration.spec.ts's
// convention, extended with an on-demand non-zero CRASH that carries a
// stderr tail — the one thing this finding is about).
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  closed = false;
  constructor(readonly pid: number) {
    super();
  }
  emitClose(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", exitCode, signal);
  }
  /** What a dying ffmpeg looks like from this runtime's side: a stderr
   *  burst, then a non-zero close it never asked for. */
  crash(stderrTail: string, exitCode = 1): void {
    this.stderr.emit("data", Buffer.from(stderrTail, "utf8"));
    this.emitClose(exitCode, null);
  }
}

const FAKE_PID_BASE = 991_001;

interface SpawnRecord {
  child: FakeChild;
  args: string[];
}

describe("hardware encode-session death recovery (browser-player-F2)", () => {
  let db: ReturnType<typeof createDb>;
  let raw: pg.Client;
  let stagingRoot: string;
  let ctx: ViewerContext;
  let deviceId: string;
  let itemId: string;
  let fileId: string;

  let spawns: SpawnRecord[] = [];
  let killSpy: ReturnType<typeof vi.spyOn> | undefined;
  /** When set, every NEW spawn crashes itself on the next macrotask with
   *  this stderr — the "keeps dying" scenarios. */
  let autoCrashStderr: string | undefined;

  function installFakeProcessTable(): void {
    const byPid = new Map<number, FakeChild>();
    spawns = [];
    autoCrashStderr = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.kill's overloads do not narrow through a spy
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      const child = byPid.get(Math.abs(Number(pid)));
      if (!child) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err; // killProcessGroup catches this, exactly as for a dead pid
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        setTimeout(() => child.emitClose(null, signal), 0);
      }
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    (globalThis as unknown as { __fakeChildren: Map<number, FakeChild> }).__fakeChildren = byPid;
  }

  function fakeSpawnFn(): typeof import("node:child_process").spawn {
    return ((_file: string, args: string[]): unknown => {
      const pid = FAKE_PID_BASE + spawns.length;
      const child = new FakeChild(pid);
      spawns.push({ child, args: [...args] });
      (globalThis as unknown as { __fakeChildren: Map<number, FakeChild> }).__fakeChildren.set(pid, child);
      if (autoCrashStderr !== undefined) {
        const stderr = autoCrashStderr;
        setTimeout(() => child.crash(stderr), 0);
      }
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
  }

  beforeAll(async () => {
    DATABASE_URL = await ensureTestDatabase(BASE_DATABASE_URL, "worker_encoder_malfunction_test");
    resetSchema();
    db = createDb(DATABASE_URL);
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();

    const now = Date.now();
    const userRow = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
       VALUES ('encoder-malfunction-test', 'encoder-malfunction@loombre.local', 'x', $1, $1) RETURNING id`,
      [now],
    );
    const userId = userRow.rows[0]!.id;

    // An SDR 1080p device against a 4K HDR10 hevc source: the shape whose
    // plan is "tone-map + downscale + hevc encode", which on this machine
    // is `hevc_videotoolbox` + `scale_vt`.
    const deviceProfile: DeviceProfile = {
      profileId: "encoder-malfunction-device",
      directPlayContainers: ["mp4"],
      hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
      video: [{ codec: "hevc", maxProfile: "main 10", maxLevel: null, maxBitDepth: 10, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null }],
      hdr: { hdr10: false, hlg: false, dolbyVision: false },
      audio: [{ codec: "opus", maxChannels: 6, passthrough: false }],
      subtitles: { renderText: [], hlsVtt: true, renderImage: false },
      maxStreamBitrateBps: null,
    };
    const deviceRow = await raw.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'encoder-malfunction-device', $2, $3) RETURNING id`,
      [userId, JSON.stringify(deviceProfile), now],
    );
    deviceId = deviceRow.rows[0]!.id;

    const libRow = await raw.query<{ id: string }>(
      `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
       VALUES ('Encoder Malfunction Library', 'movie', '{}', $1, $1) RETURNING id`,
      [now],
    );
    const libraryId = libRow.rows[0]!.id;
    await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

    const itemRow = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', 'Encoder Malfunction Movie', 'encoder malfunction movie', $2, $2) RETURNING id`,
      [libraryId, now],
    );
    itemId = itemRow.rows[0]!.id;

    // The path is never opened (every spawn is faked) but the rows must be
    // complete enough for rebuildSeekArgs to re-assemble a MediaInfo.
    const fileRow = await raw.query<{ id: string }>(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
       VALUES ($1, '/nonexistent/encoder-malfunction-4k-hdr.mkv', 'encoder-malfunction-hash', 40000000000, 'mkv', 7200000, $2) RETURNING id`,
      [itemId, now],
    );
    fileId = fileRow.rows[0]!.id;
    await raw.query(
      `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, profile, width, height, bit_depth, frame_rate, hdr, is_default, is_forced)
       VALUES ($1, 0, 'video', 'hevc', 'main 10', 3840, 2160, 10, 23.976, 'hdr10', true, false)`,
      [fileId],
    );
    await raw.query(
      `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, channels, sample_rate, language, is_default, is_forced)
       VALUES ($1, 1, 'audio', 'eac3', 6, 48000, 'eng', true, false)`,
      [fileId],
    );

    ctx = { userId, allowedLibraryIds: [libraryId], restrictedCleared: false };
    stagingRoot = mkdtempSync(join(tmpdir(), "loombre-encoder-malfunction-"));
  }, 60_000 * TIME_SCALE);

  afterEach(async () => {
    autoCrashStderr = undefined;
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

  /** The stored plan the failed session was running: 4K HDR10 -> 1080p
   *  hevc on VideoToolbox, tone-mapped by scale_vt. Hand-built rather than
   *  taken from `plan()` so the encoder/tone-map pair under test is exact
   *  and independent of what THIS machine's hardware probe would pick. */
  function videotoolboxStoredPlan(): Record<string, unknown> {
    return {
      decision: "transcode",
      reasons: [],
      container: "fmp4-hls",
      video: { action: "transcode", targetCodec: "hevc", encoder: "videotoolbox", toneMap: "videotoolbox" },
      audio: { action: "transcode", targetCodec: "opus", targetChannels: 6, targetBitrateBps: 384_000 },
      subtitle: { strategy: "none" },
      ladder: [{ heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "hevc" }],
      ffmpegArgs: [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostdin",
        "-hwaccel",
        "videotoolbox",
        "-hwaccel_output_format",
        "videotoolbox_vld",
        "-i",
        "{INPUT}",
        "-map",
        "0:a:0",
        "-filter_complex",
        "[0:v:0]scale_vt=w=-2:h=1080:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709[vout]",
        "-map",
        "[vout]",
        "-c:v",
        "hevc_videotoolbox",
        "-c:a",
        "libopus",
        "-f",
        "hls",
        "{RUN_DIR}/media.m3u8",
      ],
      engineVersion: "test",
      selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    };
  }

  /** The same stored plan with a TWO-RUNG ladder — the only shape in which
   *  a rung switch (and therefore §9.1.7's coincident pair) means anything.
   *  d3-f4's rung half needs a real second rung for `pending_rung_index` to
   *  name. */
  function videotoolboxLadderStoredPlan(): Record<string, unknown> {
    const base = videotoolboxStoredPlan();
    return {
      ...base,
      ladder: [
        { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "hevc" },
        { heightPx: 720, videoBitrateBps: 4_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      ],
    };
  }

  async function createSession(plan: Record<string, unknown> = videotoolboxStoredPlan()): Promise<string> {
    const session = await createPlaybackSession(db, ctx, { itemId, fileId, deviceId, plan, engineVersion: "test", nowMs: Date.now() });
    return session!.id;
  }

  async function waitForSpawnCount(n: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (spawns.length < n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} spawn(s); saw ${spawns.length}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async function waitForProducedSegment(sessionId: string, expected: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await raw.query<{ produced_segment: number | null }>(`SELECT produced_segment FROM playback_sessions WHERE id = $1`, [sessionId]);
      if (rows[0]?.produced_segment === expected) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for produced_segment=${expected}; saw ${String(rows[0]?.produced_segment)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Writes a run's own append-only playlist the way ffmpeg would (the
   *  fabrication convention seek-dedup.integration.spec.ts documents) —
   *  a faked child writes no file, and the recovery's CONTINUATION ORIGIN
   *  is derived from exactly this playlist. */
  function fabricateRunPlaylist(sessionId: string, runIndex: number, segmentCount: number): void {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:6", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT", '#EXT-X-MAP:URI="init.mp4"'];
    for (let i = 0; i < segmentCount; i += 1) {
      lines.push("#EXTINF:6.000000,");
      lines.push(`s${String(i).padStart(6, "0")}.m4s`);
    }
    const target = join(stagingRoot, sessionId, `run${runIndex}`, "media.m3u8");
    const tmp = `${target}.fabricate.tmp`;
    writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
    renameSync(tmp, target);
  }

  async function readRow(sessionId: string): Promise<{ status: string; error_code: string | null; stderr_tail: string | null }> {
    const { rows } = await raw.query<{ status: string; error_code: string | null; stderr_tail: string | null }>(
      `SELECT status, error_code, stderr_tail FROM playback_sessions WHERE id = $1`,
      [sessionId],
    );
    return rows[0]!;
  }

  async function readRuns(sessionId: string): Promise<{ run_index: number; source_origin_ms: number }[]> {
    const { rows } = await raw.query<{ run_index: number; source_origin_ms: string | number }>(
      `SELECT run_index, source_origin_ms FROM transcode_runs WHERE session_id = $1 ORDER BY run_index`,
      [sessionId],
    );
    return rows.map((r) => ({ run_index: r.run_index, source_origin_ms: Number(r.source_origin_ms) }));
  }

  it(
    "a kVTSessionMalfunctionErr death mid-transcode restarts on a FRESH hardware session instead of failing the watch",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 25, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);
      // Run 0 got 18 s of output out before its VT session died — the
      // recovery must resume from there, not from the top of the file.
      fabricateRunPlaylist(sessionId, 0, 3);
      await waitForProducedSegment(sessionId, 2, 10_000 * TIME_SCALE);

      spawns[0]!.child.crash(VT_MALFUNCTION_STDERR);

      await waitForSpawnCount(2, 10_000 * TIME_SCALE);

      const row = await readRow(sessionId);
      expect(row.status).not.toBe("failed");
      expect(row.error_code).toBeNull();

      // A fresh VideoToolbox session, NOT a premature software downgrade:
      // the observed failure is intermittent, and the hardware path is the
      // only one that keeps a 4K tone-map inside its Tier-0 CPU budget.
      expect(spawns[1]!.args.join(" ")).toContain("hevc_videotoolbox");

      // Resumed where run 0 stopped (3 x 6 s), from ffmpeg's own per-run
      // playlist — not restarted from zero.
      const runs = await readRuns(sessionId);
      expect(runs.map((r) => r.run_index)).toEqual([0, 1]);
      expect(runs[1]!.source_origin_ms).toBe(18_000);

      await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE id = $2`, [Date.now(), sessionId]);
      await runPromise;
    },
  );

  // ===========================================================================
  // d3-f4 (QA 2026-08-24, P3): THE RECOVERY RESTART MUST CARRY A COINCIDENT
  // SEEK / RUNG.
  //
  // The recovery block sits BEFORE the seek + slot-handoff blocks and
  // `continue`s the poll loop. So a VT death on a tick where the client had
  // ALSO asked for something spawned run N+1 at the live-edge continuation
  // origin on the old rung, and the very next tick restarted AGAIN for the
  // still-pending seek/switch: two full ffmpeg restarts ~one tick apart for
  // ONE client intention, which is exactly the double-pay §9.1.7's
  // single-restart rule merges everywhere else. The recovery branch now
  // consumes both control columns itself and hands them to the same
  // `restartAt` the seek block uses.
  //
  // The coincidence is made deterministic by a LONG poll interval: the
  // control column is written and the crash delivered inside one tick's
  // sleep, so the tick that observes the dead run provably observes the
  // pending request too.
  // ===========================================================================

  it(
    "d3-f4: a VT death coincident with a pending SEEK restarts ONCE — at the seek target, not the live edge",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 500, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      try {
        await waitForSpawnCount(1, 10_000 * TIME_SCALE);
        fabricateRunPlaylist(sessionId, 0, 3);
        await waitForProducedSegment(sessionId, 2, 10_000 * TIME_SCALE);

        // Inside ONE tick's sleep: the viewer drags the scrubber, and the
        // encoder's VT session dies before the runner next looks at the row.
        await raw.query(`UPDATE playback_sessions SET seek_target_ms = 45000, updated_at_ms = $1 WHERE id = $2`, [Date.now(), sessionId]);
        spawns[0]!.child.crash(VT_MALFUNCTION_STDERR);

        await waitForSpawnCount(2, 15_000 * TIME_SCALE);
        // Several more ticks: the failure mode is a SECOND restart chasing
        // the first, one tick later.
        await new Promise((r) => setTimeout(r, 2_000 * TIME_SCALE));

        expect(spawns.length, "one death + one seek is ONE restart, not two").toBe(2);
        const runs = await readRuns(sessionId);
        expect(runs.map((r) => r.run_index)).toEqual([0, 1]);
        expect(runs[1]!.source_origin_ms, "the single restart lands where the CLIENT asked, not at the live edge").toBe(45_000);

        const { rows } = await raw.query<{ seek_target_ms: number | null; discontinuity_count: number }>(
          `SELECT seek_target_ms, discontinuity_count FROM playback_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(rows[0]!.seek_target_ms, "the seek was CONSUMED by the recovery restart").toBeNull();
        expect(rows[0]!.discontinuity_count, "one restart, one discontinuity").toBe(1);
        expect((await readRow(sessionId)).status).not.toBe("failed");
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
    "d3-f4: a VT death coincident with a pending RUNG SWITCH restarts ONCE — on the requested rung",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession(videotoolboxLadderStoredPlan());
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 500, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      try {
        await waitForSpawnCount(1, 10_000 * TIME_SCALE);
        fabricateRunPlaylist(sessionId, 0, 3);
        await waitForProducedSegment(sessionId, 2, 10_000 * TIME_SCALE);

        await raw.query(`UPDATE playback_sessions SET pending_rung_index = 1, updated_at_ms = $1 WHERE id = $2`, [Date.now(), sessionId]);
        spawns[0]!.child.crash(VT_MALFUNCTION_STDERR);

        await waitForSpawnCount(2, 15_000 * TIME_SCALE);
        await new Promise((r) => setTimeout(r, 2_000 * TIME_SCALE));

        expect(spawns.length, "one death + one switch is ONE restart, not two").toBe(2);
        const { rows } = await raw.query<{ run_index: number; ladder_rung_index: number | null }>(
          `SELECT run_index, ladder_rung_index FROM transcode_runs WHERE session_id = $1 ORDER BY run_index`,
          [sessionId],
        );
        expect(rows.map((r) => [r.run_index, r.ladder_rung_index])).toEqual([
          [0, 0],
          [1, 1],
        ]);
        // A pure switch continues the timeline (§9.1.4) — the recovery
        // origin is the exact instant after run 0's last produced segment.
        const runs = await readRuns(sessionId);
        expect(runs[1]!.source_origin_ms).toBe(18_000);

        const { rows: cols } = await raw.query<{ pending_rung_index: number | null; active_rung_index: number | null }>(
          `SELECT pending_rung_index, active_rung_index FROM playback_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(cols[0]!.pending_rung_index).toBeNull();
        expect(cols[0]!.active_rung_index).toBe(1);
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
    "an encoder that keeps dying falls back to SOFTWARE before the session is ever failed",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      autoCrashStderr = VT_MALFUNCTION_STDERR; // every run dies the same way
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 25, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      await runPromise; // resolves when the session goes terminal

      // Bounded: a crash loop must not respawn forever.
      expect(spawns.length).toBeGreaterThan(1);
      expect(spawns.length).toBeLessThanOrEqual(SPAWN_CEILING);

      // Somewhere in there, the pipeline gave up on the hardware encoder.
      const softwareSpawn = spawns.find((s) => s.args.join(" ").includes("libx265"));
      expect(softwareSpawn, `no software fallback spawn among ${spawns.length} spawns`).toBeDefined();
      expect(softwareSpawn!.args).not.toContain("-hwaccel");
      expect(softwareSpawn!.args.join(" ")).not.toContain("scale_vt");
      // The last spawn is the software one — hardware is never retried
      // after the fallback.
      expect(spawns[spawns.length - 1]!.args.join(" ")).toContain("libx265");

      // Only THEN does it become terminal, and with a code that says what
      // actually happened rather than the generic pipeline failure.
      const row = await readRow(sessionId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("transcode-encoder-malfunction");
      expect(row.stderr_tail).toContain("-17691");
    },
  );

  it(
    "a generic non-zero ffmpeg exit is still terminal on the FIRST failure (no retry, unchanged code)",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      autoCrashStderr = GENERIC_FAILURE_STDERR;
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 25, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn() },
        sessionId,
      );

      await runPromise;

      expect(spawns.length).toBe(1);
      const row = await readRow(sessionId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("transcode-failed");
    },
  );
});
