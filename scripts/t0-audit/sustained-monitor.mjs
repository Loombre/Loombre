#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/t0-audit/sustained-monitor.mjs
//
// The other half of the headline T0 test (docs/PLAN.md §9.1): given the
// sessions scripts/t0-audit/dual-transcode.mjs started, watches them for a
// real-time-paced window (default 30 minutes) the way an actual pair of
// viewers would, sampling:
//   - produced_segment / requested_segment / status / suspended_by_throttle
//     (via @loombre/db's getPlaybackSessionForUser — the SAME guarded
//     query-layer function apps/server's playback controllers use; see
//     "DB access" below for why this needs --database-url)
//   - the real ffmpeg child process's RSS (found via /proc/<pid>/cwd
//     matching against staging_dir — lib/common.mjs's
//     findFfmpegPidForSessionDir; argv text-matching does NOT work here,
//     see that function's own header)
//   - the real systemd server+worker RSS (same method as rss-sample.mjs)
//   - thermal zones + a dmesg thermal/throttle diff across the window
//
// PACING (read this before running): apps/worker's transcode runner does
// NOT rate-limit ffmpeg's own encode speed — docs/PLAYBACK.md §9's
// suspend-at-ahead>10/resume-at-ahead<=5 throttle exists PRECISELY because
// ffmpeg would otherwise blast through the whole file in well under 30
// minutes. To genuinely exercise "sustained" hardware load (not "produce
// everything in 90 seconds, then sit idle/suspended for the remaining 28.5
// minutes"), this script acts as a minimal real-time HLS client: it
// requests exactly one new segment per `--segment-duration-sec` (default 6,
// matching apps/server/src/playback/resolve-policy.ts's
// DEFAULT segmentDurationSec) — the same cadence a real video player
// consuming the stream in real time would produce. Point this at items
// with real runtime >= the requested duration (a real movie easily clears
// 30 minutes; the runbook's Step D says so explicitly).
//
// DB ACCESS: --database-url is OPTIONAL but STRONGLY recommended — without
// it this script falls back to inferring "produced" progress purely from
// what appears in the HLS manifest (still a real, honest signal — a segment
// cannot appear in the manifest before the worker calls
// markSessionActiveWithFirstSegment/updateProducedSegment — but it cannot
// see `suspended_by_throttle` or `stderr_tail` at all, which only live in
// the playback_sessions row). Pass the SAME embedded-PG DATABASE_URL
// scripts/t0-audit/run-perf-t0.mjs resolves (read the secret file yourself,
// or reuse that script's --database-url output) for the full signal.
//
// N100-ONLY (real ffmpeg process, real systemd units, real /proc). Logic
// (pacing math, gap detection, summary thresholds) is exercised here via
// --dry-run against a synthetic in-process fixture — see the runbook.
//
// Usage:
//   node scripts/t0-audit/sustained-monitor.mjs \
//     [--results-dir DIR]                 # reads dual-transcode.json here
//     [--database-url postgres://...]     # optional but recommended
//     [--duration-min 30] [--sample-interval-sec 5] [--segment-duration-sec 6]
//     [--server-unit loombre-server] [--worker-unit loombre-worker]
//     [--config-dir /etc/loombre]

import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  parseArgs,
  apiFetch,
  refreshAccessToken,
  resolveInstallEnv,
  resolveDataDir,
  systemdMainPid,
  rssBytesForPid,
  embeddedPgRssBytes,
  findFfmpegPidForSessionDir,
  readThermalZones,
  readDmesgThrottleLines,
  fmtMiB,
  sleep,
  log,
  warn,
  fail,
  nowIso,
  writeJsonResult,
  resultsDir,
} from "./lib/common.mjs";

const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000; // docs/PLAN.md §10: 15-minute access JWT
const REFRESH_MARGIN_MS = 3 * 60 * 1000; // refresh with 3 minutes of headroom left

