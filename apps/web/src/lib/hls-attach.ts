// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/hls-attach.ts
//
// Phase 3 §11 step 6c: the pure "how should this session's video get onto
// the <video> element" decision. Three outcomes:
//   - 'direct-play': session.manifestUrl is null (docs/PLAYBACK.md §9 —
//     direct-play bypasses HLS packaging entirely) -> the existing P2.4
//     file-serving path, unchanged.
//   - 'hlsjs': the session needs HLS and Media Source Extensions are
//     available (every modern desktop browser, Chrome/Firefox/Edge AND
//     desktop Safari) -> dynamically import hls.js and attach it.
//   - 'native-hls': the session needs HLS, MSE is NOT available, and the
//     browser's own <video> element reports native HLS support — in
//     practice iOS Safari, the one HLS-capable environment without MSE.
//
// ORDER RATIONALE (step 7 owner-smoke finding, found in a REAL browser —
// the class of bug unit tests cannot see): Chrome on macOS answers "maybe"
// to `canPlayType('application/vnd.apple.mpegurl')` while having NO
// working native HLS playback — the original native-first table handed
// Chrome the manifest as a plain src and the element died with
// MEDIA_ERR_SRC_NOT_SUPPORTED. canPlayType is advisory and dishonest here;
// MSE availability is a hard capability fact. So hls.js-first whenever MSE
// exists (hls.js's own documented recommendation), native only as the
// no-MSE fallback.
//
// Deliberately takes plain booleans, not the SDK's PlaybackSession/
// DOM types, so it needs no session fixture or real <video> element to
// unit test — VideoPlayer.tsx supplies the real values.

export type AttachStrategy = "direct-play" | "native-hls" | "hlsjs";

/**
 * Truth table:
 *
 * | usesHls | mseAvailable | canPlayNativeHls | -> AttachStrategy |
 * |---------|--------------|------------------|-------------------|
 * | false   | *            | *                | direct-play       |
 * | true    | true         | *                | hlsjs             |
 * | true    | false        | true             | native-hls        |
 * | true    | false        | false            | hlsjs (last-ditch — Hls.isSupported() will surface the real error) |
 */
export function decideAttachStrategy(usesHls: boolean, mseAvailable: boolean, canPlayNativeHls: boolean): AttachStrategy {
  if (!usesHls) return "direct-play";
  if (mseAvailable) return "hlsjs";
  return canPlayNativeHls ? "native-hls" : "hlsjs";
}

/** `video.canPlayType('application/vnd.apple.mpegurl')` returns '', 'maybe',
 *  or 'probably' — any non-empty answer counts as "claims native HLS", but
 *  per the ORDER RATIONALE above this claim is only ever consulted when MSE
 *  is absent (Chrome answers "maybe" while having no native HLS at all). */
export function isNativeHlsSupported(canPlayTypeResult: string): boolean {
  return canPlayTypeResult !== "";
}

/** Hard MSE capability check — `Hls.isSupported()`'s own precondition,
 *  evaluated without importing hls.js (the import is deferred until the
 *  hlsjs strategy actually attaches). */
export function isMseAvailable(win: { MediaSource?: unknown }): boolean {
  return typeof win.MediaSource !== "undefined";
}
