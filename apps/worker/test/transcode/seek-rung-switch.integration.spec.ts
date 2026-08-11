// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/seek-rung-switch.integration.spec.ts
//
// Wave C2 — the §9.1.7 NAMED BUILD SCENARIO, against a REAL ffmpeg, a REAL
// Postgres, and the REAL OS process table. It is the C3 triple-seek proof
// extended by one rung switch:
//
//     forward seek -> backward seek -> RUNG SWITCH -> forward seek
//
// producing runs 0-4, where run 2's origin is EARLIER than run 1's (the
// existing backward-seek pin), run 3 is a SWITCH run whose origin equals
// run 2's origin + produced extent EXACTLY, and run 4 seeks within the new
// rung.
//
// WHY REAL PROCESSES ARE THE POINT HERE. LD-16 says "a quality change hands
// the existing slot from one rung to another — it never starts an
// additional unrestricted transcode". The design makes that structural
// (terminate -> observed exit -> spawn, one code path), but "structural"
// is a claim about code, and the claim worth making is about the machine:
// at every instant this session has at most ONE live ffmpeg. So a sampler
// polls `ps` for every pid the runner ever spawned, throughout the whole
// scenario, and the assertion is on what the OS reported — never on this
// runtime's own bookkeeping.
//
// The other thing only a real run can prove is the handoff ORIGIN.
// `old.sourceOriginMs + old.producedMs` is exact only because `producedMs`
// is summed from ffmpeg's OWN per-run playlist, which §6 keeps
// append-only. A fake process cannot produce that file, and an arithmetic
// stand-in for it would be assuming the very thing under test.
//
// Skips cleanly without ffmpeg, same convention as
// lifecycle.integration.spec.ts (and the same LOOMBRE_REQUIRE_FFMPEG hard
// failure on CI).

import { ffmpegAvailableStrict } from "../support/require-ffmpeg.js";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  countActiveTranscodeSessions,
  createPlaybackSession,
  ensureTestDatabase,
  getTranscodeRunForSegment,
  listTranscodeRuns,
  requestRungSwitch,
  requestSeek,
  resolveTestDatabaseUrl,
} from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import {
  plan,
  type DeviceProfile,
  type MediaInfo,
  type NetworkConditions,
  type PlanInput,
  type ServerPolicy,
  type TrackSelection,
  type VerifiedCapabilities,
} from "@loombre/playback-engine";
import { resolveFfmpeg } from "../../src/probe/ffprobe.js";
import { runTranscodeSession } from "../../src/transcode/runner.js";
import { terminateAllTranscodeRuns } from "../../src/transcode/run-registry.js";
import {
  deriveSegmentStartMs,
  parseServedSegmentDurations,
  presentationToSourceMs,
} from "../../../../apps/server/src/common/served-playlist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-media-fixtures.mjs");
const FIXTURE_PATH = join(REPO_ROOT, "test-fixtures", "media", "session_long.mp4");
const DB_PKG_ROOT = join(REPO_ROOT, "packages", "db");

// An ISOLATED per-suite database, for the same reason lifecycle.
// integration.spec.ts takes one: this suite resets the schema and then runs
// real ffmpeg for tens of seconds while asserting against rows the whole
// time, and a sibling suite's `reset` landing mid-run would wipe the schema
// out from under it and present as a product bug.
let DATABASE_URL: string;
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

