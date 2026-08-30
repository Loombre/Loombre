// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/throttle-suspend-bound.integration.spec.ts
//
// d3-f3 (QA 2026-08-24, P2 — F/throttle-suspend-duration): AN UNBOUNDED
// SIGSTOP WHILE THE VIEWER IS PAUSED.
//
// The segment-ahead throttle (docs/PLAYBACK.md §9) SIGSTOPs the ffmpeg
// process group once the encoder is more than 10 segments (60 s) ahead of
// the client, and resumes it when the lead drops back to 5. For a paused
// viewer the lead never drops, so the process stayed SIGSTOPped for as long
// as the pause lasted — minutes, or the whole heartbeat window. That is the
// leading suspected trigger for the VideoToolbox session death behind
// browser-player-F2 (`Error encoding frame: -17691`,
// kVTSessionMalfunctionErr): a hardware compression session is an
// out-of-process resource, and holding one open in a stopped process for
// minutes is exactly the shape that loses it. The F2 fix recovers from the
// death; it does not remove the trigger.
//
// THE BOUND under test: a physically stopped encoder is RELEASED — cleanly
// terminated — once it has been stopped for `maxStoppedMs`
// (config.ts's THROTTLE_MAX_SUSPEND_MS / LOOMBRE_TRANSCODE_MAX_SUSPEND_MS).
// Nothing about the session's served output changes: every segment the run
// already produced stays on disk and in the served playlist, which is
// precisely the ~60 s of buffer the throttle had run ahead to build. When
// the viewer comes back and consumes it, the runner restarts the pipeline
// at the exact §9.1.4 continuation origin, so the resume costs one ordinary
// restart against a client that is holding a minute of buffer — and the
// stopped-encoder-for-minutes state that kills VT sessions no longer
// exists.
//
// Real ffmpeg is deliberately NOT used (seek-dedup.integration.spec.ts's
// convention): the assertions are about which SIGNALS the runtime sends and
// which processes it spawns, so an injected fake child plus a fabricated
// per-run playlist makes the whole thing deterministic and runs on a
// machine without ffmpeg.

import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createPlaybackSession, endPlaybackSession, ensureTestDatabase, resolveTestDatabaseUrl } from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import { plan, type DeviceProfile, type MediaInfo, type NetworkConditions, type PlanInput, type ServerPolicy, type TrackSelection, type VerifiedCapabilities } from "@loombre/playback-engine";
import { runTranscodeSession } from "../../src/transcode/runner.js";
import { terminateAllTranscodeRuns } from "../../src/transcode/run-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DB_PKG_ROOT = join(REPO_ROOT, "packages", "db");
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

/** Fake pids live in a range no real process can occupy here. */
const FAKE_PID_BASE = 960_001;

