// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-fallback.ts
//
// Phosphor W2 lane L5 (resume-prompt + playback-refusal flows): "fallback
// action naming the real alternative version (e.g. `Play the 1080p SDR
// version`) when the plan offers one" (design/phosphor/README.md
// "Interactions & behavior -> Playback refusal").
//
// GROUND TRUTH this module is built against (recorded here since it shapes
// the whole approach): the playback engine has NO concept of "alternate
// version" — `plan()` (docs/PLAYBACK.md §1) decides exactly ONE file per
// call (`PlanInput.media`). "Another playable version" is a CATALOG fact —
// packages/contract/openapi.yaml's `MediaFileSummary[]` on Movie/Episode/
// Track (multi-version/edition items, docs/PLAN.md §8.1 — `versionLabel`
// is an admin-set edition/part label, packages/db/src/internal/files.ts,
// NOT a resolution/HDR descriptor) — not an engine output. So finding a
// fallback means: take every media_files row this item has, and ask the
// REAL engine (via `POST /playback/plan`, computePlaybackPlan — already
// shipped as a read-only preview since Phase 3 §11 step 6b, ZERO contract
// change needed here) whether THAT file would also be refused. The first
// one the engine does not refuse is the fallback candidate; if every file
// is refused (or the item only has the one that just failed), there is no
// fallback — this module returns `null` and UnavailableScreen renders no
// fallback affordance at all, matching the design's own "when the plan
// offers one" qualifier. Never a fabricated alternative (U9).
//
// Because `MediaFileSummary` carries no codec/HDR info (packages/db/src/
// query/catalog-detail.ts's shape: id/versionLabel/container/width/height/
// sizeBytes/durationMs only), the label built here is deliberately modest:
// the admin-set `versionLabel` when present, else a resolution bucket
// derived from that file's OWN probed height. Never a codec/HDR claim
// (e.g. "SDR") this data can't back up.
//
// Read-only and never automatic: this only PROBES candidates (no session
// is created, nothing plays). The caller still requires an explicit user
// tap to actually start playing a candidate (VideoPlayer.tsx's
// handleAcceptFallback) — CLAUDE.md's "nothing silently downgrades" holds
// end to end.

import type { components } from "@loombre/sdk";
import { apiPost } from "./api-client.js";
import { buildDeviceProfile } from "./device-profile.js";
import { buildNetworkConditions } from "./network-conditions.js";
import { getAuthStore } from "./auth-store.js";

type MediaFileSummary = components["schemas"]["MediaFileSummary"];
type PlaybackPlan = components["schemas"]["PlaybackPlan"];

export interface FallbackCandidate {
  mediaFileId: string;
  /** e.g. "1080p" or an admin-set edition label — see the header above for
   *  why this never claims a codec/HDR fact the data can't back up. */
  label: string;
}

/**
 * Mirrors the server's own "genuinely unplayable" condition EXACTLY
 * (packages/contract/openapi.yaml's createPlaybackSession 409 doc: "the
 * computed PlaybackPlan is genuinely unplayable — `decision === 'transcode'`
 * but `ffmpegArgs` is empty"), which is itself docs/PLAYBACK.md §3's total-
 * output-contract escape hatch ("the engine NEVER emits unplayable; it
 * emits transcode with `ladder: []`... and the session layer surfaces the
 * failure"). Used both to recognize the failed attempt (implicitly, via
 * the 409 itself) and to judge every PREVIEWED alternate the same way.
 */
export function isPlanRefused(plan: Pick<PlaybackPlan, "decision" | "ffmpegArgs">): boolean {
  return plan.decision === "transcode" && plan.ffmpegArgs.length === 0;
}

// docs/PLAYBACK.md §7's own ladder rung heights — the same standard
// resolution vocabulary the engine itself uses, so a bucketed label reads
// as "a real rung", not an invented tier.
const RESOLUTION_BUCKETS: ReadonlyArray<{ minHeight: number; label: string }> = [
  { minHeight: 1921, label: "2160p" },
  { minHeight: 961, label: "1080p" },
  { minHeight: 641, label: "720p" },
  { minHeight: 421, label: "480p" },
  { minHeight: 0, label: "360p" },
];

export function resolutionLabel(height: number | null): string | null {
  if (height === null) return null;
  return RESOLUTION_BUCKETS.find((b) => height >= b.minHeight)?.label ?? null;
}

/** Real label for an alternate file: prefers the admin-set edition label,
 *  falls back to a resolution bucket from the file's own probed height,
 *  and finally the honest "alternate version" when neither is known (e.g.
 *  an unprobed file with no label). */
export function fallbackLabel(file: MediaFileSummary): string {
  if (file.versionLabel) return file.versionLabel;
  return resolutionLabel(file.height) ?? "alternate version";
}

/**
 * Probes every media file this item has via the real `POST /playback/plan`
 * preview (in array order — the first non-refused one wins; catalog order
 * carries no other significance here) and returns the first one the real
 * engine does NOT refuse. `device`/`network` are rebuilt via the same real
 * probing `createPlaybackSession` itself uses (lib/playback-session.ts) —
 * not cached across the two calls today (no such cache exists anywhere in
 * this codebase yet); both are pure/cheap browser-capability reads, so the
 * duplicate work is a minor, documented inefficiency, not a correctness
 * issue (identical inputs -> identical, deterministic answers).
 */
export async function findPlayableFallback(itemId: string, mediaFiles: readonly MediaFileSummary[]): Promise<FallbackCandidate | null> {
  if (mediaFiles.length === 0) return null;
  const serverUrl = getAuthStore().getSnapshot().serverUrl;
  const device = await buildDeviceProfile();
  const network = buildNetworkConditions(serverUrl);

  for (const file of mediaFiles) {
    try {
      const plan = await apiPost("/playback/plan", {
        body: { itemId, mediaFileId: file.id, device, network, mode: "stream" },
      });
      if (!isPlanRefused(plan)) {
        return { mediaFileId: file.id, label: fallbackLabel(file) };
      }
    } catch {
      // 404 (file removed mid-session)/422 (malformed request) — skip and
      // try the next file rather than surfacing a probe failure as if it
      // were a real refusal.
    }
  }
  return null;
}

/** "SWITCHED TO {label} — {mode}" (design/phosphor/README.md's toast copy,
 *  uppercased by Toast.module.css itself) — `mode` is the REAL resulting
 *  session's own `plan.decision`, read after the fallback session actually
 *  gets created, never assumed ahead of time. */
export function decisionLabel(decision: PlaybackPlan["decision"]): string {
  switch (decision) {
    case "direct-play":
      return "Direct Play";
    case "direct-stream":
      return "Direct Stream";
    case "remux":
      return "Remux";
    case "transcode":
      return "Transcode";
    default:
      return decision;
  }
}
