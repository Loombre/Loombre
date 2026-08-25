// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/session.integration.spec.ts
//
// Session-integration-style test (not pure — REAL ffmpeg, real Postgres):
// runs the actual apps/worker/src/transcode/runner.ts state machine
// against a generated h264/aac mp4 fixture with a REAL transcode plan
// built via @loombre/playback-engine's plan() (a device that supports the
// source's h264 video verbatim but NOT its aac audio, forcing an
// audio-only transcode to opus — cheap on CPU, and decision==='transcode'
// exactly like this step's instructions require, so ffmpeg only ever
// COPIES video while re-encoding a tiny 2-channel audio stream).
//
// Mirrors apps/worker/test/probe/probe.integration.spec.ts's and
// apps/worker/test/hwcaps/real-battery.integration.spec.ts's skip-cleanly-
// without-ffmpeg convention, and apps/worker/test/scan/helpers.ts's
// self-sufficient live-DB reset convention.
//
// TEST-ONLY PACING (read this before touching timings): the throttle/seek
// scenarios need ffmpeg's encode to proceed over several real seconds so
// this suite can reliably observe MID-STREAM state (a suspend that
// actually catches the process still running, a seek that lands before
// natural EOF) — but this session's plan does video=COPY + a trivial
// 2-channel audio transcode, which on any real machine would blast through
// the whole 150s source in well under a second, giving no meaningful
// window to observe anything. Rather than accept flakiness (or slow the
// WHOLE suite down with `-re`/-readrate 1 real-time pacing, which would
// blow the ~90s budget), every session in this file is spawned with
// `testReadrateMultiplier` (runner.ts's dedicated test-only knob,
// documented in args.ts's header as ORTHOGONAL to the throttle MECHANISM
// under test) — this paces ffmpeg's own input read rate to a controlled,
// machine-independent multiple of realtime, purely so wall-clock timing in
// this file is deterministic. It does NOT change what is being verified:
// scenario (b) still relies on THIS runtime issuing a REAL SIGSTOP/SIGCONT
// on the actual ffmpeg process group (verified via `ps` state AND
// produced_segment stalling) — the mechanism under test is real; only the
// encode's own pacing is artificially slowed for reproducible timing.

import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, createPlaybackSession, endPlaybackSession, ensureTestDatabase, requestSeek, resolveTestDatabaseUrl, updateRequestedSegment } from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import { plan, type DeviceProfile, type MediaInfo, type NetworkConditions, type PlanInput, type ServerPolicy, type TrackSelection, type VerifiedCapabilities } from "@loombre/playback-engine";
import { runTranscodeSession } from "../../src/transcode/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const MEDIA_DIR = join(REPO_ROOT, "test-fixtures", "media");
const FIXTURE_PATH = join(MEDIA_DIR, "session_long.mp4");
const DB_PKG_ROOT = join(REPO_ROOT, "packages", "db");

// PER-SUITE DATABASE (Wave A / A1's recommendation, swept at pre-D
// consolidation). This suite RESETS the schema in its own hook; on the
// shared `<base>_test` database a sibling package's reset landing mid-run
// wipes it out from under whatever is executing and presents as a product
// bug. `ensureTestDatabase` gives it one of its own — resolved at module
// load (top-level await) so every describe-scope handle below is built
// against the right connection string.
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), "worker_session_test");

const ffmpegAvailable = ffmpegAvailableStrict();

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

interface RawSessionRow {
  id: string;
  status: string;
  error_code: string | null;
  staging_dir: string | null;
  requested_segment: number | null;
  produced_segment: number | null;
  seek_target_ms: number | null;
  discontinuity_count: number;
  suspended_by_throttle: boolean;
  stderr_tail: string | null;
}

/**
 * CI-runner time scaling (Phase 3 step 7 finding follow-up): macos-latest
 * runners (3-core, virtualized) missed the fixed 20s first-segment deadline
 * while ubuntu/windows passed and the same suite runs in ~2s locally on
 * real hardware. All waitFor deadlines and test timeouts multiply by
 * LOOMBRE_TEST_TIME_SCALE (default 1; ci.yml sets 3) — the assertions are
 * unchanged, only the patience.
 */
const TIME_SCALE = Math.max(1, Number(process.env["LOOMBRE_TEST_TIME_SCALE"] ?? "1") || 1);

