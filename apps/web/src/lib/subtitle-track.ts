// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/subtitle-track.ts
//
// Phase 3 §11 step 6c, deliverable 3: derives the (single, always-on)
// `<track kind="subtitles">` VideoPlayer.tsx attaches when the session's
// plan chose the segmented-VTT side-track strategy (docs/PLAYBACK.md §9,
// STATE.md P3.9(e)) — `subtitle.strategy === 'hls-vtt'`. The other three
// strategies need nothing from the player: `burn-in` is already baked into
// the video frames, `embed` and `none` have no side-track to attach.
//
// Pure by design (no DOM, no fetch) — `subtitleUrl` is supplied by the
// caller (lib/media-session-url.ts's `buildHlsSubtitleUrl`), and
// `subtitleStreams` is the session's own `media.subtitle[]` (already-probed
// metadata), so this is a straight lookup + label derivation, trivially
// unit-testable against fixture data.

export interface SubtitleStreamLike {
  index: number;
  language: string | null;
}

export interface SubtitleTrackInfo {
  src: string;
  /** Human-readable label for the <track> element (e.g. a <select> of
   *  tracks would show this) — the stream's own language when known,
   *  else a generic fallback (never blank). */
  label: string;
  /** BCP-47-ish language tag for the <track lang> attribute; undefined
   *  when the stream's language wasn't known (matches the SubtitleStream
   *  contract shape, where `language` is nullable). */
  lang: string | undefined;
}

/**
 * Returns the info needed to render the `<track>` element, or `null` when
 * this plan's subtitle strategy isn't `'hls-vtt'` (nothing to attach).
 *
 * `streamIndex` is `plan.subtitle.streamIndex` (the stream the session
 * layer actually selected and extracted — optional per the contract's
 * `SubtitleAction` schema, absent for strategies with no single source
 * stream). When present but not found in `subtitleStreams` (shouldn't
 * happen against a session's own media, but never trust an index match to
 * exist), the label falls back to the same generic string as "no index at
 * all" rather than throwing.
 */
export function deriveSubtitleTrackInfo(
  strategy: string,
  streamIndex: number | undefined,
  subtitleStreams: readonly SubtitleStreamLike[],
  subtitleUrl: string,
): SubtitleTrackInfo | null {
  if (strategy !== "hls-vtt") return null;

  const stream = streamIndex !== undefined ? subtitleStreams.find((s) => s.index === streamIndex) : undefined;
  const language = stream?.language ?? null;

  return {
    src: subtitleUrl,
    label: language ? language.toUpperCase() : "Subtitles",
    lang: language ?? undefined,
  };
}
