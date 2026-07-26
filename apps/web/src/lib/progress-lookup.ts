// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/progress-lookup.ts
//
// The gap-closure lane added GET /progress/{itemId} (O(1) single-item
// lookup, 404 when the item has no progress row OR isn't visible to the
// caller — see the contract's operation doc). findProgressForItem tries
// that first; on any failure OTHER than a real "no progress" 404 it falls
// back to the bounded list-walk this module used to do exclusively (kept
// below as `findProgressForItemViaListWalk` — cheap insurance if the
// single-item route is ever unreachable on an older/mismatched server,
// per the task brief: "just try it and fall back to the list walk on
// failure").

import type { components } from "@loombre/sdk";
import { apiGet, LoombreApiError } from "./api-client.js";

type Progress = components["schemas"]["Progress"];
type ProgressPage = components["schemas"]["ProgressPage"];

const MAX_PAGES = 10;
const PAGE_LIMIT = 100;

async function findProgressForItemViaListWalk(itemId: string): Promise<Progress | null> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: ProgressPage = await apiGet("/progress", {
      params: { query: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } },
    });
    const hit = result.items.find((p) => p.itemId === itemId);
    if (hit) return hit;
    if (!result.nextCursor) return null;
    cursor = result.nextCursor;
  }
  return null;
}

export async function findProgressForItem(itemId: string): Promise<Progress | null> {
  try {
    return await apiGet("/progress/{itemId}", { params: { path: { itemId } } });
  } catch (err) {
    if (err instanceof LoombreApiError && err.status === 404) return null; // genuinely no progress
    return findProgressForItemViaListWalk(itemId);
  }
}

/** Resume is only worth offering when there's meaningful progress: not
 *  basically-the-start, and not basically-finished. */
export function isWorthResuming(progress: Progress): boolean {
  if (progress.state !== "in-progress") return false;
  if (progress.positionMs < 5_000) return false;
  if (typeof progress.durationMs === "number" && progress.durationMs - progress.positionMs < 15_000) return false;
  return true;
}