async function waitFor<T>(
  fn: () => Promise<T | undefined | false | null>,
  opts: { timeoutMs: number; intervalMs?: number; label: string; diag?: () => Promise<string> },
): Promise<T> {
  const interval = opts.intervalMs ?? 200;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result as T;
    if (Date.now() > deadline) {
      // CI-runner forensics (macos-latest produced zero segments across two
      // runs while ubuntu passed and real macOS hardware passes locally):
      // when the caller provides a diag callback, its output rides the
      // timeout error so the runner log tells us WHY, not just "timed out".
      let diagText = "";
      if (opts.diag) {
        try {
          diagText = `\n--- diag ---\n${await opts.diag()}`;
        } catch (diagErr) {
          diagText = `\n--- diag failed: ${String(diagErr)} ---`;
        }
      }
      throw new Error(`waitFor timed out (${opts.label})${diagText}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Session-row + staging-dir forensic snapshot for waitFor's diag hook. */
async function sessionDiag(raw: { query: (q: string, p: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, sessionId: string): Promise<string> {
  const res = await raw.query(
    `SELECT status, error_code, staging_dir, produced_segment, requested_segment, suspended_by_throttle,
            left(stderr_tail, 1500) AS stderr_head
     FROM playback_sessions WHERE id = $1`,
    [sessionId],
  );
  const row = res.rows[0];
  let listing = "(no staging_dir)";
  const stagingDir = row?.["staging_dir"];
  if (typeof stagingDir === "string" && stagingDir.length > 0) {
    try {
      const { readdirSync } = await import("node:fs");
      const entries = readdirSync(stagingDir, { recursive: true }) as string[];
      listing = entries.length > 0 ? entries.join(", ") : "(staging dir empty)";
    } catch (err) {
      listing = `(listing failed: ${String(err)})`;
    }
  }
  return `row=${JSON.stringify(row)}\nstaging=${listing}`;
}

/** `ps -o state=` for a pid — 'T' means SIGSTOPped on macOS/Linux. Returns
 *  `undefined` if the process is gone or `ps` itself is unavailable
 *  (Windows — this helper is only ever consulted on POSIX in this file). */
function psState(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

describe.skipIf(!ffmpegAvailable)("transcode session runtime integration (real ffmpeg, real Postgres)", () => {
  /** Fail-safe cleanup (CI forensics, macos-latest cascade): a waitFor
   *  timeout throws PAST a scenario's own endPlaybackSession/await-runner
   *  tail, leaking that scenario's readrate-paced ffmpeg (up to ~25s of
   *  encode) into later scenarios — invisible on fast hardware, fatal CPU
   *  contention on a 3-core runner VM. Every spawned ffmpeg pid is
   *  collected here and afterEach force-ends every non-terminal session
   *  (the runner tears down on noticing) then SIGKILLs any survivor pid
   *  (SIGKILL works on SIGSTOPPed processes too). */
  const spawnedPids: number[] = [];

  let db: ReturnType<typeof createDb>;
  let raw: pg.Client;
  let stagingRoot: string;
  let ctx: ViewerContext;
  let deviceId: string;
  let itemId: string;
  let fileId: string;
  let badFileId: string;
  let storedPlan: Record<string, unknown>;

  beforeAll(async () => {
    execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
    expect(existsSync(FIXTURE_PATH)).toBe(true);

    resetSchema();
    db = createDb(DATABASE_URL);
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();

    const now = Date.now();
    const userRow = await raw.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
       VALUES ('transcode-int-test', 'transcode-int@loombre.local', 'x', $1, $1) RETURNING id`,
      [now],
    );
    const userId = userRow.rows[0]!.id;

    // Device profile forcing an AUDIO-ONLY transcode (aac unsupported, only
    // opus) while video (h264/High/8bit/320x240/25fps, matching the REAL
    // fixture exactly) passes every Stage-B check and stays 'copy' — keeps
    // ffmpeg's CPU cost trivial (video stream copy + tiny 2ch audio
    // encode) so this suite's wall-clock timing is dominated entirely by
    // the deliberate testReadrateMultiplier pacing, not raw encode work.
    const deviceProfile: DeviceProfile = {
      profileId: "integration-test-device",
      directPlayContainers: ["mp4"],
      hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
      video: [{ codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null }],
      hdr: { hdr10: false, hlg: false, dolbyVision: false },
      audio: [{ codec: "opus", maxChannels: 2, passthrough: false }],
      subtitles: { renderText: [], hlsVtt: true, renderImage: false },
      maxStreamBitrateBps: null,
    };

    const deviceRow = await raw.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'integration-test-device', $2, $3) RETURNING id`,
      [userId, JSON.stringify(deviceProfile), now],
    );
    deviceId = deviceRow.rows[0]!.id;

    const libRow = await raw.query<{ id: string }>(
      `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
       VALUES ('Transcode Integration Library', 'movie', '{}', $1, $1) RETURNING id`,
      [now],
    );
    const libraryId = libRow.rows[0]!.id;
    await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

    const itemRow = await raw.query<{ id: string }>(
      `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
       VALUES ($1, 'movie', 'Transcode Integration Movie', 'transcode integration movie', $2, $2) RETURNING id`,
      [libraryId, now],
    );
    itemId = itemRow.rows[0]!.id;

    const sizeBytes = statSync(FIXTURE_PATH).size;
    const fileRow = await raw.query<{ id: string }>(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
       VALUES ($1, $2, 'session-long-hash', $3, 'mp4', 150000, $4) RETURNING id`,
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

    // A second media_files row pointing at a NONEXISTENT path (scenario e).
    const badFileRow = await raw.query<{ id: string }>(
      `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
       VALUES ($1, '/nonexistent/does-not-exist.mp4', 'bad-hash', 1000, 'mp4', 150000, $2) RETURNING id`,
      [itemId, now],
    );
    badFileId = badFileRow.rows[0]!.id;

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
    expect(planResult.video.action).toBe("copy");
    expect(planResult.audio.action).toBe("transcode");
    expect(planResult.container).toBe("fmp4-hls");
    expect(planResult.ffmpegArgs.length).toBeGreaterThan(0);

    storedPlan = { ...planResult, selection };

    stagingRoot = mkdtempSync(join(tmpdir(), "loombre-transcode-integration-"));
  }, 60_000 * TIME_SCALE);

  afterAll(async () => {
    await db?.destroy();
    await raw?.end();
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  async function createSession(targetFileId: string): Promise<string> {
    const session = await createPlaybackSession(db, ctx, {
      itemId,
      fileId: targetFileId,
      deviceId,
      plan: storedPlan,
      engineVersion: "test",
      nowMs: Date.now(),
    });
    expect(session).toBeDefined();
    expect(session!.status).toBe("created"); // decision !== direct-play (this lane's fix)
    return session!.id;
  }

  async function readRow(sessionId: string): Promise<RawSessionRow> {
    const { rows } = await raw.query<RawSessionRow>(`SELECT * FROM playback_sessions WHERE id = $1`, [sessionId]);
    return rows[0]!;
  }

  afterEach(async () => {
    await raw.query(
      `UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1
       WHERE status NOT IN ('ended', 'failed')`,
      [Date.now()],
    );
    await new Promise((r) => setTimeout(r, 1_500));
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone — the normal case.
      }
    }
  });

  it("(a) start: init.mp4 + first segment appear within a deadline, produced_segment advances, session goes active", async () => {
    const sessionId = await createSession(fileId);
    const runPromise = runTranscodeSession({ db, stagingRoot, testReadrateMultiplier: 6, onRunSpawned: (pid) => spawnedPids.push(pid) }, sessionId);

    const row = await waitFor(
      async () => {
        const r = await readRow(sessionId);
        return r.status === "active" && r.produced_segment !== null ? r : undefined;
      },
      { timeoutMs: 20_000 * TIME_SCALE, label: "first segment produced", diag: () => sessionDiag(raw, sessionId) },
    );
    expect(row.produced_segment).toBeGreaterThanOrEqual(0);
    expect(row.staging_dir).toBeTruthy();

    const run0Dir = join(row.staging_dir!, "run0");
    expect(existsSync(join(run0Dir, "init.mp4"))).toBe(true);
    expect(existsSync(join(run0Dir, "s000000.m4s"))).toBe(true);

    // The DB row flips to active BEFORE the loop's served-playlist rewrite,
    // so the playlist is a separately-observable side effect — poll for it
    // rather than assuming it exists the instant the row lands (the same
    // thing apps/server's hls-file.controller.ts does before serving it).
    // The runner now writes it atomically, so any content observed here is
    // COMPLETE; this wait is about ordering, not tearing. Assertions below
    // are unchanged.
    const servedPlaylist = await waitFor(
      async () => {
        let text = "";
        try {
          text = readFileSync(join(row.staging_dir!, "media.m3u8"), "utf8");
        } catch {
          return undefined; // not written yet
        }
        return text.includes("#EXTM3U") ? text : undefined;
      },
      { timeoutMs: 10_000 * TIME_SCALE, label: "served playlist written", diag: () => sessionDiag(raw, sessionId) },
    );
    expect(servedPlaylist).toContain("#EXTM3U");
    expect(servedPlaylist).toContain("run0/s000000.m4s");

    await endPlaybackSession(db, ctx, sessionId, Date.now());
    await runPromise;
    expect(existsSync(row.staging_dir!)).toBe(false);
  }, 30_000 * TIME_SCALE);

  it(
    "(b) throttle: requested_segment pinned low -> produced races ahead -> SIGSTOP observed (real ps state + produced_segment stall); bump requested -> resumes",
    { timeout: 60_000 * TIME_SCALE },
    async () => {
      if (process.platform === "win32") return; // P3.8: win32 uses -readrate pacing, never SIGSTOP (throttle.ts header)

      const sessionId = await createSession(fileId);
      let capturedPid: number | undefined;
      const runPromise = runTranscodeSession(
        { db, stagingRoot, testReadrateMultiplier: 6, onRunSpawned: (pid) => { spawnedPids.push(pid); capturedPid = pid; } },
        sessionId,
      );

      // requested_segment stays NULL (treated as 0) the whole time until we
      // bump it below — the throttle should suspend once produced races
      // past ahead > 10.
      const suspendedRow = await waitFor(
        async () => {
          const r = await readRow(sessionId);
          return r.status === "suspended" && r.suspended_by_throttle ? r : undefined;
        },
        { timeoutMs: 30_000 * TIME_SCALE, label: "throttle suspend", diag: () => sessionDiag(raw, sessionId) },
      );
      expect(suspendedRow.produced_segment).toBeGreaterThan(10);

      expect(capturedPid).toBeDefined();
      // Real OS-level verification: the process is actually SIGSTOPped.
      const state = psState(capturedPid!);
      expect(state, "expected ps state to show a stopped process (T)").toContain("T");

      // produced_segment genuinely stalls while suspended (second
      // independent verification method, both explicitly sanctioned by
      // this step's instructions).
      const stalledValue = suspendedRow.produced_segment;
      await new Promise((r) => setTimeout(r, 1500));
      const stillStalled = await readRow(sessionId);
      expect(stillStalled.produced_segment).toBe(stalledValue);
      expect(stillStalled.status).toBe("suspended");

      // Bump requested_segment well past produced -> ahead drops to <= 5 -> resume.
      await updateRequestedSegment(db, ctx, sessionId, stalledValue! + 5, Date.now());

      const resumedRow = await waitFor(
        async () => {
          const r = await readRow(sessionId);
          return r.status === "active" && !r.suspended_by_throttle ? r : undefined;
        },
        { timeoutMs: 10_000 * TIME_SCALE, label: "throttle resume" },
      );
      expect(psState(capturedPid!)).not.toContain("T");

      // Prove it's REALLY running again: produced_segment keeps climbing.
      await waitFor(
        async () => {
          const r = await readRow(sessionId);
          return r.produced_segment! > resumedRow.produced_segment! ? r : undefined;
        },
        { timeoutMs: 10_000 * TIME_SCALE, label: "produced_segment advances again after resume" },
      );

      await endPlaybackSession(db, ctx, sessionId, Date.now());
      await runPromise;
    },
  );

  it("(c) seek outside produced range: restart with continued numbering + discontinuity + old segments preserved", async () => {
    const sessionId = await createSession(fileId);
    const runPromise = runTranscodeSession({ db, stagingRoot, testReadrateMultiplier: 10, onRunSpawned: (pid) => spawnedPids.push(pid) }, sessionId);

    const firstRow = await waitFor(
      async () => {
        const r = await readRow(sessionId);
        return r.status === "active" && r.produced_segment !== null ? r : undefined;
      },
      { timeoutMs: 20_000 * TIME_SCALE, label: "first segment before seek", diag: () => sessionDiag(raw, sessionId) },
    );
    const beforeSeekProduced = firstRow.produced_segment!;
    const run0SegmentsBefore = readdirSync(join(firstRow.staging_dir!, "run0")).filter((f) => f.endsWith(".m4s"));
    expect(run0SegmentsBefore.length).toBeGreaterThan(0);

    // 100s into a 150s source — well outside the couple of segments
    // produced so far (a few seconds of content at this point).
    await requestSeek(db, ctx, sessionId, 100_000, Date.now());

    const afterSeekRow = await waitFor(
      async () => {
        const r = await readRow(sessionId);
        return r.discontinuity_count === 1 && r.status === "active" && r.produced_segment! > beforeSeekProduced ? r : undefined;
      },
      { timeoutMs: 20_000 * TIME_SCALE, label: "seek-restart produces a segment past the old produced index" },
    );

    // Numbering CONTINUES (binding constraint 5): run1's first segment is
    // exactly beforeSeekProduced + 1, never renumbered from 0 and never
    // jumping straight to a value derived from the seek target itself.
    const run1Segments = readdirSync(join(afterSeekRow.staging_dir!, "run1"))
      .filter((f) => f.endsWith(".m4s"))
      .sort();
    expect(run1Segments.length).toBeGreaterThan(0);
    const firstRun1Index = Number.parseInt(run1Segments[0]!.match(/^s(\d+)\.m4s$/)![1]!, 10);
    expect(firstRun1Index).toBe(beforeSeekProduced + 1);

    // Old run0 segments are still on disk — well under the 120s retention
    // window at this scale, nothing should have been pruned.
    expect(existsSync(join(afterSeekRow.staging_dir!, "run0"))).toBe(true);
    for (const f of run0SegmentsBefore) {
      expect(existsSync(join(afterSeekRow.staging_dir!, "run0", f))).toBe(true);
    }

    // The SERVED playlist carries the discontinuity + run-relative URIs
    // for both runs. Same ordering caveat as scenario (a): the DB row
    // flips (produced_segment/discontinuity_count) BEFORE the loop
    // iteration's served-playlist rewrite, so the file is a separately-
    // observable side effect — poll for its content rather than assuming
    // it's already landed the instant afterSeekRow's DB condition matches
    // (readFileSync here in a single shot was racy: it could still catch
    // an EARLIER run0-only snapshot from before the seek-restart's fold).
    const served = await waitFor(
      async () => {
        let text = "";
        try {
          text = readFileSync(join(afterSeekRow.staging_dir!, "media.m3u8"), "utf8");
        } catch {
          return undefined; // not written yet
        }
        return text.includes("#EXT-X-DISCONTINUITY") ? text : undefined;
      },
      { timeoutMs: 10_000 * TIME_SCALE, label: "served playlist reflects seek-restart discontinuity", diag: () => sessionDiag(raw, sessionId) },
    );
    expect(served).toContain("#EXT-X-DISCONTINUITY");
    expect(served).toContain(`run1/${run1Segments[0]}`);
    expect(served).toContain(`run0/${run0SegmentsBefore[0]}`);

    await endPlaybackSession(db, ctx, sessionId, Date.now());
    await runPromise;
    expect(existsSync(afterSeekRow.staging_dir!)).toBe(false);
  }, 40_000 * TIME_SCALE);

  it("(d) teardown: marking the row ended kills the ffmpeg process and deletes the staging dir", async () => {
    const sessionId = await createSession(fileId);
    let capturedPid: number | undefined;
    const runPromise = runTranscodeSession(
      { db, stagingRoot, testReadrateMultiplier: 6, onRunSpawned: (pid) => { spawnedPids.push(pid); capturedPid = pid; } },
      sessionId,
    );

    const row = await waitFor(
      async () => {
        const r = await readRow(sessionId);
        return r.status === "active" && r.produced_segment !== null ? r : undefined;
      },
      { timeoutMs: 20_000 * TIME_SCALE, label: "session active before teardown" },
    );
    expect(capturedPid).toBeDefined();

    // Simulate Lane B's DELETE /playback/sessions/{id} (existing,
    // unmodified endPlaybackSession — this lane must not double-emit
    // playback.ended, verified by this call itself only ever firing once).
    await endPlaybackSession(db, ctx, sessionId, Date.now());

    await runPromise; // resolves once THIS runtime notices status='ended' and tears down.

    expect(existsSync(row.staging_dir!)).toBe(false);
    // The real ffmpeg process is actually gone (POSIX: signaling an absent
    // pid throws ESRCH).
    if (process.platform !== "win32") {
      expect(() => process.kill(capturedPid!, 0)).toThrow();
    }
  }, 30_000 * TIME_SCALE);

  it("(e) failure: a session whose file path does not exist fails with stderr_tail populated and tears its dir down", async () => {
    const sessionId = await createSession(badFileId);
    await runTranscodeSession({ db, stagingRoot, testReadrateMultiplier: 6, onRunSpawned: (pid) => spawnedPids.push(pid) }, sessionId);

    const row = await readRow(sessionId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("transcode-failed");
    expect(row.stderr_tail).toBeTruthy();
    expect(row.stderr_tail!.length).toBeGreaterThan(0);
    if (row.staging_dir) {
      expect(existsSync(row.staging_dir)).toBe(false);
    }
  }, 20_000 * TIME_SCALE);

  // ── d4-f1 (QA backlog #103, P4): NO PRODUCE-AHEAD CAP ON A COPY SHAPE ──
  //
  // This suite's own header has stated the defect as a testing inconvenience
  // since it was written: "this session's plan does video=COPY + a trivial
  // 2-channel audio transcode, which on any real machine would blast through
  // the whole 150s source in well under a second". In production that is a
  // Tier-0 disk hazard, not an inconvenience. The segment-ahead throttle
  // reacts at POLL granularity (250ms) and so cannot bound a run that
  // finishes inside one tick; and since d3-f1 floored retention on viewer
  // evidence, the whole staged file survives until the viewer walks past it
  // (or the session is torn down) rather than being trimmed to the last
  // 120s. The cap therefore has to live inside ffmpeg: `-readrate` with an
  // `-readrate_initial_burst` big enough that startup and seek-discovery
  // are untouched.
  //
  // NOTE the deliberate absence of `testReadrateMultiplier` here: the whole
  // point is that the PRODUCTION path paces itself. The env vars are
  // config.ts's real escape hatch, turned down so the test observes in
  // seconds what the shipped defaults express in minutes.
  it(
    "(f) d4-f1: a copy-shape remux is produce-ahead capped — the whole file does not land inside one poll interval",
    { timeout: 90_000 * TIME_SCALE },
    async () => {
      vi.stubEnv("LOOMBRE_TRANSCODE_COPY_READRATE", "10");
      vi.stubEnv("LOOMBRE_TRANSCODE_COPY_READRATE_BURST_SEC", "12");
      try {
        const sessionId = await createSession(fileId);
        const runPromise = runTranscodeSession(
          {
            db,
            stagingRoot,
            pollIntervalMs: 100,
            // The throttle is explicitly NOT what is under test: it acts a
            // whole poll tick too late for this shape, which IS the finding.
            suspendAheadThresholdOverride: 100_000,
            resumeAheadThresholdOverride: 50_000,
            onRunSpawned: (pid) => spawnedPids.push(pid),
          },
          sessionId,
        );

        // The burst is what keeps startup instant — the first segment must
        // still appear on the ordinary deadline, not after a paced 6s.
        await waitFor(
          async () => {
            const r = await readRow(sessionId);
            return r.status === "active" && r.produced_segment !== null ? r : undefined;
          },
          { timeoutMs: 20_000 * TIME_SCALE, label: "first segment produced under the cap", diag: () => sessionDiag(raw, sessionId) },
        );

        // The cap is REALLY on the spawned process, in the global options
        // position — the same place `ps -axo args` is inspected by
        // .remediation/v8-qual.sh, and the same place win32's P3.8 pacing
        // has always gone, so it cannot disturb the `-noaccurate_seek -ss`
        // adjacency that check greps for.
        if (process.platform !== "win32") {
          const argv = execFileSync("ps", ["-o", "args=", "-p", String(spawnedPids[0])], { encoding: "utf8" });
          expect(argv).toContain("-readrate 10 -readrate_initial_burst 12");
        }

        // Fixed, NOT time-scaled: the cap is enforced against ffmpeg's own
        // wall clock, so what it admits in two seconds is the same on a
        // 3-core runner VM as on real hardware. 12s burst + ~2s x 10 = ~32s
        // of the fixture's 150s, a handful of its 15 keyframe-aligned
        // segments — against a final index of 14, which is what an uncapped
        // run reaches before the FIRST poll tick even fires.
        await new Promise((r) => setTimeout(r, 2_000));
        const capped = await readRow(sessionId);
        expect(
          capped.produced_segment,
          "the whole 150s file was staged — a copy-shape remux is not produce-ahead capped",
        ).toBeLessThan(8);

        // ...and it is a CAP, not a stall: production keeps moving.
        await new Promise((r) => setTimeout(r, 2_000));
        const later = await readRow(sessionId);
        expect(later.produced_segment!, "the cap stalled production instead of pacing it").toBeGreaterThan(
          capped.produced_segment!,
        );

        await endPlaybackSession(db, ctx, sessionId, Date.now());
        await runPromise;
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
