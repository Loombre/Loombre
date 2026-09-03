// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/subtitle-selection.ts
//
// What a subtitle pick in the player's track picker means for the session.
// A text subtitle is delivered as a per-session WebVTT side-track
// (docs/PLAYBACK.md Stage E 'hls-vtt': the session is created pinned to
// the stream via PlanRequest.selection.subtitleStreamIndex, the
// subtitle-extract worker writes sub0.vtt, VideoPlayer attaches it as a
// <track>). So picking a stream the current session did NOT extract needs
// a NEW session; picking the one it did extract, or Off, is purely
// client-side — the <track> element is shown or dropped, nothing is
// minted or ended. Pure by design (no React, no DOM) so the three
// outcomes are unit-tested without a player.

export interface PlanSubtitleLike {
  subtitle: { strategy: string; streamIndex?: number };
}

export type SubtitleSelectionAction =
  | { kind: "hide" }
  | { kind: "show" }
  | { kind: "recreate"; subtitleStreamIndex: number };

/** `index === null` is Off. `plan` is the CURRENT session's plan (null before
 *  a session exists). */
export function decideSubtitleSelection(
  plan: PlanSubtitleLike | null,
  index: number | null,
): SubtitleSelectionAction {
  if (index === null) return { kind: "hide" };
  if (
    plan !== null &&
    plan.subtitle.strategy === "hls-vtt" &&
    plan.subtitle.streamIndex === index
  )
    return { kind: "show" };
  return { kind: "recreate", subtitleStreamIndex: index };
}

/** Whether the side-track `<track>` should be in the DOM: only when the
 *  picker's selection names exactly the stream this session's side-track
 *  carries (so a just-requested different stream never shows the OLD
 *  session's captions while the pinned re-create is in flight). */
export function isSubtitleTrackShown(
  selectedIndex: number | null,
  plan: PlanSubtitleLike | null,
): boolean {
  if (selectedIndex === null || plan === null) return false;
  return (
    plan.subtitle.strategy === "hls-vtt" &&
    plan.subtitle.streamIndex === selectedIndex
  );
}