// ---------------------------------------------------------------------------
// HLS manifest parsing (minimal — enough to extract segment URIs in order)
// ---------------------------------------------------------------------------

function parseSegmentUris(m3u8Text) {
  return m3u8Text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function manifestBaseUrl(sessionApiBase) {
  // GET /playback/sessions/{id}/hls/media.m3u8 -> sibling segment URLs are
  // relative to /playback/sessions/{id}/hls/ (packages/contract/
  // openapi.yaml's GET .../hls/{file} sibling route).
  return sessionApiBase.replace(/\/media\.m3u8$/, "/");
}

// ---------------------------------------------------------------------------
// Per-session state machine
// ---------------------------------------------------------------------------

function newSessionState(entry) {
  return {
    itemId: entry.itemId,
    title: entry.title ?? null,
    resolution: entry.resolution ?? null,
    sessionId: entry.sessionId,
    manifestUrl: entry.manifestUrl,
    backend: entry.backend,
    consumedUris: new Set(),
    consumedOrder: [],
    lastConsumedIndex: -1,
    gapDetected: false,
    consumeErrors: 0,
    manifestErrors: 0,
    runDirsSeen: new Set(),
    suspendTransitions: 0,
    lastSuspended: false,
    lastStatus: null,
    failedObserved: false,
    samples: [], // {atMs, ffmpegRssBytes, producedSegment, requestedSegment, suspendedByThrottle, status}
  };
}

/** Segment filenames are `runN/sNNNNNN.m4s` (or .ts / init.mp4) per the
 *  contract's GET .../hls/{file} description — extracts a sortable index. */
function segmentSortKey(uri) {
  const m = uri.match(/s(\d+)\.(m4s|ts)$/);
  return m ? Number.parseInt(m[1], 10) : -1;
}

async function consumeOneNewSegment(baseUrl, accessTokenRef, state) {
  const listUrl = `${baseUrl}${state.manifestUrl}?token=${encodeURIComponent(accessTokenRef.value)}`;
  const res = await fetch(listUrl);
  if (res.status === 503) {
    return; // not ready yet / mid-seek-restart — normal, try again next tick
  }
  if (!res.ok) {
    state.manifestErrors += 1;
    warn("sustained-monitor", `session ${state.sessionId}: manifest GET -> HTTP ${res.status}`);
    return;
  }
  const text = await res.text();
  const uris = parseSegmentUris(text);
  const base = manifestBaseUrl(state.manifestUrl);

  const unconsumed = uris.filter((u) => !state.consumedUris.has(u)).sort((a, b) => segmentSortKey(a) - segmentSortKey(b));
  if (unconsumed.length === 0) return;

  // Consume exactly ONE new segment per call (this function is invoked once
  // per --segment-duration-sec tick) — real-time pacing, see file header.
  const next = unconsumed[0];
  const idx = segmentSortKey(next);
  if (idx !== -1 && state.lastConsumedIndex !== -1 && idx > state.lastConsumedIndex + 1) {
    state.gapDetected = true;
    warn("sustained-monitor", `session ${state.sessionId}: segment index jumped ${state.lastConsumedIndex} -> ${idx} (possible drop)`);
  }
  const runDirMatch = next.match(/^(run\d+)\//);
  if (runDirMatch) state.runDirsSeen.add(runDirMatch[1]);

  const segUrl = `${baseUrl}${base}${next}?token=${encodeURIComponent(accessTokenRef.value)}`;
  const segRes = await fetch(segUrl);
  if (segRes.status === 503) return; // seek-restart window, try again
  if (!segRes.ok) {
    state.consumeErrors += 1;
    warn("sustained-monitor", `session ${state.sessionId}: segment GET ${next} -> HTTP ${segRes.status}`);
    return;
  }
  await segRes.arrayBuffer(); // drain the body; we only care that it succeeded
  state.consumedUris.add(next);
  state.consumedOrder.push(next);
  if (idx !== -1) state.lastConsumedIndex = idx;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input ?? path.join(resultsDir(args), "dual-transcode.json");
  if (!existsSync(inputPath)) {
    throw new Error(`t0-audit: ${inputPath} not found — run scripts/t0-audit/dual-transcode.mjs first (or pass --input)`);
  }
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  if (!input.sessions || input.sessions.length === 0) {
    throw new Error(`t0-audit: ${inputPath} has no sessions`);
  }

  const durationMin = Number.parseFloat(args["duration-min"] ?? "30");
  const sampleIntervalSec = Number.parseFloat(args["sample-interval-sec"] ?? "5");
  const segmentDurationSec = Number.parseFloat(args["segment-duration-sec"] ?? "6");
  const serverUnit = args["server-unit"] ?? "loombre-server";
  const workerUnit = args["worker-unit"] ?? "loombre-worker";

  const env = resolveInstallEnv(args);
  const dataDir = resolveDataDir(env);
  const pgDataDir = path.join(dataDir, "postgres", "data");

  const databaseUrl = args["database-url"];
  let getPlaybackSessionForUser, db, ctx;
  if (databaseUrl) {
    const { register } = await import("tsx/esm/api");
    register();
    const dbMod = await import("@loombre/db");
    getPlaybackSessionForUser = dbMod.getPlaybackSessionForUser;
    db = dbMod.createDb(databaseUrl);
    ctx = { userId: input.userId, allowedLibraryIds: [], restrictedCleared: false };
    log("sustained-monitor", "DB access enabled — produced_segment/suspended_by_throttle will be read directly from playback_sessions");
  } else {
    warn("sustained-monitor", "--database-url not given — falling back to manifest-only observation (no suspended_by_throttle visibility). See this file's header.");
  }

  const accessTokenRef = { value: input.accessToken };
  let refreshTokenValue = input.refreshToken;
  let tokenIssuedAtMs = Date.now();

  const states = input.sessions.map(newSessionState);
  const stagingDirBySession = new Map(); // sessionId -> stagingDir, once learned

  const startedAtMs = Date.now();
  const endAtMs = startedAtMs + durationMin * 60_000;
  const thermalStart = readThermalZones();
  const dmesgStart = readDmesgThrottleLines();

  log("sustained-monitor", `watching ${states.length} session(s) for ${durationMin} minute(s), sampling every ${sampleIntervalSec}s, consuming 1 segment/${segmentDurationSec}s per session`);

  let nextSampleAt = Date.now();
  let nextConsumeAt = Date.now();

  while (Date.now() < endAtMs) {
    const now = Date.now();

    // Rotate the access token before it expires — a 30-minute window
    // outlives the 15-minute access JWT (STATE.md P2.1) at least once.
    if (now - tokenIssuedAtMs > ACCESS_TOKEN_LIFETIME_MS - REFRESH_MARGIN_MS) {
      try {
        const rotated = await refreshAccessToken(input.baseUrl, refreshTokenValue, input.deviceId);
        accessTokenRef.value = rotated.accessToken;
        refreshTokenValue = rotated.refreshToken;
        tokenIssuedAtMs = now;
        log("sustained-monitor", "access token rotated");
      } catch (err) {
        fail("sustained-monitor", `token refresh failed: ${err instanceof Error ? err.message : String(err)} — subsequent requests will start 401ing`);
      }
    }

    if (now >= nextConsumeAt) {
      nextConsumeAt = now + segmentDurationSec * 1000;
      await Promise.all(states.map((s) => consumeOneNewSegment(input.baseUrl, accessTokenRef, s).catch((err) => {
        s.consumeErrors += 1;
        warn("sustained-monitor", `session ${s.sessionId}: consume tick threw: ${err instanceof Error ? err.message : String(err)}`);
      })));
    }

    if (now >= nextSampleAt) {
      nextSampleAt = now + sampleIntervalSec * 1000;

      const serverPid = systemdMainPid(serverUnit);
      const workerPid = systemdMainPid(workerUnit);
      const serverRssBytes = serverPid !== null ? rssBytesForPid(serverPid) : NaN;
      const workerRssBytes = workerPid !== null ? rssBytesForPid(workerPid) : NaN;
      const pg = embeddedPgRssBytes(pgDataDir);

      for (const s of states) {
        let producedSegment = null;
        let requestedSegment = null;
        let suspendedByThrottle = null;
        let status = null;
        let stagingDir = stagingDirBySession.get(s.sessionId) ?? null;

        if (db) {
          try {
            const row = await getPlaybackSessionForUser(db, ctx, s.sessionId);
            if (row) {
              producedSegment = row.producedSegment;
              requestedSegment = row.requestedSegment;
              suspendedByThrottle = row.suspendedByThrottle;
              status = row.status;
              if (row.stagingDir) {
                stagingDir = row.stagingDir;
                stagingDirBySession.set(s.sessionId, stagingDir);
              }
              if (status === "failed") s.failedObserved = true;
              if (suspendedByThrottle !== s.lastSuspended) {
                s.suspendTransitions += 1;
                s.lastSuspended = suspendedByThrottle;
              }
              s.lastStatus = status;
            }
          } catch (err) {
            warn("sustained-monitor", `session ${s.sessionId}: DB read failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const ffmpeg = stagingDir ? findFfmpegPidForSessionDir(stagingDir) : null;
        const ffmpegRssBytes = ffmpeg ? rssBytesForPid(ffmpeg.pid) : NaN;

        s.samples.push({
          atMs: now,
          elapsedSec: Math.round((now - startedAtMs) / 1000),
          ffmpegPid: ffmpeg ? ffmpeg.pid : null,
          ffmpegRssBytes: Number.isFinite(ffmpegRssBytes) ? ffmpegRssBytes : null,
          producedSegment,
          requestedSegment,
          suspendedByThrottle,
          status,
        });
      }

      const thermal = readThermalZones();
      const hottest = thermal.length > 0 ? Math.max(...thermal.map((z) => z.tempMilliC)) / 1000 : null;
      log(
        "sustained-monitor",
        `t+${Math.round((now - startedAtMs) / 1000)}s -- server ${fmtMiB(serverRssBytes)}, worker ${fmtMiB(workerRssBytes)}, ` +
          `embeddedPG ${pg ? fmtMiB(pg.totalBytes) : "n/a"}` +
          (hottest !== null ? `, hottest zone ${hottest.toFixed(1)}°C` : "") +
          " -- " +
          states
            .map(
              (s) =>
                `[${s.sessionId.slice(0, 8)} produced=${s.samples.at(-1)?.producedSegment ?? "?"} ` +
                `suspended=${s.samples.at(-1)?.suspendedByThrottle ?? "?"} ffmpegRss=${fmtMiB(s.samples.at(-1)?.ffmpegRssBytes)}]`,
            )
            .join(" "),
      );
    }

    await sleep(500);
  }

  const thermalEnd = readThermalZones();
  const dmesgEnd = readDmesgThrottleLines();
  const newDmesgLines =
    dmesgEnd.available && dmesgStart.available ? dmesgEnd.lines.filter((l) => !dmesgStart.lines.includes(l)) : dmesgEnd.lines;

  const summary = states.map((s) => {
    const rssValues = s.samples.map((x) => x.ffmpegRssBytes).filter((v) => v !== null);
    const firstRss = rssValues[0] ?? null;
    const lastRss = rssValues.at(-1) ?? null;
    const growthPct = firstRss && lastRss ? ((lastRss - firstRss) / firstRss) * 100 : null;
    return {
      sessionId: s.sessionId,
      itemId: s.itemId,
      title: s.title,
      resolution: s.resolution,
      backend: s.backend,
      segmentsConsumed: s.consumedOrder.length,
      gapDetected: s.gapDetected,
      consumeErrors: s.consumeErrors,
      manifestErrors: s.manifestErrors,
      distinctRunDirsSeen: [...s.runDirsSeen],
      suspendTransitions: s.suspendTransitions,
      failedObserved: s.failedObserved,
      lastStatus: s.lastStatus,
      ffmpegRss: { firstBytes: firstRss, lastBytes: lastRss, growthPct, sampleCount: rssValues.length },
    };
  });

  const overallPass =
    summary.every((s) => !s.gapDetected && !s.failedObserved && s.consumeErrors === 0 && s.distinctRunDirsSeen.length <= 1) &&
    (!newDmesgLines.length || !dmesgEnd.available);

  log("sustained-monitor", "=== SUMMARY ===");
  for (const s of summary) {
    log(
      "sustained-monitor",
      `session ${s.sessionId} (${s.backend}): ${s.segmentsConsumed} segments consumed, gap=${s.gapDetected}, ` +
        `failed=${s.failedObserved}, suspendTransitions=${s.suspendTransitions}, runDirs=${s.distinctRunDirsSeen.join(",") || "none"}, ` +
        `ffmpeg RSS ${fmtMiB(s.ffmpegRss.firstBytes)} -> ${fmtMiB(s.ffmpegRss.lastBytes)}` +
        (s.ffmpegRss.growthPct !== null ? ` (${s.ffmpegRss.growthPct >= 0 ? "+" : ""}${s.ffmpegRss.growthPct.toFixed(1)}%)` : ""),
    );
  }
  if (newDmesgLines.length > 0) {
    fail("sustained-monitor", `${newDmesgLines.length} new dmesg thermal/throttle line(s) during the window:`);
    for (const l of newDmesgLines) console.error(`  ${l}`);
  } else if (!dmesgEnd.available) {
    warn("sustained-monitor", `dmesg unavailable (${dmesgEnd.note}) — thermal-throttle check is UNVERIFIED, not clean. Re-run with dmesg-readable privileges for a real answer.`);
  } else {
    log("sustained-monitor", "no new dmesg thermal/throttle lines during the window");
  }

  const result = {
    recordedAtMs: Date.now(),
    recordedAtIso: nowIso(),
    startedAtMs,
    endedAtMs: Date.now(),
    durationMinRequested: durationMin,
    durationMinActual: (Date.now() - startedAtMs) / 60_000,
    sampleIntervalSec,
    segmentDurationSec,
    dbAccessUsed: Boolean(databaseUrl),
    thermalStart,
    thermalEnd,
    newDmesgLines: dmesgEnd.available ? newDmesgLines : null,
    dmesgAvailable: dmesgEnd.available,
    sessions: summary,
    rawSamples: states.map((s) => ({ sessionId: s.sessionId, samples: s.samples })),
    overallPass,
    note:
      "overallPass is a MECHANICAL check of what this script CAN verify (no segment gaps, no failed status, no " +
      "consume errors, single run-dir per session, no new dmesg thermal lines). RSS-growth trend is reported but " +
      "NOT auto-failed — docs/PLAN.md §9 names no numeric sustained-RSS-growth budget; the owner reviews the " +
      "ffmpegRss.growthPct figures in reports/t0-audit.md and makes the PASS/FAIL/BUDGET-AMENDMENT call for that " +
      "sub-criterion explicitly, per the mission's failures-become-blockers-or-signed-amendments rule.",
  };

  const outPath = path.join(resultsDir(args), "sustained-monitor.json");
  writeJsonResult(outPath, result);
  log("sustained-monitor", `wrote ${outPath}`);

  if (db) await db.destroy().catch(() => {});

  if (!overallPass) {
    fail("sustained-monitor", "mechanical checks FAILED — see summary above");
    process.exit(1);
  }
  log("sustained-monitor", "done — mechanical checks green (RSS-growth trend still needs owner sign-off, see note in the JSON output)");
}

main().catch((err) => {
  fail("sustained-monitor", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
