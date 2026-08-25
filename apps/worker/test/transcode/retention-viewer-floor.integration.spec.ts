// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/retention-viewer-floor.integration.spec.ts
//
// d3-f1 (QA 2026-08-24, P1 — five merged observations): RETENTION PRUNE
// OUTRUNS THE VIEWER.
//
// Retention was defined purely against the LIVE EDGE — "drop everything
// more than SEGMENT_RETENTION_SEC behind the most recently produced
// segment". That reads as a sliding window around the viewer only while
// production is roughly realtime. On a copy-shape file it is not: the
// remux races to `#EXT-X-ENDLIST` in under a second, so the live edge IS
// the end of the film and "120s behind the live edge" means "the last 20
// segments of the movie". Live consequences, all observed on real media:
//   * a brand-new session's FIRST media.m3u8 came back
//     EXT-X-MEDIA-SEQUENCE 75 / PDT 00:07:31 — a fresh mount could never
//     play from 0:00, and every pruned-segment GET read as an implicit
//     seek (the churn behind gap-F6);
//   * 'Start over' (POST /seek {targetMs:0}) spawned a run at origin 0
//     whose head was pruned before the client re-read the playlist — the
//     served playlist's first PDT was 7:39.668 and the user landed at
//     7:40 (gap-F10);
//   * every seek's landing fragment could be deleted before the client
//     fetched it, so the client's landing watch never matched and it
//     showed the 20s 'Seek timed out' toast.
//
// The fix under test: the prune floor is VIEWER EVIDENCE (the highest
// segment index the session has actually served the client, watermarked
// monotonically in the runner) rather than the produced edge. A segment
// may be deleted only when it is BOTH behind the retention horizon AND
// below that floor. The pure arithmetic is pinned in playlist.spec.ts;
// this file pins the RUNTIME half — that the runner feeds the floor in,
// that a fresh mount keeps its head, and that a 'Start over' restart's
// landing fragment survives long enough to be served.
//
// Real ffmpeg is deliberately NOT used (seek-dedup.integration.spec.ts's
// convention, verbatim): the assertions are about which files the runtime
// keeps and what it writes into the served playlist, so an injected fake
// child plus a fabricated per-run playlist makes production timing
// deterministic and lets this suite run on a machine without ffmpeg.

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
const FAKE_PID_BASE = 970_001;

