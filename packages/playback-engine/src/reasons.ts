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
   * `hevc`/`h264` by §7.1(g)'s normalization step or §7.2's Stage-G tier-0
   * software-route guard. `detail` is
   * `cause=<tier0-no-hw-av1|device-no-av1|no-av1-encoder|tier0-software-route>
   * demotedTo=<hevc|h264> heightPx=<n>` — formatted in exactly one place,
   * `src/av1.ts`'s `av1DemotionReason`. It exists because a silent demotion
   * would leave design law 3's "why is this transcoding like this?"
   * unanswerable for AV1: the admin asking "why is this rung not AV1?" must
   * get an answer from the plan itself.
   */
  | "av1-rung-demoted";

export const FIXED_INFORMATIONAL_REASON_CODES: readonly FixedInformationalReasonCode[] = [
  "dv-stripped-to-hdr10",
  "subtitle-styling-lost",
  "audio-atmos-lost",
  "gapless-degraded",
  "open-gop-leading-pictures-stripped",
  "av1-rung-demoted",
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
