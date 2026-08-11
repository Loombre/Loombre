// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Closed reason-code taxonomy — docs/PLAYBACK.md §4. Additions are contract
 * PRs against that document, never silent code divergence (design law 3:
 * "Reasons are the contract").
 */

/** Blocking-class: each forces at least the severity level it names. */
export type BlockingReasonCode =
  | "container-not-direct-playable"
  | "video-codec-unsupported"
  | "video-profile-unsupported"
  | "video-level-exceeds-device"
  | "video-bitdepth-unsupported"
  | "video-resolution-exceeds-device"
  | "video-framerate-exceeds-device"
  | "video-interlaced"
  | "hdr-tone-map-required"
  | "dv-profile5-requires-tonemap"
  | "tone-map-refused-by-policy"
  | "audio-codec-unsupported"
  | "audio-channels-exceed-device"
  | "audio-passthrough-unsupported"
  | "subtitle-format-requires-burn-in"
  | "subtitle-burn-in-for-styling"
  | "video-transcode-for-subtitle-burn-in"
  | "bitrate-exceeds-network"
  | "subtitle-codec-unknown"
  | "transcode-disabled-by-policy";

export const BLOCKING_REASON_CODES: readonly BlockingReasonCode[] = [
  "container-not-direct-playable",
  "video-codec-unsupported",
  "video-profile-unsupported",
  "video-level-exceeds-device",
  "video-bitdepth-unsupported",
  "video-resolution-exceeds-device",
  "video-framerate-exceeds-device",
  "video-interlaced",
  "hdr-tone-map-required",
  "dv-profile5-requires-tonemap",
  "tone-map-refused-by-policy",
  "audio-codec-unsupported",
  "audio-channels-exceed-device",
  "audio-passthrough-unsupported",
  "subtitle-format-requires-burn-in",
  "subtitle-burn-in-for-styling",
  "video-transcode-for-subtitle-burn-in",
  "bitrate-exceeds-network",
  "subtitle-codec-unknown",
  "transcode-disabled-by-policy",
];

/** Fixed (non-parameterized) informational-class codes. */
export type FixedInformationalReasonCode =
  | "dv-stripped-to-hdr10"
  | "subtitle-styling-lost"
  | "audio-atmos-lost"
  | "gapless-degraded"
  | "open-gop-leading-pictures-stripped"
  /**
   * LD-7 / owner-decision D1 (docs/PLAYBACK.md §4/§7.4, Wave C1). Fires once
   * per ladder rung whose configured/selected `av1` codec was demoted to
   * `hevc`/`h264` by §7.1(g)'s normalization step (three causes) or §7.2's
   * Stage-G software-route guard — BOTH its tier-0 arm (`tier0-software-route`)
   * and its verified-capabilities arm (`software-route-no-av1`), five in all.
   * `detail` is
   * `cause=<tier0-no-hw-av1|device-no-av1|no-av1-encoder|tier0-software-route|software-route-no-av1>
   * demotedTo=<hevc|h264> heightPx=<n>` — formatted in exactly one place,
   * `src/av1.ts`'s `av1DemotionReason` (whose `Av1DemotionCause` enum is the
   * source of truth for this list). It exists because a silent demotion
   * would leave design law 3's "why is this transcoding like this?"
   * unanswerable for AV1: the admin asking "why is this rung not AV1?" must
   * get an answer from the plan itself.
   */
  | "av1-rung-demoted"
  /**
   * LD-6 under LD-16 / owner-decision V2 (docs/PLAYBACK.md §4/§7.5, Wave
   * C2). Fires AT MOST ONCE per plan — SINGLE-FIRING by construction, not
   * by convention: §7.5's step (h) is one trim of one ladder, so there is
   * exactly one event to report no matter how many rungs it removed.
   * `detail` is `cap=<n> dropped=<heightPx>p@<videoBitrateBps>[,…]`,
   * naming EVERY dropped rung in table order — formatted in exactly one
   * place, `src/stages/ladder.ts`'s `capAdvertisedVariants`. It exists for
   * the same reason `av1-rung-demoted` does: a silent trim leaves "where
   * did my rungs go?" unanswerable from the plan an audit row stores, and
   * the answer ("Tier-0 advertises exactly
   * TIER0_MAX_ADVERTISED_VARIANTS") is a law the operator cannot find in
   * any settings screen — §7.5 deliberately makes it a tier law rather
   * than a knob.
   */
  | "ladder-variant-capped";

export const FIXED_INFORMATIONAL_REASON_CODES: readonly FixedInformationalReasonCode[] = [
  "dv-stripped-to-hdr10",
  "subtitle-styling-lost",
  "audio-atmos-lost",
  "gapless-degraded",
  "open-gop-leading-pictures-stripped",
  "av1-rung-demoted",
  "ladder-variant-capped",
];

/** `hw-encoder-selected:<backend>` — the chosen hardware backend suffixed. */
export type HwEncoderSelectedReasonCode = `hw-encoder-selected:${string}`;

/** `software-fallback:<cause>` — e.g. `software-fallback:decode`,
 * `software-fallback:encode`, `software-fallback:tier-capped`. */
export type SoftwareFallbackReasonCode = `software-fallback:${string}`;

export type InformationalReasonCode =
  | FixedInformationalReasonCode
  | HwEncoderSelectedReasonCode
  | SoftwareFallbackReasonCode;

/** The complete closed reason-code enum (blocking + informational). */
export type PlanReasonCode = BlockingReasonCode | InformationalReasonCode;

export function isBlockingReasonCode(code: PlanReasonCode): code is BlockingReasonCode {
  return (BLOCKING_REASON_CODES as readonly string[]).includes(code);
}

/**
 * A single fired reason. Matrix cases assert on `code`; golden tests assert
 * on the full object (docs/PLAYBACK.md §4).
 */
export interface PlanReason {
  code: PlanReasonCode;
  streamIndex?: number;
  detail?: string;
}
