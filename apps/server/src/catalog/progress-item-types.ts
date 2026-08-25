// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/progress-item-types.ts
//
// Remediation d3-b9. The item types that can CARRY progress, in one place,
// because two files make the same statement about the same contract
// discriminator and drifting apart is what the finding was:
//
//   - progress.controller.ts (PUT /progress/{itemId}) refuses to write a
//     progress row for anything outside this set — a container has no
//     playable position, and a stored container row surfaces nowhere.
//   - cross-type.controller.ts (GET /home/continue-watching) pages over
//     exactly this set, which is also `ContinueWatchingEntry.item`'s
//     discriminator in packages/contract/openapi.yaml.
//
// If the contract's discriminator ever gains a type, this is the one line
// to widen; the two call sites follow automatically.

import type { ItemType } from "@loombre/db";

export const PROGRESS_BEARING_ITEM_TYPES: readonly ItemType[] = ["movie", "episode", "track"];

export function canCarryProgress(itemType: ItemType): boolean {
  return PROGRESS_BEARING_ITEM_TYPES.includes(itemType);
}