/** True iff the OS still has this pid as a RUNNING (or throttle-STOPPED)
 *  process. `ps`, never this runtime's own state — independent
 *  verification is the whole point. A 'Z' is NOT alive: a zombie holds no
 *  CPU and no memory, and only appears here because these processes are
 *  children of the test process. A 'T' (SIGSTOPped by the segment-ahead
 *  throttle) very much IS alive and must count. */
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
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * THE PROCESS CENSUS (§9.1.4's "build must pin it"). Samples the real OS
 * process table for every pid this session ever spawned, on a tight
 * interval, for the whole scenario — and records the maximum number found
 * alive AT THE SAME INSTANT. LD-16's structural claim is exactly that this
 * maximum is 1.
 */
class ProcessCensus {
  readonly pids: number[] = [];
  max = 0;
  samples = 0;
  private timer: NodeJS.Timeout | undefined;

  track(pid: number | undefined): void {
    if (pid !== undefined) this.pids.push(pid);
  }

  start(intervalMs = 25): void {
    this.timer = setInterval(() => {
      const alive = this.pids.filter((pid) => pidAlive(pid)).length;
      this.samples += 1;
      if (alive > this.max) this.max = alive;
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

describe.skipIf(!ffmpegAvailable || process.platform === "win32")(
  "seek x rung-switch integration (§9.1.7 named scenario; real ffmpeg, real Postgres, real process table)",
  () => {
    let db: ReturnType<typeof createDb>;
    let raw: pg.Client;
    let stagingRoot: string;
    let ctx: ViewerContext;
    let deviceId: string;
    let itemId: string;
    let fileId: string;
    let storedPlan: Record<string, unknown>;

    const strayPids: number[] = [];

    beforeAll(async () => {
      execFileSync(process.execPath, [GEN_SCRIPT], { stdio: "inherit" });
      const resolved = resolveFfmpeg();
      if (!resolved.ok) throw new Error("ffmpeg unresolvable after the availability gate said otherwise");

      DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), "worker_rung_switch_test");
      resetSchema();
      db = createDb(DATABASE_URL);
      raw = new pg.Client({ connectionString: DATABASE_URL });
      await raw.connect();

      const now = Date.now();
      const userRow = await raw.query<{ id: string }>(
        `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
         VALUES ('rung-switch-test', 'rung-switch@loombre.local', 'x', $1, $1) RETURNING id`,
        [now],
      );
      const userId = userRow.rows[0]!.id;

      // A device that forces a real VIDEO transcode — the frame-rate cap
      // alone (source 25fps, device 20) — while leaving audio a plain copy.
      // A video transcode is what makes a rung MEAN anything: the ladder
      // below is what the master advertises and what a switch switches
      // between. The source is 320x240, so even the top rung is a trivial
      // encode.
      const deviceProfile: DeviceProfile = {
        profileId: "rung-switch-device",
        directPlayContainers: ["mp4"],
        hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
        video: [
          {
            codec: "h264",
            maxProfile: "high",
            maxLevel: null,
            maxBitDepth: 8,
            maxWidth: 1920,
            maxHeight: 1080,
            maxFrameRate: 20,
            maxBitrateBps: null,
          },
        ],
        hdr: { hdr10: false, hlg: false, dolbyVision: false },
        audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
        subtitles: { renderText: [], hlsVtt: true, renderImage: false },
        maxStreamBitrateBps: null,
      };
      const deviceRow = await raw.query<{ id: string }>(
        `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'rung-switch-device', $2, $3) RETURNING id`,
        [userId, JSON.stringify(deviceProfile), now],
      );
      deviceId = deviceRow.rows[0]!.id;

      const libRow = await raw.query<{ id: string }>(
        `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
         VALUES ('Rung Switch Library', 'movie', '{}', $1, $1) RETURNING id`,
        [now],
      );
      const libraryId = libRow.rows[0]!.id;
      await raw.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [userId, libraryId, now]);

      const itemRow = await raw.query<{ id: string }>(
        `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
         VALUES ($1, 'movie', 'Rung Switch Movie', 'rung switch movie', $2, $2) RETURNING id`,
        [libraryId, now],
      );
      itemId = itemRow.rows[0]!.id;

      const sizeBytes = statSync(FIXTURE_PATH).size;
      const fileRow = await raw.query<{ id: string }>(
        `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
         VALUES ($1, $2, 'rung-switch-hash', $3, 'mp4', 150000, $4) RETURNING id`,
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
        overallBitrateBps: 1_200_000,
        video: [
          {
            index: 0,
            codec: "h264",
            profile: "high",
            level: null,
            width: 320,
            height: 240,
            bitDepth: 8,
            frameRate: 25,
            bitrateBps: 1_000_000,
            hdr: "none",
            dvProfile: null,
            dvBlCompatId: null,
            interlaced: false,
            openGop: false,
          },
        ],
        audio: [{ index: 1, codec: "aac", channels: 2, sampleRate: 48000, bitrateBps: 128_000, language: null, isDefault: true, hasAtmos: false }],
        subtitle: [],
      };
      const selection: TrackSelection = { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null };
      const network: NetworkConditions = { maxBitrateBps: 100_000_000, isLocal: true };
      // A THREE-rung ladder, deliberately at the Tier-0 advertised-variant
      // cap (§7.5) so nothing is trimmed and rung index K really is what
      // the master publishes at v{K}. All three sit under the 240p source
      // height and the 1 Mbps source bitrate, so all three survive
      // construction.
      const policy: ServerPolicy = {
        allowTranscode: true,
        allowToneMapCpu: "tier-gated",
        tier: 0,
        preferredTextSubMode: "hls-vtt",
        preserveAssStyling: false,
        audioTranscodeCodecPriority: ["aac", "opus"],
        maxSimultaneousTranscodes: 1,
        ladderRungs: [
          { heightPx: 240, videoBitrateBps: 600_000, audioBitrateBps: 128_000, codec: "h264" },
          { heightPx: 180, videoBitrateBps: 300_000, audioBitrateBps: 128_000, codec: "h264" },
          { heightPx: 120, videoBitrateBps: 150_000, audioBitrateBps: 128_000, codec: "h264" },
        ],
        segmentDurationSec: 6,
        hevcEncodePreferred: false,
        av1EncodePreferred: false,
      };
      const caps: VerifiedCapabilities = { backends: [] };
      const input: PlanInput = { media, device: deviceProfile, network, policy, caps, selection, mode: "stream" };
      const planResult = plan(input);
      expect(planResult.decision).toBe("transcode");
      expect(planResult.video.action).toBe("transcode");
      // The cap is a no-op at exactly 3 rungs — the ladder the master
      // advertises, and the index space a v{K} request addresses.
      expect(planResult.ladder).toHaveLength(3);
      expect(planResult.reasons.map((r) => r.code)).not.toContain("ladder-variant-capped");
      storedPlan = { ...planResult, selection };

      stagingRoot = mkdtempSync(join(tmpdir(), "loombre-rung-switch-"));
    }, 120_000 * TIME_SCALE);

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

    async function runCount(sessionId: string): Promise<number> {
      const { rows } = await raw.query<{ n: string }>(`SELECT count(*) AS n FROM transcode_runs WHERE session_id = $1`, [sessionId]);
      return Number(rows[0]!.n);
    }

    async function waitForRunCount(sessionId: string, n: number, label: string): Promise<void> {
      await waitFor(async () => (await runCount(sessionId)) >= n, { timeoutMs: 60_000 * TIME_SCALE, label });
    }

    /** A run has produced when at least one of ITS segments is in the
     *  served playlist — the only honest "the handoff origin is now
     *  meaningful" signal. */
    async function waitForRunProduced(sessionDir: string, runIndex: number, label: string): Promise<void> {
      await waitFor(
        () => {
          try {
            const text = readFileSync(join(sessionDir, "media.m3u8"), "utf8");
            return parseServedSegmentDurations(text).some((e) => e.runIndex === runIndex);
          } catch {
            return false;
          }
        },
        { timeoutMs: 60_000 * TIME_SCALE, label },
      );
    }

    it(
      "seek -> backward seek -> RUNG SWITCH -> seek: runs 0-4, exact origins, <=1 live ffmpeg at every sampled instant",
      { timeout: 300_000 * TIME_SCALE },
      async () => {
        const sessionId = await createSession();
        const sessionDir = join(stagingRoot, sessionId);
        const census = new ProcessCensus();

        const runPromise = runTranscodeSession(
          {
            db,
            stagingRoot,
            pollIntervalMs: 150,
            // Pace the encode so a run does not consume the whole 150 s
            // fixture before the next control write lands — this is the
            // same test-only aid session.integration.spec.ts uses, and it
            // is orthogonal to everything under test here.
            testReadrateMultiplier: 6,
            onRunSpawned: (pid) => {
              census.track(pid);
              if (pid !== undefined) strayPids.push(pid);
            },
          },
          sessionId,
        );
        census.start();

        try {
          // ── run 0 ──────────────────────────────────────────────────────
          await waitForRunProduced(sessionDir, 0, "run 0 produced");

          // ── run 1: forward seek ────────────────────────────────────────
          await requestSeek(db, ctx, sessionId, 60_000, Date.now());
          await waitForRunCount(sessionId, 2, "run 1 recorded");
          await waitForRunProduced(sessionDir, 1, "run 1 produced");

          // ── run 2: BACKWARD seek (origin EARLIER than run 1's) ─────────
          await requestSeek(db, ctx, sessionId, 12_000, Date.now());
          await waitForRunCount(sessionId, 3, "run 2 recorded");
          await waitForRunProduced(sessionDir, 2, "run 2 produced");

          // Snapshot run 2's produced extent from ffmpeg's OWN per-run
          // playlist, which is what the handoff origin is computed from.
          // Taken BEFORE the switch is requested so the arithmetic below is
          // a prediction, not a restatement.
          await waitFor(
            () => {
              try {
                return readFileSync(join(sessionDir, "run2", "media.m3u8"), "utf8").includes("#EXTINF");
              } catch {
                return false;
              }
            },
            { timeoutMs: 30_000 * TIME_SCALE, label: "run 2 per-run playlist" },
          );

          // ── run 3: THE RUNG SWITCH ─────────────────────────────────────
          const beforeSwitch = await runCount(sessionId);
          await requestRungSwitch(db, ctx, sessionId, 2, Date.now());
          await waitForRunCount(sessionId, beforeSwitch + 1, "run 3 (switch) recorded");
          await waitForRunProduced(sessionDir, 3, "run 3 produced");

          // ── run 4: a further seek, still on the NEW rung ───────────────
          // Deliberately BACKWARD of the switch run's own origin: a target
          // inside `[origin, origin + produced]` is legitimately ABSORBED
          // (the live run is already serving those bytes), and this test is
          // about the restart, not about re-proving absorption.
          await requestSeek(db, ctx, sessionId, 5_000, Date.now());
          await waitForRunCount(sessionId, 5, "run 4 recorded");
          await waitForRunProduced(sessionDir, 4, "run 4 produced");

          const runs = await listTranscodeRuns(db, sessionId);
          expect(runs.map((r) => r.runIndex)).toEqual([0, 1, 2, 3, 4]);

          // Segment numbering is ONE global counter across every run —
          // start_segment is the only monotonic key, and it is what makes
          // ownership total and non-overlapping under ABR.
          for (let i = 1; i < runs.length; i += 1) {
            expect(runs[i]!.startSegment, `run ${i} start_segment`).toBeGreaterThan(runs[i - 1]!.startSegment);
          }

          // Source origins are NOT monotonic: run 2 is a backward seek.
          expect(runs[1]!.sourceOriginMs).toBe(60_000);
          expect(runs[2]!.sourceOriginMs).toBe(12_000);
          expect(runs[2]!.sourceOriginMs).toBeLessThan(runs[1]!.sourceOriginMs);

          // ── THE SWITCH ORIGIN, EXACTLY (§9.1.4 step 3) ────────────────
          //
          // originB = old.sourceOriginMs + old.producedMs, and `producedMs`
          // is summed from run 2's OWN ffmpeg playlist — which §6 keeps
          // `-hls_playlist_type event`, i.e. APPEND-ONLY, precisely so this
          // sum stays the run's true produced extent even after retention
          // has pruned the SERVED playlist's head.
          //
          // The exact statement is therefore "the origin lands on one of
          // run 2's own segment boundaries", not "on the last one": the
          // runner reads `producedMs` at the top of a poll tick and
          // terminates within that same tick, so ffmpeg may flush one more
          // segment in between. Which boundary it is depends on wall-clock
          // timing; THAT it is a boundary — a real produced instant, never
          // nominal `index x 6000` arithmetic — is the property, and it is
          // the one that makes presentation time continuous across the
          // switch discontinuity.
          const run2ExtinfMs = readFileSync(join(sessionDir, "run2", "media.m3u8"), "utf8")
            .split(/\r?\n/)
            .filter((l) => l.startsWith("#EXTINF"))
            .map((l) => Number.parseFloat(/^#EXTINF:([0-9.]+),/.exec(l)![1]!) * 1000);
          const boundariesMs: number[] = [];
          let cumulative = 0;
          for (const ms of run2ExtinfMs) {
            cumulative += ms;
            boundariesMs.push(Math.round(cumulative));
          }
          const observedOffsetMs = runs[3]!.sourceOriginMs - runs[2]!.sourceOriginMs;
          expect(
            boundariesMs,
            `handoff origin offset ${observedOffsetMs}ms must be an EXACT segment boundary of run 2's own playlist`,
          ).toContain(observedOffsetMs);
          // A switch CONTINUES the timeline — it never rewinds it, and it
          // never lands past what the old run actually produced.
          expect(runs[3]!.sourceOriginMs).toBeGreaterThan(runs[2]!.sourceOriginMs);
          expect(observedOffsetMs).toBeLessThanOrEqual(boundariesMs[boundariesMs.length - 1]!);

          // The run rows record WHICH rung each run encoded (migration 0044).
          const { rows: rungRows } = await raw.query<{ run_index: number; ladder_rung_index: number | null }>(
            `SELECT run_index, ladder_rung_index FROM transcode_runs WHERE session_id = $1 ORDER BY run_index`,
            [sessionId],
          );
          expect(rungRows.map((r) => r.ladder_rung_index)).toEqual([0, 0, 0, 2, 2]);
          // The session row names the rung that is REALLY running, which is
          // what makes the server's `v{K}` comparison meaningful.
          const { rows: activeRows } = await raw.query<{ active_rung_index: number | null }>(
            `SELECT active_rung_index FROM playback_sessions WHERE id = $1`,
            [sessionId],
          );
          expect(activeRows[0]!.active_rung_index).toBe(2);

          // ── per-run derivation is exact INSIDE every run ───────────────
          const entries = parseServedSegmentDurations(readFileSync(join(sessionDir, "media.m3u8"), "utf8"));
          for (const run of runs) {
            const own = entries.filter((e) => e.runIndex === run.runIndex);
            if (own.length === 0) continue; // retention pruned it away entirely
            const probe = own[0]!;
            expect(
              deriveSegmentStartMs(entries, probe.index, 6000, run),
              `run ${run.runIndex}: first own segment starts AT the run origin`,
            ).toBe(run.sourceOriginMs);
          }

          // ── getTranscodeRunForSegment resolves the SWITCH run at its
          //    boundary, not its predecessor ───────────────────────────────
          const switchRun = runs[3]!;
          const atBoundary = await getTranscodeRunForSegment(db, sessionId, switchRun.startSegment);
          expect(atBoundary?.runIndex).toBe(3);
          const justBefore = await getTranscodeRunForSegment(db, sessionId, switchRun.startSegment - 1);
          expect(justBefore?.runIndex).toBe(2);

          // ── EXTENT RULE (§9.1.3): the two permitted derivations agree ──
          // (a) the served playlist's own runN/ prefix vs (b) the NEXT
          // run's start_segment - 1. A consumer that used the FORBIDDEN
          // one-row `index >= start_segment` derivation would sweep in
          // every later run — including this switch run, which is a
          // different rung entirely.
          for (let i = 0; i < runs.length - 1; i += 1) {
            const byPrefix = entries.filter((e) => e.runIndex === runs[i]!.runIndex).map((e) => e.index);
            if (byPrefix.length === 0) continue;
            const upperByNextStart = runs[i + 1]!.startSegment - 1;
            expect(Math.max(...byPrefix), `run ${i} extent by prefix vs by next start`).toBeLessThanOrEqual(upperByNextStart);
          }

          // ── progress mapping is switch-correct with ZERO new code ──────
          // presentationToSourceMs walks the union playlist to find the
          // containing segment, then re-expresses it in that segment's OWN
          // run. Its within-run 1:1 rate argument is rung-independent —
          // re-encoding at a different bitrate/height never changes the
          // time rate — so a position inside the switch run maps into that
          // run's own source window and nowhere else.
          const switchEntries = entries.filter((e) => e.runIndex === 3);
          if (switchEntries.length > 0) {
            let presentationMs = 0;
            for (const e of entries) {
              if (e.index === switchEntries[0]!.index) break;
              presentationMs += e.durationMs;
            }
            const mapped = presentationToSourceMs(entries, runs, presentationMs + 100);
            expect(mapped).toBeDefined();
            expect(mapped!).toBeGreaterThanOrEqual(switchRun.sourceOriginMs);
            expect(mapped!).toBeLessThan(switchRun.sourceOriginMs + 60_000);
          }

          // ── THE CENSUS ────────────────────────────────────────────────
          expect(census.samples, "the census must actually have sampled").toBeGreaterThan(20);
          expect(census.pids.length, "five runs were spawned").toBe(5);
          expect(
            census.max,
            "LD-16: at every instant a session has AT MOST ONE live ffmpeg — a handoff is a restart of the one pipeline, never a second one",
          ).toBe(1);
        } finally {
          census.stop();
          await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE id = $2`, [Date.now(), sessionId]);
          await runPromise.catch(() => undefined);
        }
      },
    );

    it(
      "a COINCIDENT seek + switch in one tick produces exactly ONE restart (§9.1.7)",
      { timeout: 180_000 * TIME_SCALE },
      async () => {
        const sessionId = await createSession();
        const sessionDir = join(stagingRoot, sessionId);
        const census = new ProcessCensus();

        const runPromise = runTranscodeSession(
          {
            db,
            stagingRoot,
            // A long-ish tick so both columns are certainly written before
            // the runner next reads the row — the coincidence is what is
            // under test, not the runner's ability to observe it.
            pollIntervalMs: 400,
            testReadrateMultiplier: 6,
            onRunSpawned: (pid) => {
              census.track(pid);
              if (pid !== undefined) strayPids.push(pid);
            },
          },
          sessionId,
        );
        census.start();

        try {
          await waitForRunProduced(sessionDir, 0, "run 0 produced");
          const before = await runCount(sessionId);

          // ONE statement, so the runner cannot possibly observe an
          // intermediate state where only one of the two is set.
          await raw.query(
            `UPDATE playback_sessions SET seek_target_ms = 45000, pending_rung_index = 1, updated_at_ms = $1 WHERE id = $2`,
            [Date.now(), sessionId],
          );

          await waitForRunCount(sessionId, before + 1, "the single restart");
          await waitForRunProduced(sessionDir, before, "the restarted run produced");
          // Give the loop several more ticks to prove no SECOND restart
          // follows — the failure mode is a seek restart immediately
          // chased by a handoff restart, which is exactly the double-pay
          // the seek-livelock incident taught this runtime to refuse.
          await new Promise((r) => setTimeout(r, 2_500 * TIME_SCALE));
          expect(await runCount(sessionId)).toBe(before + 1);

          const runs = await listTranscodeRuns(db, sessionId);
          const restarted = runs[runs.length - 1]!;
          // ONE run carrying BOTH intentions: the requested origin AND the
          // requested rung.
          expect(restarted.sourceOriginMs).toBe(45_000);
          const { rows } = await raw.query<{ ladder_rung_index: number | null }>(
            `SELECT ladder_rung_index FROM transcode_runs WHERE session_id = $1 AND run_index = $2`,
            [sessionId, restarted.runIndex],
          );
          expect(rows[0]!.ladder_rung_index).toBe(1);

          // Both control columns were consumed, not left to re-fire.
          const { rows: cols } = await raw.query<{ seek_target_ms: number | null; pending_rung_index: number | null }>(
            `SELECT seek_target_ms, pending_rung_index FROM playback_sessions WHERE id = $1`,
            [sessionId],
          );
          expect(cols[0]!.seek_target_ms).toBeNull();
          expect(cols[0]!.pending_rung_index).toBeNull();

          expect(census.max, "one restart means one process at a time, still").toBe(1);
        } finally {
          census.stop();
          await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE id = $2`, [Date.now(), sessionId]);
          await runPromise.catch(() => undefined);
        }
      },
    );

    it(
      "SLOT-HANDOFF CAP PROOF: under a cap-1 admission policy a switch never runs two encoders, and never touches the slot",
      { timeout: 180_000 * TIME_SCALE },
      async () => {
        // The admission slot is held by the SESSION at every instant
        // (countActiveTranscodeSessions counts non-terminal session rows),
        // so a handoff cannot free it even transiently — there is no census
        // change, no 429 path, and nothing for the gate to serialize. This
        // asserts BOTH halves: the accounting (exactly one slot occupied
        // throughout) and the physical fact (never two live encoders).
        const sessionId = await createSession();
        const sessionDir = join(stagingRoot, sessionId);
        const census = new ProcessCensus();
        const slotSamples: number[] = [];

        const runPromise = runTranscodeSession(
          {
            db,
            stagingRoot,
            pollIntervalMs: 150,
            testReadrateMultiplier: 6,
            onRunSpawned: (pid) => {
              census.track(pid);
              if (pid !== undefined) strayPids.push(pid);
            },
          },
          sessionId,
        );
        census.start(20);
        const slotTimer = setInterval(() => {
          void countActiveTranscodeSessions(db).then((n) => slotSamples.push(n));
        }, 40);

        try {
          await waitForRunProduced(sessionDir, 0, "run 0 produced");
          const before = await runCount(sessionId);
          await requestRungSwitch(db, ctx, sessionId, 1, Date.now());
          await waitForRunCount(sessionId, before + 1, "handoff run recorded");
          await waitForRunProduced(sessionDir, before, "handoff run produced");

          expect(census.max, "cap 1: a handoff must never put two ffmpeg processes on the box").toBe(1);
          expect(slotSamples.length).toBeGreaterThan(5);
          // Never 0 (the slot is never released mid-handoff — a freed slot
          // would let a second session's pipeline start beside this one)
          // and never 2 (a handoff is not a new admission).
          expect(Math.min(...slotSamples), "the slot is HELD across the whole handoff").toBe(1);
          expect(Math.max(...slotSamples), "a handoff is not a second admission").toBe(1);

          // A PURE switch never enters `seeking` — the union playlist stays
          // fully servable and only the live edge waits (§9.1.4).
          const { rows } = await raw.query<{ status: string; discontinuity_count: number }>(
            `SELECT status, discontinuity_count FROM playback_sessions WHERE id = $1`,
            [sessionId],
          );
          expect(rows[0]!.status).not.toBe("seeking");
          expect(rows[0]!.discontinuity_count).toBe(0);
        } finally {
          clearInterval(slotTimer);
          census.stop();
          await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE id = $2`, [Date.now(), sessionId]);
          await runPromise.catch(() => undefined);
        }
      },
    );

    it(
      "a handoff whose arg rebuild FAILS fails the session, and the slot frees only via that terminal status",
      { timeout: 180_000 * TIME_SCALE },
      async () => {
        // §9.1.4's failure table, row 1: old process dead, new never
        // started. The session must go terminal rather than sit forever
        // holding a slot with nothing encoding.
        //
        // The failure is induced through a DEDICATED media_files row (same
        // fixture path, so run 0 really encodes) which is then deleted:
        // `rebuildSeekArgs` re-reads MediaInfo from the DB on every restart
        // and raises SeekRebuildError when it cannot. Deleting the row
        // rather than nulling a column on the session is what makes this
        // real — the runner caches the session row it read at start, so a
        // column edit would be invisible to it, and a test that "passed"
        // against an invisible change would prove nothing.
        // `media_files.path` is UNIQUE, so the doomed row needs its own
        // copy of the fixture on disk.
        const doomedPath = join(stagingRoot, "doomed-source.mp4");
        copyFileSync(FIXTURE_PATH, doomedPath);
        const doomedFile = await raw.query<{ id: string }>(
          `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
           VALUES ($1, $2, 'doomed-hash', $3, 'mp4', 150000, $4) RETURNING id`,
          [itemId, doomedPath, statSync(doomedPath).size, Date.now()],
        );
        const doomedFileId = doomedFile.rows[0]!.id;
        await raw.query(
          `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, frame_rate, is_default, is_forced)
           VALUES ($1, 0, 'video', 'h264', 320, 240, 8, 25, true, false)`,
          [doomedFileId],
        );
        await raw.query(
          `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, channels, sample_rate, is_default, is_forced)
           VALUES ($1, 1, 'audio', 'aac', 2, 48000, true, false)`,
          [doomedFileId],
        );
        const doomedSession = await createPlaybackSession(db, ctx, {
          itemId,
          fileId: doomedFileId,
          deviceId,
          plan: storedPlan,
          engineVersion: "test",
          nowMs: Date.now(),
        });
        const sessionId = doomedSession!.id;
        const sessionDir = join(stagingRoot, sessionId);
        const runPromise = runTranscodeSession(
          {
            db,
            stagingRoot,
            pollIntervalMs: 150,
            testReadrateMultiplier: 6,
            onRunSpawned: (pid) => {
              if (pid !== undefined) strayPids.push(pid);
            },
          },
          sessionId,
        );

        try {
          await waitForRunProduced(sessionDir, 0, "run 0 produced");
          expect(await countActiveTranscodeSessions(db)).toBe(1);

          // Make rebuildSeekArgs unable to re-assemble the plan input.
          await raw.query(`DELETE FROM media_files WHERE id = $1`, [doomedFileId]);
          await requestRungSwitch(db, ctx, sessionId, 1, Date.now());

          await waitFor(
            async () => {
              const { rows } = await raw.query<{ status: string }>(`SELECT status FROM playback_sessions WHERE id = $1`, [sessionId]);
              return rows[0]?.status === "failed";
            },
            { timeoutMs: 60_000 * TIME_SCALE, label: "session failed" },
          );

          const { rows } = await raw.query<{ status: string; error_code: string | null }>(
            `SELECT status, error_code FROM playback_sessions WHERE id = $1`,
            [sessionId],
          );
          expect(rows[0]!.status).toBe("failed");
          expect(rows[0]!.error_code).toBe("transcode-failed");
          // Terminal -> the slot is free, and ONLY because it is terminal.
          expect(await countActiveTranscodeSessions(db)).toBe(0);
          // The stored plan is untouched by any of this: a failed handoff
          // is a runtime event, not a re-planning event.
          const { rows: planRows } = await raw.query<{ plan: Record<string, unknown> }>(
            `SELECT plan FROM playback_sessions WHERE id = $1`,
            [sessionId],
          );
          expect((planRows[0]!.plan as { ladder: unknown[] }).ladder).toHaveLength(3);
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
      "a COMPLETED encode gets EXT-X-ENDLIST, and from that moment the playlist STOPS CHANGING (§9.1.5 rule 4)",
      { timeout: 300_000 * TIME_SCALE },
      async () => {
        // Pre-C2 this was unreachable: `renderServedPlaylist` never emitted
        // ENDLIST at all, so a finished stream played out and then polled
        // forever — no resolved duration, no `ended` event on the media
        // element. The parser had recorded `hasEndlist` since it landed;
        // nothing consumed it.
        //
        // `testReadrateMultiplier: 6` is LOAD-BEARING here (C2 review): the
        // interesting path is ENDLIST arriving on a playlist whose head
        // retention has ALREADY pruned — which is what production always
        // looks like, since the throttle means ffmpeg only reaches end of
        // input once the viewer has watched (nearly) the whole thing, long
        // after the first prune. An unpaced encode of the 150 s fixture
        // finishes in a couple of poll ticks and made reaching that path a
        // coin flip: whenever no tick happened to land between
        // "content > 120 s" and "ENDLIST written", the test silently
        // proved only the trivial nothing-was-ever-pruned case — and the
        // fold-resurrect defect this test caught during review (a frozen
        // playlist listing deleted files, media-sequence collapsing back
        // to 0) sailed through whenever the coin landed that way. At 6x,
        // ~5 s of wall clock separates the first prune from ENDLIST —
        // dozens of 150 ms ticks — and the precondition assert below makes
        // the requirement explicit instead of timing-dependent.
        const sessionId = await createSession();
        const sessionDir = join(stagingRoot, sessionId);
        const runPromise = runTranscodeSession(
          {
            db,
            stagingRoot,
            pollIntervalMs: 150,
            testReadrateMultiplier: 6,
            onRunSpawned: (pid) => {
              if (pid !== undefined) strayPids.push(pid);
            },
          },
          sessionId,
        );

        // Stand in for a client that is actually WATCHING. Without a
        // climbing `requested_segment` the segment-ahead throttle SIGSTOPs
        // the encode at ahead > 10 and its resume condition (ahead <= 5)
        // is unreachable forever — correct behaviour (a Tier-0 box must
        // not race ahead of a paused viewer) and the exact reason this
        // test has to simulate consumption rather than just wait.
        const consumer = setInterval(() => {
          void raw
            .query(`UPDATE playback_sessions SET requested_segment = produced_segment WHERE id = $1`, [sessionId])
            .catch(() => undefined);
        }, 200);

        const servedPath = join(sessionDir, "media.m3u8");
        try {
          await waitFor(
            () => {
              try {
                return readFileSync(servedPath, "utf8").includes("#EXT-X-ENDLIST");
              } catch {
                return false;
              }
            },
            { timeoutMs: 240_000 * TIME_SCALE, label: "served playlist ENDLIST" },
          );

          const ended = readFileSync(servedPath, "utf8");
          // The type-less sliding-window shape (rule 1) survives to the
          // end — an ended playlist is still not an EVENT playlist.
          expect(ended).not.toContain("#EXT-X-PLAYLIST-TYPE");
          expect(ended.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);

          // PRECONDITION, asserted so it can never silently rot back into
          // a timing coin flip: retention must really have pruned the head
          // BEFORE ENDLIST arrived (150 s of content against a 120 s
          // window, paced so dozens of ticks separate the two). A frozen
          // playlist that still lists segment 0 would mean this test is
          // exercising the trivial never-pruned path and proving nothing
          // about the fold-resurrect defect.
          const endedEntries = parseServedSegmentDurations(ended);
          expect(
            endedEntries[0]!.index,
            "the frozen playlist's head must be PRUNED (media-sequence > 0) — resurrecting segment 0 was the defect",
          ).toBeGreaterThan(0);

          // PRUNE-FREEZE. RFC 8216: a playlist that has ended must not
          // change. Several poll ticks later it must be byte-identical —
          // retention would otherwise keep trimming its head under a
          // client that has already stopped polling.
          await new Promise((r) => setTimeout(r, 2_000 * TIME_SCALE));
          expect(readFileSync(servedPath, "utf8"), "an ENDED playlist must not change").toBe(ended);

          // And every segment it still lists is still ON DISK — a frozen
          // playlist naming deleted files would be the same defect wearing
          // a different hat.
          for (const entry of parseServedSegmentDurations(ended).slice(0, 5)) {
            const uri = `run${entry.runIndex}/s${String(entry.index).padStart(6, "0")}.m4s`;
            expect(() => statSync(join(sessionDir, uri)), uri).not.toThrow();
          }
        } finally {
          clearInterval(consumer);
          await raw.query(`UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 WHERE id = $2`, [Date.now(), sessionId]);
          await runPromise.catch(() => undefined);
        }
      },
    );
  },
);
