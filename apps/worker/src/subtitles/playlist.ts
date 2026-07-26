// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Segmented-VTT subtitle side-track playlist rendering (docs/PLAYBACK.md
 * §9, P3.9(e), Phase 3 §11 step 6b). Unlike the video HLS playlist
 * (../transcode/playlist.ts), a subtitle side-track is always exactly ONE
 * segment — the whole extracted WebVTT file, whose duration is the
 * session's media's own full duration (never re-segmented, never updated
 * again once written: this is a VOD-style playlist, not an EVENT one, since
 * the subtitle track needs no live-append semantics the way an in-progress
 * transcode's video playlist does).
 *
 * Pure (no fs access) — mirrors ../transcode/playlist.ts's own
 * pure/impure split so this is unit-testable without a real ffmpeg run.
 */
export function renderSubtitlePlaylist(durationSec: number, segmentUri: string): string {
  const safeDurationSec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const targetDurationSec = Math.max(1, Math.ceil(safeDurationSec));

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${targetDurationSec}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${safeDurationSec.toFixed(3)},`,
    segmentUri,
    "#EXT-X-ENDLIST",
  ];
  return lines.join("\n") + "\n";
}