describe("d3-f1: retention pruning never outruns the viewer", () => {
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
        throw err;
      }
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

  beforeAll(async () => {
    DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), "worker_retention_floor_test");
    resetSchema();
    db = createDb(DATABASE_URL);
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();

    const now = Date.now();
    const userRow = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
       VALUES ('retention-floor-test', 'retention-floor@loombre.local', 'x', $1, $1) RETURNING id`,
      [now],
    );
    const userId = userRow.rows[0]!.id;

    const deviceProfile: DeviceProfile = {
      profileId: "retention-floor-device",
      directPlayContainers: ["mp4"],
      hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
      video: [{ codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null }],
      hdr: { hdr10: false, hlg: false, dolbyVision: false },
      audio: [{ codec: "opus", maxChannels: 2, passthrough: false }],
      subtitles: { renderText: [], hlsVtt: true, renderImage: false },
      maxStreamBitrateBps: null,
    };
    const deviceRow = await raw.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'retention-floor-device', $2, $3) RETURNING id`,
      [userId, JSON.stringify(deviceProfile), now],
    );
    deviceId = deviceRow.rows[0]!.id;

    const libRow = await raw.query<{ id: string }>(
      `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
       VALUES ('Retention Floor Library', 'movie', '{}', $1, $1) RETURNING id`,
      [now],
    );
    const libraryId = libRow.rows[0]!.id;
    await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

    const itemRow = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', 'Retention Floor Movie', 'retention floor movie', $2, $2) RETURNING id`,
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
       VALUES ($1, $2, 'retention-floor-hash', $3, 'mp4', 600000, $4) RETURNING id`,
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

    stagingRoot = mkdtempSync(join(tmpdir(), "loombre-retention-floor-"));
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

  /** Writes a run's own append-only playlist exactly as ffmpeg would
   *  (seek-dedup.integration.spec.ts's `fabricateRunPlaylist`, plus the
   *  ENDLIST switch this file needs — a copy-shape remux reaching the end
   *  of its input in one poll interval is the whole scenario). ATOMIC
   *  (temp + rename) because the poll loop may read it at any instant. */
  function fabricateRunPlaylist(
    sessionId: string,
    runIndex: number,
    segmentCount: number,
    firstSegmentIndex = 0,
    withEndlist = false,
  ): void {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:6", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT", '#EXT-X-MAP:URI="init.mp4"'];
    for (let i = 0; i < segmentCount; i += 1) {
      lines.push("#EXTINF:6.000000,");
      lines.push(`s${String(firstSegmentIndex + i).padStart(6, "0")}.m4s`);
    }
    if (withEndlist) lines.push("#EXT-X-ENDLIST");
    const runDir = join(stagingRoot, sessionId, `run${runIndex}`);
    const target = join(runDir, "media.m3u8");
    const tmp = `${target}.fabricate.tmp`;
    writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
    renameSync(tmp, target);
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

  /** The client's own progression, exactly as apps/server's segment GET
   *  records it (`updateRequestedSegment`) — the ONLY evidence the runtime
   *  has about where the viewer actually is. */
  async function recordViewerProgress(sessionId: string, requestedSegment: number): Promise<void> {
    await raw.query(`UPDATE playback_sessions SET requested_segment = $2, updated_at_ms = $3 WHERE id = $1`, [sessionId, requestedSegment, Date.now()]);
  }

  function readServedPlaylist(sessionId: string): string {
    return readFileSync(join(stagingRoot, sessionId, "media.m3u8"), "utf8");
  }

  /** The `#EXT-X-PROGRAM-DATE-TIME` emitted for one segment URI — the
   *  SOURCE position a client lands on when it plays that fragment
   *  (docs/PLAYBACK.md §9.1.5 rule 7: source time 0 IS the Unix epoch). */
  function pdtFor(playlist: string, uri: string): string | undefined {
    const lines = playlist.trimEnd().split("\n");
    const at = lines.indexOf(uri);
    if (at < 2) return undefined;
    return lines[at - 2]?.startsWith("#EXT-X-PROGRAM-DATE-TIME:") ? lines[at - 2] : undefined;
  }

  /** Blocks until the served playlist on disk satisfies `predicate` — the
   *  runner rewrites it once per poll tick, so a bare read straight after
   *  a fold is a genuine race. */
  async function waitForServedPlaylist(sessionId: string, predicate: (text: string) => boolean, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      try {
        last = readServedPlaylist(sessionId);
        if (predicate(last)) return last;
      } catch {
        /* not written yet */
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the served playlist; last read:\n${last}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it(
    "a FRESH MOUNT on a fast-completing encode can still play from 0:00",
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
          // The throttle is not under test here; a 30-segment fabricated
          // playlist would trip its suspend threshold on the first tick.
          suspendAheadThresholdOverride: 10_000,
          resumeAheadThresholdOverride: 5_000,
        },
        sessionId,
      );

      await waitForSpawnCount(1, 10_000 * TIME_SCALE);

      // The copy-shape shape: 30 segments (180s) AND `#EXT-X-ENDLIST` land
      // inside ONE poll interval, before the client has fetched anything at
      // all (requested_segment IS NULL). 180s of content against a 120s
      // retention window used to delete indices 0..9 on that very tick —
      // and then FREEZE the playlist that way (§9.1.5 rule 4), so the head
      // was unreachable for the rest of the session.
      fabricateRunPlaylist(sessionId, 0, 30, 0, true);
      await waitForProducedSegment(sessionId, 29, 15_000 * TIME_SCALE);

      const served = await waitForServedPlaylist(sessionId, (t) => t.includes("#EXT-X-ENDLIST"), 10_000 * TIME_SCALE);
      expect(served, "the head was pruned before the viewer had fetched a single segment").toContain("run0/s000000.m4s");
      expect(pdtFor(served, "run0/s000000.m4s"), "a fresh mount cannot start at 0:00").toBe(
        "#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:00.000Z",
      );

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  it(
    "'START OVER' lands at 0:00 — the restart's landing fragment survives until the client fetches it",
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

      // The viewer has genuinely watched up to s000028 (the server recorded
      // every segment GET), and run 0 has produced 180s — so retention MAY
      // now reclaim behind the viewer, and does.
      await recordViewerProgress(sessionId, 28);
      fabricateRunPlaylist(sessionId, 0, 30);
      await waitForProducedSegment(sessionId, 29, 15_000 * TIME_SCALE);

      // 'Start over': POST /playback/sessions/{id}/seek {targetMs: 0}.
      await requestSeek(db, ctx, sessionId, 0, Date.now());
      // The head of run 0 IS pruned by now, so position 0 is no longer on
      // disk: the seek must RESTART rather than be absorbed as "the live
      // run already serves that position".
      await waitForSpawnCount(2, 10_000 * TIME_SCALE);

      // run 1 starts at source origin 0 and, by forward-only numbering,
      // at segment index 30 (docs/PLAYBACK.md §9.1.10 item 4).
      fabricateRunPlaylist(sessionId, 1, 25, 30);
      await waitForProducedSegment(sessionId, 54, 15_000 * TIME_SCALE);

      const served = await waitForServedPlaylist(sessionId, (t) => t.includes("run1/"), 10_000 * TIME_SCALE);
      expect(served, "the landing fragment was pruned before the client could fetch it").toContain("run1/s000030.m4s");
      expect(pdtFor(served, "run1/s000030.m4s"), "'Start over' cannot reach 0:00").toBe(
        "#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:00.000Z",
      );
      // And retention still reclaims what the viewer left behind: run 0's
      // head (everything below its recorded progression) is gone.
      expect(served).not.toContain("run0/s000000.m4s");

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );
});
