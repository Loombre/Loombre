#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/t0-audit/dual-transcode.mjs
//
// The HEADLINE T0 test (docs/PLAN.md §9.1: "T0 ... >= 2 simultaneous 1080p
// hw transcodes"). Starts TWO real playback sessions against two real
// 1080p+ items from the owner's own scanned library, forcing decision ===
// 'transcode' via a deliberately-restrictive DeviceProfile, and REFUSES to
// proceed unless each session's plan proves a real hardware encoder was
// selected (plan.reasons carries `hw-encoder-selected:<backend>` with
// backend != 'software' — docs/PLAYBACK.md §4 / packages/contract/
// openapi.yaml's PlanReasonCode pattern). A software-fallback session is a
// FAILED pre-flight for this specific test, not a degraded pass — the
// whole point is proving QSV (or whatever backend this N100 verified)
// actually engaged, not just that transcoding happened at all.
//
// NOTE: docs/PLAYBACK.md's tier-0 default maxSimultaneousTranscodes is 2
// (packages/shared/src/settings-registry.ts's tierDefaults, SPF-8), NOT
// auto-detected from hardware — so a stock T0 install already admits the
// two sessions this script starts. `LOOMBRE_MAX_TRANSCODES` remains
// available if you want a different ceiling for this run — see the
// runbook's "Step D pre-flight" section.
//
// Usage:
//   node scripts/t0-audit/dual-transcode.mjs \
//     [--base-url http://127.0.0.1:3001] \
//     [--admin-user admin] [--admin-password loombre-seed-admin] \
//     [--library-name "My Library"] \
//     [--item-a <uuid>] [--item-b <uuid>]   # skip auto-pick, use these two
//     [--max-candidates 200] [--results-dir DIR]
//
// On success, writes <results-dir>/dual-transcode.json with both sessions'
// {itemId, sessionId, manifestUrl, backend, deviceId, userId, refreshToken}
// — sustained-monitor.mjs reads this file to know what to watch.

import path from "node:path";
import {
  parseArgs,
  login,
  apiFetch,
  apiFetchJson,
  log,
  warn,
  fail,
  nowIso,
  writeJsonResult,
  resultsDir,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
} from "./lib/common.mjs";

const HW_ENCODER_REASON_RE = /^hw-encoder-selected:(.+)$/;

/** A deliberately minimal DeviceProfile: no direct-play containers, and the
 *  ONE declared video codec (av1, capped at 360p / 500kbps) is virtually
 *  guaranteed not to match any real 1080p+ h264/hevc source — forcing
 *  Stage B to require a full video transcode regardless of what the item's
 *  own source codec/resolution actually is. Schema per packages/contract/
 *  openapi.yaml DeviceProfile (required fields only). */
