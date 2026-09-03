// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/restart-perf.integration.spec.ts
//
// SPF-2026-09-03, lane w2: three properties of the restart path the design
// (reports/state/DECISIONS.md SPF-2, SPF-3a, SPF-3b) is built on.
//
//   (a) SPF-2 — on win32 every run (including a seek-restart's) is paced
//       with an INITIAL BURST, not the old bare `-readrate 1.2`.
//   (b) SPF-3b — the served playlist on disk is rewritten only when its
//       rendered text actually changed; a tick that folds nothing new
//       leaves the file (and its mtime) untouched.
//   (c) SPF-3a — `restartAt` never spawns the replacement process before
//       the dying one's `terminate()` has resolved, even though
//       `rebuildSeekArgs` now runs concurrently with that terminate.
//
// Real ffmpeg is deliberately NOT used (seek-dedup.integration.spec.ts's
// convention): an injected fake child process plus a fabricated per-run
// playlist makes timing deterministic and lets this suite run on a
// machine without ffmpeg.

import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { WIN32_READRATE_BURST_SEC, WIN32_READRATE_MULTIPLIER } from "../../src/transcode/throttle.js";

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

describe("SPF-2026-09-03 lane w2: restart-path performance properties", () => {
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
  /** Ordering evidence for test (c): every spawn and every kill signal
   *  pushes a line here, in the order it actually happened. */
  let events: string[] = [];
  /** Pids whose SIGTERM/SIGKILL must NOT auto-close — test (c) holds the
   *  dying run open on purpose and releases it explicitly, so the runner's
   *  wait on `terminate()` is entirely under this test's control instead
   *  of a race against a macrotask. */
  let heldPids: Set<number> = new Set();
  /** argv actually handed to the fake spawn, by pid — test (a) inspects
   *  this to prove the win32 pacing burst is really on the wire. */
  let argvByPid: Map<number, string[]> = new Map();

  function installFakeProcessTable(): void {
    const byPid = new Map<number, FakeChild>();
    children = [];
    events = [];
    heldPids = new Set();
    argvByPid = new Map();
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      const resolvedPid = Math.abs(Number(pid));
      const child = byPid.get(resolvedPid);
      if (!child) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        events.push(`kill:${signal}:${resolvedPid}`);
        if (!heldPids.has(resolvedPid)) {
          setTimeout(() => child.emitClose(signal), 0);
        }
        // else: held on purpose — releaseHold() below closes it later.
      }
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    (globalThis as unknown as { __fakeChildren: Map<number, FakeChild> }).__fakeChildren = byPid;
  }

  /** Explicitly closes a held pid — the only thing that can resolve its
   *  `terminate()`. Records the release in `events` BEFORE closing, so a
   *  spawn that races ahead of it shows up out of order in the log. */
  function releaseHold(pid: number): void {
    events.push(`release:${pid}`);
    heldPids.delete(pid);
    const child = (globalThis as unknown as { __fakeChildren: Map<number, FakeChild> }).__fakeChildren.get(pid);
    child?.emitClose("SIGTERM");
  }

  function fakeSpawnFn(): typeof import("node:child_process").spawn {
    return ((_ffmpegPath: string, args: string[]): unknown => {
      const pid = FAKE_PID_BASE + children.length;
      const child = new FakeChild(pid);
      children.push(child);
      argvByPid.set(pid, args);
      events.push(`spawn:${children.length - 1}:${pid}`);
      (globalThis as unknown as { __fakeChildren: Map<number, FakeChild> }).__fakeChildren.set(pid, child);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
  }

  beforeAll(async () => {
    DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), "w2_restart_perf_test");
    resetSchema();
    db = createDb(DATABASE_URL);
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();

    const now = Date.now();
    const userRow = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
       VALUES ('restart-perf-test', 'restart-perf@loombre.local', 'x', $1, $1) RETURNING id`,
      [now],
    );
    const userId = userRow.rows[0]!.id;

    const deviceProfile: DeviceProfile = {
      profileId: "restart-perf-device",
      directPlayContainers: ["mp4"],
      hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
      video: [{ codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null }],
      hdr: { hdr10: false, hlg: false, dolbyVision: false },
      audio: [{ codec: "opus", maxChannels: 2, passthrough: false }],
      subtitles: { renderText: [], hlsVtt: true, renderImage: false },
      maxStreamBitrateBps: null,
    };
    const deviceRow = await raw.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'restart-perf-device', $2, $3) RETURNING id`,
      [userId, JSON.stringify(deviceProfile), now],
    );
    deviceId = deviceRow.rows[0]!.id;

    const libRow = await raw.query<{ id: string }>(
      `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
       VALUES ('Restart Perf Library', 'movie', '{}', $1, $1) RETURNING id`,
      [now],
    );
    const libraryId = libRow.rows[0]!.id;
    await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

    const itemRow = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', 'Restart Perf Movie', 'restart perf movie', $2, $2) RETURNING id`,
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
       VALUES ($1, $2, 'restart-perf-hash', $3, 'mp4', 150000, $4) RETURNING id`,
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
      segmentDurationSec: 6,
      hevcEncodePreferred: false,
    };
    const caps: VerifiedCapabilities = { backends: [] };
    const input: PlanInput = { media, device: deviceProfile, network, policy, caps, selection, mode: "stream" };
    const planResult = plan(input);
    expect(planResult.decision).toBe("transcode");
    storedPlan = { ...planResult, selection };

    stagingRoot = mkdtempSync(join(tmpdir(), "loombre-restart-perf-"));
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

  async function waitForProducedSegment(sessionId: string, expected: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await raw.query<{ produced_segment: number | null }>(`SELECT produced_segment FROM playback_sessions WHERE id = $1`, [sessionId]);
      if (rows[0]?.produced_segment === expected) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for produced_segment=${expected}; saw ${String(rows[0]?.produced_segment)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Writes a run's own append-only playlist exactly as ffmpeg would
   *  (retention-viewer-floor.integration.spec.ts's `fabricateRunPlaylist`).
   *  ATOMIC (temp + rename) because the poll loop may read it at any
   *  instant. */
  function fabricateRunPlaylist(sessionId: string, runIndex: number, segmentCount: number, firstSegmentIndex = 0): void {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:6", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT", '#EXT-X-MAP:URI="init.mp4"'];
    for (let i = 0; i < segmentCount; i += 1) {
      lines.push("#EXTINF:6.000000,");
      lines.push(`s${String(firstSegmentIndex + i).padStart(6, "0")}.m4s`);
    }
    const runDir = join(stagingRoot, sessionId, `run${runIndex}`);
    const target = join(runDir, "media.m3u8");
    const tmp = `${target}.fabricate.tmp`;
    writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
    renameSync(tmp, target);
  }

  function servedPlaylistPath(sessionId: string): string {
    return join(stagingRoot, sessionId, "media.m3u8");
  }

  /** Blocks until the served playlist on disk satisfies `predicate` — the
   *  DB write that advances `produced_segment` happens before this tick's
   *  file write, so a bare read straight after `waitForProducedSegment` is
   *  a genuine race (retention-viewer-floor.integration.spec.ts's
   *  `waitForServedPlaylist`, verbatim pattern). */
  async function waitForServedPlaylist(sessionId: string, predicate: (text: string) => boolean, timeoutMs: number): Promise<string> {
    const path = servedPlaylistPath(sessionId);
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      try {
        last = readFileSync(path, "utf8");
        if (predicate(last)) return last;
      } catch {
        /* not written yet */
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the served playlist; last read:\n${last}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it(
    "SPF-2: win32 gets the initial-burst readrate on the very first run",
    { timeout: 30_000 * TIME_SCALE },
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
          platformOverride: "win32",
        },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);
      const pid0 = children[0]!.pid;
      const argv = argvByPid.get(pid0)!;
      const at = argv.indexOf("-readrate");
      expect(at, `-readrate not found in ${JSON.stringify(argv)}`).toBeGreaterThanOrEqual(0);
      expect(argv.slice(at, at + 4)).toEqual([
        "-readrate",
        String(WIN32_READRATE_MULTIPLIER),
        "-readrate_initial_burst",
        String(WIN32_READRATE_BURST_SEC),
      ]);
      expect(WIN32_READRATE_MULTIPLIER).toBe(1.2);
      expect(WIN32_READRATE_BURST_SEC).toBe(30);

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  it(
    "SPF-3b: the served playlist is rewritten only when its rendered text changed",
    { timeout: 30_000 * TIME_SCALE },
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
        },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);

      fabricateRunPlaylist(sessionId, 0, 2, 0);
      await waitForProducedSegment(sessionId, 1, 10_000 * TIME_SCALE);

      const path = servedPlaylistPath(sessionId);
      const text1 = await waitForServedPlaylist(sessionId, (t) => t.includes("s000001.m4s"), 10_000 * TIME_SCALE);
      const mtime1 = statSync(path).mtimeMs;

      // Several more poll ticks with NOTHING new to fold — the fabricated
      // run playlist is untouched, so every one of these ticks must be a
      // no-op write.
      await new Promise((r) => setTimeout(r, 400 * TIME_SCALE));

      const text2 = readFileSync(path, "utf8");
      const mtime2 = statSync(path).mtimeMs;
      expect(text2, "served playlist text drifted with no new production").toBe(text1);
      expect(mtime2, "served playlist was rewritten on a tick that folded nothing new").toBe(mtime1);

      // Now genuinely change the run's own playlist — the served file MUST
      // still be rewritten when there is something new to fold.
      fabricateRunPlaylist(sessionId, 0, 3, 0);
      await waitForProducedSegment(sessionId, 2, 10_000 * TIME_SCALE);
      const text3 = await waitForServedPlaylist(sessionId, (t) => t.includes("s000002.m4s"), 10_000 * TIME_SCALE);
      expect(text3).not.toBe(text2);

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  it(
    "SPF-3a: restartAt never spawns the replacement before terminate() has resolved",
    { timeout: 30_000 * TIME_SCALE },
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
        },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);
      const pid0 = children[0]!.pid;

      // Hold run 0's termination open BEFORE requesting the seek: the
      // restart's SIGTERM will be sent and recorded, but the fake process
      // never reports 'close' until this test explicitly releases it — so
      // `terminate()` cannot resolve on its own.
      heldPids.add(pid0);

      await requestSeek(db, ctx, sessionId, 60_000, Date.now());

      // Several poll ticks pass — long enough for rebuildSeekArgs (a couple
      // of DB reads) to have finished many times over. Nothing may spawn
      // while run 0's terminate() is still pending, no matter how long we
      // wait: SPF-3a runs rebuild CONCURRENTLY with terminate, but the
      // spawn is still gated on BOTH resolving.
      await new Promise((r) => setTimeout(r, 400 * TIME_SCALE));
      expect(children.length, "a second run was spawned before the first one's terminate() resolved").toBe(1);
      expect(events).toContain(`kill:SIGTERM:${pid0}`);
      expect(
        events.some((e) => e.startsWith("spawn:1:")),
        "no spawn may appear before the dying run is released",
      ).toBe(false);

      releaseHold(pid0);
      await waitForSpawnCount(2, 10_000 * TIME_SCALE);

      const releaseIdx = events.indexOf(`release:${pid0}`);
      const spawnIdx = events.findIndex((e) => e.startsWith("spawn:1:"));
      expect(releaseIdx).toBeGreaterThanOrEqual(0);
      expect(spawnIdx).toBeGreaterThan(releaseIdx);

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );
});
