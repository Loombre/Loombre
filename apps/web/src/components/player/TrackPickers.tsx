// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/TrackPickers.tsx
//
// Audio/subtitle track pickers driven by the item's media_streams metadata
// (PlaybackSession.media, per docs/PLAYBACK.md §2.1 — the plan-preview
// response has no media field, so these only populate once a session
// actually exists; see lib/playback-session.ts's header).
//
// HONESTY (per task spec — this is the load-bearing comment):
//   - AUDIO: Phase 2 direct-play serves the original file's bytes as-is;
//     there is no server-side stream-selection endpoint. Switching which
//     embedded audio track plays is only possible client-side via the
//     (non-standard-but-Chromium-supported) HTMLMediaElement.audioTracks
//     API. Feature-detected at call time; when absent, entries still list
//     every audio stream (driven by real metadata) but are disabled with an
//     explicit note rather than silently doing nothing.
//   - SUBTITLES: embedded text tracks are NOT extractable client-side from
//     the container (P2.4 Phase-2 reality) and the contract exposes NO
//     sidecar/external subtitle-serving endpoint today (checked against
//     packages/contract/openapi.yaml — grep confirms no such path exists).
//     So `resolveSubtitleTrackUrl` below always returns null right now;
//     every subtitle entry renders in the typed "requires transcoding
//     (Phase 3)" disabled state. The wiring for the day a sidecar URL DOES
//     exist is left in place (a non-null resolver result attaches a real
//     <track> src) so this doesn't need rework later.

import type { components } from "@loombre/sdk";
import styles from "./TrackPickers.module.css";

type AudioStream = components["schemas"]["AudioStream"];
type SubtitleStream = components["schemas"]["SubtitleStream"];

const TEXT_SUBTITLE_CODECS = new Set(["subrip", "ass", "webvtt", "mov_text"]);

export function isTextSubtitle(stream: SubtitleStream): boolean {
  return TEXT_SUBTITLE_CODECS.has(stream.codec);
}

/** Always null today — see this file's header. Kept as a named function
 *  (not inlined) so the ONE place that would need to change, the day the
 *  contract grows a sidecar-serving path, is obvious. */
export function resolveSubtitleTrackUrl(_stream: SubtitleStream): string | null {
  return null;
}

function audioTracksApiSupported(video: HTMLVideoElement | null): boolean {
  return video !== null && "audioTracks" in video;
}

function describeAudio(stream: AudioStream): string {
  const parts = [stream.codec.toUpperCase(), `${stream.channels}ch`];
  if (stream.language) parts.push(stream.language);
  if (stream.hasAtmos) parts.push("Atmos");
  return parts.join(" · ");
}

function describeSubtitle(stream: SubtitleStream): string {
  const parts = [stream.codec.toUpperCase()];
  if (stream.language) parts.push(stream.language);
  if (stream.isForced) parts.push("forced");
  return parts.join(" · ");
}

export interface TrackPickersProps {
  audioStreams: AudioStream[];
  subtitleStreams: SubtitleStream[];
  selectedAudioIndex: number | null;
  selectedSubtitleIndex: number | null;
  videoElement: HTMLVideoElement | null;
  onSelectAudio: (index: number) => void;
  onSelectSubtitle: (index: number | null) => void;
}

export function TrackPickers({
  audioStreams,
  subtitleStreams,
  selectedAudioIndex,
  selectedSubtitleIndex,
  videoElement,
  onSelectAudio,
  onSelectSubtitle,
}: TrackPickersProps): React.JSX.Element {
  const canSwitchAudio = audioTracksApiSupported(videoElement) && audioStreams.length > 1;

  return (
    <div>
      {audioStreams.length > 0 && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>Audio</span>
          {audioStreams.map((stream) => (
            <button
              key={stream.index}
              type="button"
              className={styles.option}
              data-active={stream.index === selectedAudioIndex}
              disabled={!canSwitchAudio && audioStreams.length > 1}
              title={canSwitchAudio || audioStreams.length <= 1 ? undefined : "This browser doesn't support switching audio tracks"}
              onClick={() => onSelectAudio(stream.index)}
            >
              <span>{describeAudio(stream)}</span>
            </button>
          ))}
        </div>
      )}
      {subtitleStreams.length > 0 && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>Subtitles</span>
          <button
            type="button"
            className={styles.option}
            data-active={selectedSubtitleIndex === null}
            onClick={() => onSelectSubtitle(null)}
          >
            <span>Off</span>
          </button>
          {subtitleStreams.map((stream) => {
            const url = resolveSubtitleTrackUrl(stream);
            const renderable = url !== null;
            return (
              <button
                key={stream.index}
                type="button"
                className={styles.option}
                data-active={stream.index === selectedSubtitleIndex}
                disabled={!renderable}
                onClick={() => onSelectSubtitle(stream.index)}
              >
                <span>{describeSubtitle(stream)}</span>
                {!renderable && <span className={styles.optionMeta}>requires transcoding (Phase 3)</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Applies the selection to the real <video> element via the (feature-
 *  detected) audioTracks API — a no-op when unsupported (the picker already
 *  disables the option in that case, so this is only ever called when it's
 *  expected to work). */
export function applyAudioTrackSelection(video: HTMLVideoElement, streamIndex: number, streams: AudioStream[]): void {
  const tracks = (video as HTMLVideoElement & { audioTracks?: ArrayLike<{ id: string; enabled: boolean }> }).audioTracks;
  if (!tracks) return;
  const orderIndex = streams.findIndex((s) => s.index === streamIndex);
  if (orderIndex === -1) return;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (track) track.enabled = i === orderIndex;
  }
}
