// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dolby Vision strip predicate (LD-3 / LD-15, docs/PLAYBACK.md §3 Stage C
 * + §6 segment 7).
 *
 * ONE rule, TWO consumers. `stages/hdr.ts` uses it to decide whether the
 * informational reason `dv-stripped-to-hdr10` fires; `args/builder.ts`
 * uses it to decide whether the video-COPY branch emits the strip. Before
 * this module they were separate derivations of the same fact — which is
 * precisely how the reason came to claim a strip the builder never
 * performed. Keeping the predicate in one place makes that particular
 * drift structurally impossible rather than merely discouraged.
 *
 * WHY THE BUILDER DERIVES THIS INSTEAD OF READING A PLAN FLAG (unlike the
 * open-GOP strip, which rides on `PlaybackPlanVideo.openGop`):
 * `packages/contract/openapi.yaml`'s `VideoAction` schema is
 * `additionalProperties: false`, and `apps/server/test/
 * contract-reason-codes.spec.ts`-style conformance holds the plan shape to
 * it. Adding a `dvStrip` field to `PlaybackPlanVideo` would therefore be a
 * CONTRACT change, which this wave is not permitted to make. The builder
 * already receives the full `PlanInput` (media + device + selection), so
 * the fact is derivable there with no contract surface at all — strictly
 * better than a new field regardless of the constraint.
 *
 * Pure: no I/O, no clock, no framework.
 */
import type { DeviceProfile, VideoStream } from "./types.js";

/**
 * True when a video COPY of `stream` for `device` must be stripped of its
 * Dolby Vision layer and served as plain HDR10.
 *
 * Mirrors Stage C's profile-7/8 branch exactly (docs/PLAYBACK.md §3):
 *   - the stream really is Dolby Vision, and
 *   - its profile is 7 or 8 — the profiles that CAN carry an
 *     HDR10-compatible base layer (profile 5 has none, so it tone-maps
 *     rather than strips, and an unrecognized profile is treated as 5
 *     conservatively), and
 *   - `dvBlCompatId` is non-null, i.e. the base layer is marked
 *     HDR10-compatible (§2.1's own field comment; no allowlist of "which
 *     compat ids count" exists in the spec, so any non-null value marks
 *     it), and
 *   - the device can consume that HDR10 base layer, and
 *   - the device CANNOT play Dolby Vision itself — if it can, the DV layer
 *     is exactly what it wants and stripping would destroy the point.
 *
 * The CONTAINER condition is deliberately absent: the strip only ever
 * happens during a repackage, and a repackage is the only circumstance in
 * which either consumer asks. `stages/hdr.ts` gates on
 * `containerDirectPlayable === false` for the reason; `args/builder.ts`
 * is never called at all for a direct-play plan (it throws on
 * `container === 'source'`), so reaching the builder IS the container
 * condition.
 */
export function dvStripApplies(stream: VideoStream, device: DeviceProfile): boolean {
  if (stream.hdr !== "dv") return false;
  if (stream.dvProfile !== 7 && stream.dvProfile !== 8) return false;
  if (stream.dvBlCompatId === null) return false;
  if (!device.hdr.hdr10) return false;
  if (device.hdr.dolbyVision) return false;
  return true;
}

/**
 * True when the source is DUAL-LAYER Dolby Vision (profile 7: a base layer
 * plus a separate enhancement layer, LD-15). The EL is dropped by the same
 * strip — it is meaningless without the RPU that drives it, and leaving it
 * behind would ship an HDR10 stream padded with undecodable payload.
 * Profile 8 is single-layer by construction, so there is nothing to drop.
 */
export function dvHasEnhancementLayer(stream: VideoStream): boolean {
  return stream.hdr === "dv" && stream.dvProfile === 7;
}

/**
 * HEVC NAL unit types carrying Dolby Vision data. Rec. ITU-T H.265 Table
 * 7-1 reserves 48-63 as UNSPECIFIED; Dolby's streams specification places
 * the RPU at 62 and the enhancement layer at 63. Expressed as a
 * `filter_units` range because that is the form the arg builder emits, and
 * because a range composes cleanly with the open-GOP strip's own `8-9`.
 */
export const DV_NAL_REMOVE_RANGE = "62-63";
