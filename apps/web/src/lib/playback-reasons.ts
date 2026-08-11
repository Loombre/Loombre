// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-reasons.ts
//
// Human-readable copy for every docs/PLAYBACK.md §4 reason code (closed
// enum, mirrored in packages/contract/openapi.yaml's PlanReasonCode). Used
// by the /watch unavailable screen (deliverable 2 — this is an exit-gate
// surface: hevc-10bit and PGS fixtures must render correct reasons) to turn
// a failed session-create's `wouldBeReasons[]` into readable rows while
// still showing the raw code.

import type { components } from "@loombre/sdk";

type PlanReason = components["schemas"]["PlanReason"];

export type ReasonSeverity = "blocking" | "informational";

export interface ReasonCopy {
  title: string;
  detail: string;
  severity: ReasonSeverity;
}

const FIXED_REASONS: Record<string, ReasonCopy> = {
  "container-not-direct-playable": {
    title: "Container isn't directly playable",
    detail: "This file's container format isn't one your browser can play without repackaging.",
    severity: "blocking",
  },
  "video-codec-unsupported": {
    title: "Video codec unsupported",
    detail: "Your browser can't decode this file's video codec natively.",
    severity: "blocking",
  },
  "video-profile-unsupported": {
    title: "Video profile unsupported",
    detail: "The video's encoding profile exceeds what your browser has confirmed it can decode.",
    severity: "blocking",
  },
  "video-level-exceeds-device": {
    title: "Video level too high",
    detail: "The video's codec level exceeds this device's confirmed decode ceiling.",
    severity: "blocking",
  },
  "video-bitdepth-unsupported": {
    title: "Bit depth unsupported",
    detail: "This file's color bit depth (e.g. 10-bit HDR) isn't supported by your browser's decoder.",
    severity: "blocking",
  },
  "video-resolution-exceeds-device": {
    title: "Resolution too high",
    detail: "The video's resolution exceeds what your browser/device has confirmed it can decode.",
    severity: "blocking",
  },
  "video-framerate-exceeds-device": {
    title: "Frame rate too high",
    detail: "The video's frame rate exceeds this device's confirmed decode ceiling.",
    severity: "blocking",
  },
  "video-interlaced": {
    title: "Interlaced video",
    detail: "This file is interlaced; browsers require progressive video.",
    severity: "blocking",
  },
  "hdr-tone-map-required": {
    title: "HDR tone-mapping required",
    detail: "This file's HDR (HDR10/HLG) isn't supported by your display/browser and would need tone-mapping to SDR.",
    severity: "blocking",
  },
  "dv-profile5-requires-tonemap": {
    title: "Dolby Vision requires tone-mapping",
    detail: "This file is Dolby Vision profile 5 with no HDR10-compatible base layer, and your device doesn't support Dolby Vision.",
    severity: "blocking",
  },
  "tone-map-refused-by-policy": {
    title: "Tone-mapping disabled by server policy",
    detail: "This server's playback policy doesn't allow CPU tone-mapping (protects small/low-power servers).",
    severity: "blocking",
  },
  "audio-codec-unsupported": {
    title: "Audio codec unsupported",
    detail: "Your browser can't decode this file's audio codec natively.",
    severity: "blocking",
  },
  "audio-channels-exceed-device": {
    title: "Too many audio channels",
    detail: "This file's channel count (e.g. 5.1/7.1) exceeds what your browser/device supports.",
    severity: "blocking",
  },
  "audio-passthrough-unsupported": {
    title: "Bitstream passthrough unsupported",
    detail: "This file's audio (TrueHD/DTS-HD) requires bitstream passthrough, which the web platform doesn't support.",
    severity: "blocking",
  },
  "subtitle-format-requires-burn-in": {
    title: "Subtitles require burn-in",
    detail: "The selected subtitle format can't be rendered as a text/side track and would need to be burned into the video.",
    severity: "blocking",
  },
  "subtitle-burn-in-for-styling": {
    title: "Subtitle styling requires burn-in",
    detail: "Preserving this subtitle's styling (e.g. ASS) requires burning it into the video.",
    severity: "blocking",
  },
  "video-transcode-for-subtitle-burn-in": {
    title: "Video transcode required for subtitles",
    detail: "Burning in the selected subtitle requires transcoding the video, even though it would otherwise play directly.",
    severity: "blocking",
  },
  "bitrate-exceeds-network": {
    title: "Bitrate exceeds network conditions",
    detail: "This file's bitrate exceeds your current network's estimated ceiling.",
    severity: "blocking",
  },
  "subtitle-codec-unknown": {
    title: "Unrecognized subtitle format",
    detail: "This subtitle track's format wasn't recognized; treated conservatively as needing burn-in.",
    severity: "blocking",
  },
  "transcode-disabled-by-policy": {
    title: "Transcoding disabled",
    detail: "This server's policy has transcoding turned off entirely.",
    severity: "blocking",
  },
  "dv-stripped-to-hdr10": {
    title: "Dolby Vision metadata stripped to HDR10",
    detail: "Playing the HDR10-compatible base layer directly; Dolby Vision dynamic metadata is not applied.",
    severity: "informational",
  },
  "subtitle-styling-lost": {
    title: "Subtitle styling lost",
    detail: "This subtitle's custom styling (fonts/positioning) isn't preserved when rendered as a plain text track.",
    severity: "informational",
  },
  "audio-atmos-lost": {
    title: "Atmos lost",
    detail: "This file's Dolby Atmos object audio isn't preserved by the delivered audio.",
    severity: "informational",
  },
  "gapless-degraded": {
    title: "Gapless playback degraded",
    detail: "This audio isn't served in a way that supports seamless gapless playback.",
    severity: "informational",
  },
  "open-gop-leading-pictures-stripped": {
    title: "A few lead-in frames were dropped after seeking",
    detail: "Seeking in this video required dropping a handful of leading frames right at the seek point to keep the picture clean; playback is otherwise untouched.",
    severity: "informational",
  },
};

