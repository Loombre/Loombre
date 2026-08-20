// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/stored-plan-facts.ts
//
// The two facts a route needs from a session's STORED plan (a JSONB blob),
// read defensively — a malformed blob must degrade to "no ladder"/"no
// decision", never throw on a media path. Extracted from
// hls-file.controller.ts (V8) so the seek endpoint reads the same facts
// through the same guards instead of a second copy drifting.

import type { MasterPlaylistRung } from "../common/master-playlist.js";

/** The rungs of the session's STORED plan — the single authority on which
 *  variants exist (§7.5: "the master playlist advertises `plan.ladder` —
 *  nothing else, and all of it"). */
export function storedLadder(plan: Record<string, unknown> | null): MasterPlaylistRung[] {
  const ladder = plan && typeof plan === "object" ? (plan as { ladder?: unknown }).ladder : undefined;
  if (!Array.isArray(ladder)) return [];
  return ladder.filter(
    (r): r is MasterPlaylistRung =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as MasterPlaylistRung).heightPx === "number" &&
      typeof (r as MasterPlaylistRung).videoBitrateBps === "number",
  );
}

export function storedDecision(plan: Record<string, unknown> | null): string | undefined {
  const decision = plan && typeof plan === "object" ? (plan as { decision?: unknown }).decision : undefined;
  return typeof decision === "string" ? decision : undefined;
}
