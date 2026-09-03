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
  "ladder-variant-capped": {
    title: "Some quality levels were capped",
    detail: "The bitrate ladder was trimmed to this server's advertised-variant limit; the highest rung(s) were dropped.",
    severity: "informational",
  },
  // d3-aq4 (LD-7 / owner-decision D1, docs/PLAYBACK.md §4/§7.4): fires once
  // per ladder rung whose configured av1 codec was demoted to hevc/h264 —
  // no hardware AV1 encoder, an unverified software route, or a device that
  // can't decode it. The rung still exists at the same height/bitrate, so
  // this is informational: only the codec changed, never the quality level.
  // (`detail` carries `cause=… demotedTo=… heightPx=…`, which the reason row
  // already prints verbatim beside the code.)
  "av1-rung-demoted": {
    title: "A quality level isn't using AV1",
    detail: "This quality level was encoded with HEVC or H.264 instead of AV1 — the same rung, a different codec, because no verified AV1 encode path was available.",
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

/**
 * VideoPlayer.tsx's direct-play/native-HLS attach effect (task #6, 2026-08-10
 * opus review findings 1c/1-exhausted-budget): a CLIENT-side unrecoverable
 * media failure — either the browser flatly refused the source
 * (MEDIA_ERR_SRC_NOT_SUPPORTED/MEDIA_ERR_DECODE, which no reattach can fix)
 * or every bounded recovery retry in a stretch already failed identically.
 * Neither one has a server HTTP status behind it at all (no
 * createPlaybackSession call even happened), so — same precedent as
 * `TRANSCODE_SLOTS_EXHAUSTED_CODE` above — this is a second client-
 * synthesized reason outside the contract's closed `PlanReasonCode` enum,
 * following the identical {code, title, detail, severity} shape so
 * UnavailableScreen.tsx needs no separate rendering path for it either.
 */
export const CLIENT_PLAYBACK_ERROR_CODE = "client-playback-error";

FIXED_REASONS[CLIENT_PLAYBACK_ERROR_CODE] = {
  title: "Playback failed in this browser",
  detail: "Your browser reported it can't play this stream and no retry recovered it.",
  severity: "blocking",
};

function clientPlaybackErrorReason(): PlanReason {
  return { code: CLIENT_PLAYBACK_ERROR_CODE, streamIndex: null, detail: null } as PlanReason;
}

/** The reasons array UnavailableScreen.tsx renders for the client-side
 *  unrecoverable-playback-error path above — always this one synthesized
 *  reason, never merged with any server-provided reasons (none exist for a
 *  failure that never involved a createPlaybackSession call). */
export function clientPlaybackErrorReasons(): PlanReason[] {
  return [clientPlaybackErrorReason()];
}

/**
 * QA C/gap-F9-followup: `/watch/{id}` for an id that resolves to NOTHING —
 * every kind probe in lib/item-lookup.ts 404s (a deleted item, a mistyped
 * id, restricted content the query guard filters out), or the lookup fails
 * outright — renders UnavailableScreen, which is otherwise the screen for a
 * plan the ENGINE refused. No plan was ever made here and no session was
 * ever requested, so there are no server reasons to show and the screen fell
 * back to "No specific reason was reported." — true, and useless to read.
 * Third client-synthesized reason, same {code,title,detail,severity} shape
 * and the same out-of-contract-enum caveat as the two above, so
 * UnavailableScreen.tsx still needs no separate rendering path.
 *
 * The copy deliberately says nothing about the item beyond "we couldn't open
 * it": for a restricted or ungranted id, revealing that it EXISTS would be a
 * containment leak (the whole point of the guard that hid it).
 */
export const ITEM_UNAVAILABLE_CODE = "item-unavailable";

FIXED_REASONS[ITEM_UNAVAILABLE_CODE] = {
  title: "This link didn't lead to anything playable",
  detail: "The server returned no movie, episode, track or album for it. It may have been removed, or it may not be available to your account.",
  severity: "blocking",
};

function itemUnavailableReason(): PlanReason {
  return { code: ITEM_UNAVAILABLE_CODE, streamIndex: null, detail: null } as PlanReason;
}

/** The reasons array app/watch/[itemId]/page.tsx renders when the item never
 *  resolved — always exactly this one synthesized reason. */
export function itemUnavailableReasons(): PlanReason[] {
  return [itemUnavailableReason()];
}

/**
 * SPF-7 Phase B: `CLIENT_PLAYBACK_ERROR_CODE` above used to be the ONLY
 * code a client-side unrecoverable failure could render — every hls.js
 * error type/details/HTTP status, MediaError code, and stalled position
 * dropped on the floor. `goFatal` (VideoPlayer.tsx) now renders one of
 * these eight instead, whenever the session inspect confirms the failure
 * isn't server-side (lib/playback-recovery.ts's `describeClientFailure`/
 * `clientFailureReasons` build the {code, detail} pair; this map supplies
 * the {title, detail-copy, severity} UnavailableScreen actually shows —
 * same out-of-contract-enum precedent, same reason UnavailableScreen.tsx
 * needs no separate rendering path). `CLIENT_PLAYBACK_ERROR_CODE` itself
 * stays as the last-resort fallback for a media-error cause with no
 * `MediaError` attached at all.
 */
FIXED_REASONS["client-media-aborted"] = {
  title: "Playback was aborted",
  detail: "Your browser aborted loading this stream. Retry.",
  severity: "blocking",
};

FIXED_REASONS["client-media-network-error"] = {
  title: "The browser lost the stream",
  detail: "Your browser lost the stream mid-playback. Retry; check the connection.",
  severity: "blocking",
};

FIXED_REASONS["client-media-decode-error"] = {
  title: "Your browser couldn't decode this stream",
  detail: "Your browser's decoder rejected this stream. Try another browser or device.",
  severity: "blocking",
};

FIXED_REASONS["client-media-src-not-supported"] = {
  title: "Your browser refused this stream format",
  detail: "Your browser refused this stream format outright. Try another browser or device.",
  severity: "blocking",
};

FIXED_REASONS["hls-network-error"] = {
  title: "The stream stopped loading",
  detail:
    "Segments stopped arriving from the server — a 503 usually means it was restarting the converter for a seek and didn't finish in time. Retry, and if it keeps happening check the server's playback log.",
  severity: "blocking",
};

FIXED_REASONS["hls-media-error"] = {
  title: "Your browser couldn't decode a segment",
  detail: "The player couldn't append or decode a video segment it received. Retry; if it recurs, try a different browser or quality level.",
  severity: "blocking",
};

FIXED_REASONS["hls-fatal-error"] = {
  title: "Playback failed",
  detail: "The player hit an error it can't classify. Retry; report the detail if it recurs.",
  severity: "blocking",
};

FIXED_REASONS["playback-stalled"] = {
  title: "Playback stalled",
  detail: "Playback stopped advancing for ten seconds and the player couldn't recover. Retry; check the connection and the server's load.",
  severity: "blocking",
};