describe("d3-f3: a throttle SIGSTOP is bounded — a paused viewer never leaves an encoder stopped for minutes", () => {
  let db: ReturnType<typeof createDb>;
  let raw: pg.Client;
  let stagingRoot: string;
  let ctx: ViewerContext;
  let deviceId: string;
  let itemId: string;
  let fileId: string;
  let storedPlan: Record<string, unknown>;

  let children: FakeChild[] = [];
  /** Every signal the runtime sent, in order, per pid — the observable this
   *  finding is about (SIGSTOP with no matching SIGCONT/SIGTERM). */
  let signals: { pid: number; signal: string }[] = [];
  let killSpy: ReturnType<typeof vi.spyOn> | undefined;

  function installFakeProcessTable(): void {
    const byPid = new Map<number, FakeChild>();
    children = [];
    signals = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.kill's overloads do not narrow through a spy
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      const child = byPid.get(Math.abs(Number(pid)));
      if (!child) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      signals.push({ pid: Math.abs(Number(pid)), signal: String(signal) });
      if (signal === "SIGTERM" || signal === "SIGKILL") {
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

  function signalsFor(pid: number): string[] {
    return signals.filter((s) => s.pid === pid).map((s) => s.signal);
  }

  beforeAll(async () => {
    DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), "worker_throttle_bound_test");
    resetSchema();
    db = createDb(DATABASE_URL);
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();

    const now = Date.now();
    const userRow = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
       VALUES ('throttle-bound-test', 'throttle-bound@loombre.local', 'x', $1, $1) RETURNING id`,
      [now],
    );
    const userId = userRow.rows[0]!.id;

    const deviceProfile: DeviceProfile = {
      profileId: "throttle-bound-device",
      directPlayContainers: ["mp4"],
      hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
      video: [{ codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null }],
      hdr: { hdr10: false, hlg: false, dolbyVision: false },
      audio: [{ codec: "opus", maxChannels: 2, passthrough: false }],
      subtitles: { renderText: [], hlsVtt: true, renderImage: false },
      maxStreamBitrateBps: null,
    };
    const deviceRow = await raw.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'throttle-bound-device', $2, $3) RETURNING id`,
      [userId, JSON.stringify(deviceProfile), now],
    );
    deviceId = deviceRow.rows[0]!.id;

    const libRow = await raw.query<{ id: string }>(
      `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
       VALUES ('Throttle Bound Library', 'movie', '{}', $1, $1) RETURNING id`,
      [now],
    );
    const libraryId = libRow.rows[0]!.id;
    await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

    const itemRow = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', 'Throttle Bound Movie', 'throttle bound movie', $2, $2) RETURNING id`,
      [libraryId, now],
    );
    itemId = itemRow.rows[0]!.id;

    const fakeMediaPath = join(REPO_ROOT, "test-fixtures", "media", "session_long.mp4");
    let sizeBytes = 1_000_000;
    try {
      sizeBytes = statSync(fakeMediaPath).size;
    } catch {
      /* fixture not generated on this machine — the size is not load-bearing */
    }
    const fileRow = await raw.query<{ id: string }>(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
       VALUES ($1, $2, 'throttle-bound-hash', $3, 'mp4', 600000, $4) RETURNING id`,
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
      durationMs: 600_000,
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

    stagingRoot = mkdtempSync(join(tmpdir(), "loombre-throttle-bound-"));
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
    const session = await createPlaybackSession(db, ctx, { itemId, fileId, deviceId, plan: storedPlan, engineVersion: "test", nowMs: Date.now() });
    return session!.id;
  }

  async function waitForSpawnCount(n: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (children.length < n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} spawn(s); saw ${children.length}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Writes a run's own append-only playlist the way ffmpeg would
   *  (seek-dedup.integration.spec.ts's fabrication convention) — a faked
   *  child writes no file, and `produced_segment` (the throttle's input) is
   *  derived from exactly this. ATOMIC, because the poll loop may read it
   *  at any instant. */
  function fabricateRunPlaylist(sessionId: string, runIndex: number, segmentCount: number, firstSegmentIndex = 0): void {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:6", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT", '#EXT-X-MAP:URI="init.mp4"'];
    for (let i = 0; i < segmentCount; i += 1) {
      lines.push("#EXTINF:6.000000,");
      lines.push(`s${String(firstSegmentIndex + i).padStart(6, "0")}.m4s`);
    }
    const target = join(stagingRoot, sessionId, `run${runIndex}`, "media.m3u8");
    const tmp = `${target}.fabricate.tmp`;
    writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
    renameSync(tmp, target);
  }

  async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async function readRow(sessionId: string): Promise<{ status: string; suspended_by_throttle: boolean; error_code: string | null }> {
    const { rows } = await raw.query<{ status: string; suspended_by_throttle: boolean; error_code: string | null }>(
      `SELECT status, suspended_by_throttle, error_code FROM playback_sessions WHERE id = $1`,
      [sessionId],
    );
    return rows[0]!;
  }

  async function readRuns(sessionId: string): Promise<{ run_index: number; start_segment: number; source_origin_ms: number }[]> {
    const { rows } = await raw.query<{ run_index: number; start_segment: number; source_origin_ms: string | number }>(
      `SELECT run_index, start_segment, source_origin_ms FROM transcode_runs WHERE session_id = $1 ORDER BY run_index`,
      [sessionId],
    );
    return rows.map((r) => ({ run_index: r.run_index, start_segment: r.start_segment, source_origin_ms: Number(r.source_origin_ms) }));
  }

  /** Drives run 0 into the throttle's suspended state: 12 x 6 s produced
   *  against a client that has requested nothing (a viewer who pressed
   *  pause at 0:00), i.e. ahead = 11 > the suspend threshold of 10. */
  async function suspendRunZero(sessionId: string): Promise<void> {
    fabricateRunPlaylist(sessionId, 0, 12);
    await waitUntil(async () => (await readRow(sessionId)).suspended_by_throttle, 15_000 * TIME_SCALE, "run 0 throttle-suspended");
    expect(signalsFor(children[0]!.pid), "the throttle physically SIGSTOPs the group").toContain("SIGSTOP");
  }

  it(
    "an encoder stopped for longer than the bound is RELEASED, not left SIGSTOPped for the whole pause",
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
          // The real bound is minutes (config.ts); a test cannot wait that
          // long, and the DURATION is not what is under test — that a bound
          // exists at all, and what happens when it elapses, is.
          maxSuspendMsOverride: 400,
        },
        sessionId,
      );

      try {
        await waitForSpawnCount(1, 10_000 * TIME_SCALE);
        await suspendRunZero(sessionId);

        // THE PIN. Before d3-f3 this process stayed stopped for as long as
        // the viewer stayed paused — SIGSTOP with no matching signal, ever.
        await waitUntil(() => children[0]!.closed, 15_000 * TIME_SCALE, "the stopped encoder is released within the bound");
        expect(signalsFor(children[0]!.pid), "a released encoder is TERMINATED, never merely left stopped").toContain("SIGTERM");

        // Releasing is not a restart: nothing is spawned while the viewer is
        // still away (a Tier-0 box must not re-encode for nobody), and it is
        // certainly not a failure — every segment run 0 produced is still
        // served.
        await new Promise((r) => setTimeout(r, 300 * TIME_SCALE));
        expect(children.length, "no replacement encoder is spawned while the viewer is still paused").toBe(1);
        const row = await readRow(sessionId);
        expect(row.status).not.toBe("failed");
        expect(row.error_code).toBeNull();
        expect(row.suspended_by_throttle, "the session is still the throttle's to resume").toBe(true);

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
    "the viewer coming back restarts the RELEASED pipeline once, at the exact §9.1.4 continuation origin",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      installFakeProcessTable();
      const sessionId = await createSession();
      const runPromise = runTranscodeSession(
        { db, stagingRoot, pollIntervalMs: 25, ffmpegPath: "/nonexistent/ffmpeg-never-executed", spawnFn: fakeSpawnFn(), maxSuspendMsOverride: 400 },
        sessionId,
      );

      try {
        await waitForSpawnCount(1, 10_000 * TIME_SCALE);
        await suspendRunZero(sessionId);
        await waitUntil(() => children[0]!.closed, 15_000 * TIME_SCALE, "the stopped encoder is released");

        // Play resumes: the client works through the ~72 s of buffer the
        // throttle had run ahead to build, which apps/server records on
        // every segment GET (`requested_segment`).
        await raw.query(`UPDATE playback_sessions SET requested_segment = 11, updated_at_ms = $2 WHERE id = $1`, [sessionId, Date.now()]);

        await waitForSpawnCount(2, 15_000 * TIME_SCALE);
        await waitUntil(async () => (await readRuns(sessionId)).length >= 2, 10_000 * TIME_SCALE, "the resumed run is recorded");
        await new Promise((r) => setTimeout(r, 300 * TIME_SCALE));

        // ONE restart, at the position the old run had reached — exactly the
        // slot-handoff origin (12 x 6 s), never back at the top of the file
        // and never a second spawn.
        expect(children.length, "a resume restarts the pipeline exactly once").toBe(2);
        expect(await readRuns(sessionId)).toEqual([
          { run_index: 0, start_segment: 0, source_origin_ms: 0 },
          { run_index: 1, start_segment: 12, source_origin_ms: 72_000 },
        ]);

        // Restart hygiene (V8): the fresh process is not throttle-stopped,
        // and the row must not still say it is.
        const row = await readRow(sessionId);
        expect(row.suspended_by_throttle).toBe(false);
        expect(row.status).not.toBe("failed");

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
    "a viewer who comes back INSIDE the bound gets a plain SIGCONT — the ordinary throttle cycle is untouched",
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
          // Far longer than this test takes: the release path must not fire.
          maxSuspendMsOverride: 60_000,
        },
        sessionId,
      );

      try {
        await waitForSpawnCount(1, 10_000 * TIME_SCALE);
        await suspendRunZero(sessionId);

        await raw.query(`UPDATE playback_sessions SET requested_segment = 11, updated_at_ms = $2 WHERE id = $1`, [sessionId, Date.now()]);
        await waitUntil(async () => !(await readRow(sessionId)).suspended_by_throttle, 15_000 * TIME_SCALE, "the throttle resumes the run");

        expect(signalsFor(children[0]!.pid), "resuming inside the bound is a SIGCONT").toContain("SIGCONT");
        expect(signalsFor(children[0]!.pid), "…and never a kill").not.toContain("SIGTERM");
        expect(children[0]!.closed).toBe(false);
        expect(children.length, "an ordinary throttle resume restarts nothing").toBe(1);

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
});