/** Phase 2 direct-play never emits these (they belong to Stage G hardware
 *  routing, which isn't implemented until Phase 3 — STATE.md P2.17), but
 *  the map covers the full §4 enum per the pattern-typed families so the
 *  UI is forward-honest if a future preview ever includes them. */
function patternCopy(code: string): ReasonCopy | null {
  const hwMatch = /^hw-encoder-selected:(.+)$/.exec(code);
  if (hwMatch) {
    return {
      title: "Hardware encoder selected",
      detail: `Server picked the ${hwMatch[1]} hardware backend for this transcode.`,
      severity: "informational",
    };
  }
  const swMatch = /^software-fallback:(.+)$/.exec(code);
  if (swMatch) {
    return {
      title: "Software fallback",
      detail: `Fell back to software processing (${swMatch[1]}) — no verified hardware path was available.`,
      severity: "informational",
    };
  }
  return null;
}

export function describeReasonCode(code: string): ReasonCopy {
  return (
    FIXED_REASONS[code] ??
    patternCopy(code) ?? {
      title: code,
      detail: "Unrecognized reason code — this build's reason copy map may be behind the server's contract.",
      severity: "blocking",
    }
  );
}

/**
 * Phase 3 §11 step 6c: `TRANSCODE_SLOTS_EXHAUSTED_CODE` is NOT a server
 * `PlanReasonCode` — the 429 response (docs/PLAYBACK.md §9's
 * `maxSimultaneousTranscodes` admission semaphore,
 * packages/contract/openapi.yaml's `createPlaybackSession` 429) carries no
 * `wouldBeReasons` extension member (only the 409 "genuinely unplayable"
 * response documents that extension), so there is no real reason code to
 * describe. This is a client-synthesized stand-in, following the exact
 * same {code, title, detail, severity} shape as every real reason so
 * UnavailableScreen.tsx needs no separate rendering path for it.
 */
export const TRANSCODE_SLOTS_EXHAUSTED_CODE = "transcode-slots-exhausted";

FIXED_REASONS[TRANSCODE_SLOTS_EXHAUSTED_CODE] = {
  title: "Server is at capacity",
  detail: "Every transcode slot is in use right now. Wait a moment and try again.",
  severity: "blocking",
};

/** `TRANSCODE_SLOTS_EXHAUSTED_CODE` is deliberately outside the contract's
 *  closed `PlanReasonCode` enum (it's client-synthesized — see above), so
 *  building a `PlanReason` with it needs one narrow, documented cast rather
 *  than widening `PlanReason.code` itself to plain `string` everywhere. */
function transcodeSlotsExhaustedReason(): PlanReason {
  return { code: TRANSCODE_SLOTS_EXHAUSTED_CODE, streamIndex: null, detail: null } as PlanReason;
}

/**
 * Reconciles a failed `createPlaybackSession`/`createDirectPlaySession`
 * result's `(status, wouldBeReasons)` into the reasons array
 * UnavailableScreen.tsx actually renders: a 429 has no real reasons to
 * show (see above), so it's swapped for the one synthesized reason above
 * whenever the server didn't happen to send anything else; every other
 * status renders exactly what the server said (including a genuinely empty
 * array, which UnavailableScreen.tsx already renders as "No specific
 * reason was reported").
 */
export function resolveUnavailableReasons(status: number, wouldBeReasons: readonly PlanReason[]): PlanReason[] {
  if (status === 429 && wouldBeReasons.length === 0) {
    return [transcodeSlotsExhaustedReason()];
  }
  return [...wouldBeReasons];
}
