// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage A — Container (docs/PLAYBACK.md §3, quoted verbatim):
 *
 *   "Stage A — Container. If `media.container ∈ device.directPlayContainers`
 *   AND every SELECTED stream is playable as-is (checked by later stages
 *   returning copy verdicts) → candidate `direct-play`. Otherwise container
 *   repackaging is required → at least `direct-stream`, reason
 *   `container-not-direct-playable`. (A is re-evaluated after B–E:
 *   direct-play requires ALL of B–E to be `copy`.)"
 *
 * This module answers ONLY the container-membership half of that sentence.
 * "Every SELECTED stream is playable as-is" is the max() aggregation across
 * every OTHER stage's verdict, performed once by src/plan.ts's final
 * assembly (docs/PLAYBACK.md §3 preamble: "the final decision is the max
 * severity across stages") — Stage A itself never looks at streams, and
 * that is by design: it is a pure function of (container, directPlayContainers)
 * only, exactly as the module layout in docs/PLAYBACK.md §1 implies by
 * giving container its own single-purpose stage file.
 */
import type { DeviceProfile, MediaInfo } from "../types.js";
import type { PlanReason } from "../reasons.js";
import type { StageResult } from "./types.js";

export function evaluateContainer(media: MediaInfo, device: DeviceProfile): StageResult {
  if (device.directPlayContainers.includes(media.container)) {
    return { verdict: "direct-play", reasons: [] };
  }

  // No streamIndex: container is a MediaInfo property, not a stream property
  // (docs/PLAYBACK.md §4: "Every reason carries `{ code, streamIndex?,
  // detail? }`" — streamIndex is omitted, never `undefined`, to satisfy
  // `exactOptionalPropertyTypes`).
  const reason: PlanReason = {
    code: "container-not-direct-playable",
    detail: `container=${media.container}`,
  };
  return { verdict: "direct-stream", reasons: [reason] };
}