function buildForceTranscodeDeviceProfile() {
  return {
    profileId: "t0-audit-force-transcode",
    directPlayContainers: [],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "av1",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 8,
        maxWidth: 640,
        maxHeight: 360,
        maxFrameRate: 30,
        maxBitrateBps: 500_000,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "opus", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

function buildLocalNetworkConditions() {
  return { maxBitrateBps: 50_000_000, isLocal: true };
}

/** Walks GET /movies pages, fetching each item's detail to inspect
 *  mediaFiles[].height, stopping once `count` matches with height >= 1080
 *  are found (or `maxCandidates` items have been probed, whichever first).
 *  This is deliberately per-item detail fetches (list responses don't carry
 *  mediaFiles per the contract) — fine for "the owner's real library
 *  subset" this test targets, not the 50k synthetic seed. */
async function findRealHdItems(baseUrl, accessToken, { libraryName, count, maxCandidates }) {
  let libraryId;
  if (libraryName) {
    const libs = await apiFetchJson(baseUrl, accessToken, "/libraries?limit=200");
    const match = libs.items.find((l) => l.name === libraryName);
    if (!match) throw new Error(`t0-audit: no library named "${libraryName}" found`);
    libraryId = match.id;
  }

  const found = [];
  let cursor;
  let probed = 0;
  while (found.length < count && probed < maxCandidates) {
    const qs = new URLSearchParams({ limit: "50" });
    if (libraryId) qs.set("libraryId", libraryId);
    if (cursor) qs.set("cursor", cursor);
    const page = await apiFetchJson(baseUrl, accessToken, `/movies?${qs.toString()}`);
    if (page.items.length === 0) break;

    for (const item of page.items) {
      if (found.length >= count || probed >= maxCandidates) break;
      probed += 1;
      const detail = await apiFetchJson(baseUrl, accessToken, `/movies/${item.id}`);
      const hd = (detail.mediaFiles ?? []).find((f) => (f.height ?? 0) >= 1080);
      if (hd) {
        found.push({ id: item.id, title: item.title, height: hd.height, width: hd.width, container: hd.container });
        log("dual-transcode", `candidate: "${item.title}" (${hd.width}x${hd.height}, ${hd.container ?? "?"}) -- ${item.id}`);
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { found, probed };
}

/** POST /playback/plan (read-only preview) — verifies decision==='transcode'
 *  and a non-software hw-encoder-selected reason BEFORE spending a real
 *  session/transcode slot. Throws a descriptive error otherwise. */
async function verifyHwTranscodePlan(baseUrl, accessToken, itemId, device, network) {
  const res = await apiFetch(baseUrl, accessToken, "/playback/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemId, device, network, mode: "stream" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /playback/plan for ${itemId} -> HTTP ${res.status}: ${body.slice(0, 800)}`);
  }
  const plan = await res.json();
  if (plan.decision !== "transcode") {
    throw new Error(
      `t0-audit: item ${itemId} plan decision was '${plan.decision}', not 'transcode' — the forced-transcode ` +
        "DeviceProfile did not do its job for this item (check its actual codec/resolution), or the ladder let it " +
        "through some other way. Pick a different item or inspect the plan: " +
        JSON.stringify(plan, null, 2).slice(0, 2000),
    );
  }
  const hwReason = plan.reasons.map((r) => r.code).map((c) => c.match(HW_ENCODER_REASON_RE)).find(Boolean);
  if (!hwReason) {
    throw new Error(
      `t0-audit: item ${itemId} plan is decision='transcode' but carries NO hw-encoder-selected reason at all ` +
        `(reasons: ${plan.reasons.map((r) => r.code).join(", ")}) — cannot confirm hardware OR software routing. ` +
        "This should not happen (Stage G always emits one); inspect the full plan.",
    );
  }
  const backend = hwReason[1];
  if (backend === "software") {
    throw new Error(
      `t0-audit: item ${itemId} plan selected SOFTWARE fallback (hw-encoder-selected:software), not hardware. ` +
        "This FAILS the headline T0 test's premise (it must prove real hardware engagement, e.g. qsv). Likely " +
        "causes: hwprobe hasn't run / found no working backend (`pnpm --filter @loombre/worker run hwprobe`, then " +
        "check GET /admin/capabilities), or the loombre service user lacks /dev/dri access (usermod -aG render,video " +
        "loombre) — see the runbook's Step A QSV pre-flight.",
    );
  }
  log("dual-transcode", `item ${itemId}: plan decision=transcode, hw-encoder-selected:${backend} -- VERIFIED hardware`);
  return { plan, backend };
}

async function startSession(baseUrl, accessToken, itemId, device, network) {
  const res = await apiFetch(baseUrl, accessToken, "/playback/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemId, device, network, mode: "stream" }),
  });
  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `t0-audit: POST /playback/sessions for ${itemId} -> HTTP 429 transcode-slots-exhausted. The tier-0 ` +
        "default maxSimultaneousTranscodes is 2, which this test should fit under — check for another " +
        "session already occupying a slot, or a LOOMBRE_MAX_TRANSCODES pin lower than 2 in " +
        "/etc/loombre/loombre.env, then re-run this script. " +
        `Server response: ${body.slice(0, 500)}`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /playback/sessions for ${itemId} -> HTTP ${res.status}: ${body.slice(0, 800)}`);
  }
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args["base-url"] ?? "http://127.0.0.1:3001";
  const adminUser = args["admin-user"] ?? DEFAULT_ADMIN_USERNAME;
  const adminPassword = args["admin-password"] ?? DEFAULT_ADMIN_PASSWORD;
  const maxCandidates = Number.parseInt(args["max-candidates"] ?? "200", 10);

  const auth = await login(baseUrl, adminUser, adminPassword, "t0-audit-dual-transcode", buildForceTranscodeDeviceProfile());
  log("dual-transcode", `authenticated as ${adminUser} (userId ${auth.userId}, deviceId ${auth.deviceId})`);

  let itemIds;
  if (args["item-a"] && args["item-b"]) {
    itemIds = [args["item-a"], args["item-b"]];
    log("dual-transcode", `using explicit items: ${itemIds.join(", ")}`);
  } else {
    const { found, probed } = await findRealHdItems(baseUrl, auth.accessToken, {
      libraryName: args["library-name"],
      count: 2,
      maxCandidates,
    });
    if (found.length < 2) {
      throw new Error(
        `t0-audit: only found ${found.length}/2 real 1080p+ items after probing ${probed} candidates. ` +
          "Scan a real library with at least two 1080p+ (or higher) files first, or pass --item-a/--item-b " +
          "explicitly, or raise --max-candidates.",
      );
    }
    itemIds = found.map((f) => f.id);
  }

  const device = buildForceTranscodeDeviceProfile();
  const network = buildLocalNetworkConditions();

  const sessions = [];
  for (const itemId of itemIds) {
    const detail = await apiFetchJson(baseUrl, auth.accessToken, `/movies/${itemId}`);
    const primaryFile = (detail.mediaFiles ?? [])[0];
    const resolution = primaryFile ? `${primaryFile.width ?? "?"}x${primaryFile.height ?? "?"} (${primaryFile.container ?? "?"})` : "unknown";

    const { backend } = await verifyHwTranscodePlan(baseUrl, auth.accessToken, itemId, device, network);
    const session = await startSession(baseUrl, auth.accessToken, itemId, device, network);
    if (!session.manifestUrl) {
      throw new Error(`t0-audit: session ${session.id} for item ${itemId} has no manifestUrl — expected an HLS session for a transcode decision`);
    }
    log("dual-transcode", `session ${session.id} started for item ${itemId} ("${detail.title}", ${resolution}) -- manifestUrl ${session.manifestUrl}`);
    sessions.push({
      itemId,
      title: detail.title,
      resolution,
      sessionId: session.id,
      manifestUrl: session.manifestUrl,
      backend,
      status: session.status,
    });
  }

  const result = {
    recordedAtMs: Date.now(),
    recordedAtIso: nowIso(),
    baseUrl,
    userId: auth.userId,
    deviceId: auth.deviceId,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    sessions,
  };

  const outPath = path.join(resultsDir(args), "dual-transcode.json");
  writeJsonResult(outPath, result);
  log("dual-transcode", `wrote ${outPath}`);
  log(
    "dual-transcode",
    `${sessions.length} hardware transcode session(s) started and verified. Next: ` +
      "node scripts/t0-audit/sustained-monitor.mjs to watch them for the required 30-minute window.",
  );

  if (sessions.length < 2) {
    warn("dual-transcode", "fewer than 2 sessions started — the headline T0 test requires TWO SIMULTANEOUS sessions; this run does not satisfy it alone.");
  }
}

main().catch((err) => {
  fail("dual-transcode", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
