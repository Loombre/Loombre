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
//   - AUDIO: direct-play serves the original file's bytes as-is; there is
//     no server-side stream-selection endpoint. Switching which embedded
//     audio track plays is only possible client-side via the (non-standard-
//     but-WebKit-supported) HTMLMediaElement.audioTracks API, and ONLY when
//     the element is actually playing those original bytes. Phase 3 step
//     6c's HLS paths (direct-stream/remux/transcode) bake exactly ONE
//     server-resolved audio stream into the delivered output (apps/server/
//     src/playback/resolve-selection.ts picks it; no alternate-audio
//     rendition exists in the manifest, and the contract's AudioAction
//     carries no streamIndex for the client to even read it back), so no
//     client-side API can change what is audible there. `directPlay` is
//     therefore part of the gate: for an HLS session every audio entry
//     renders disabled with an explicit "server-selected for this session"
//     note rather than as a control that silently does nothing — or, on the
//     one browser family that exposes audioTracks, mutes the only real
//     track. Feature-detected at call time on top of that; when the API is
//     absent, entries still list every audio stream (driven by real
//     metadata) but are disabled with their own explicit note.
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

/** Why this session's audio entries can't be switched, or null when they
 *  can. Only consulted when there is more than one stream to pick between —
 *  a single-stream file has nothing to switch to, so it is never "blocked".
 *  Exported so the tests pin the exact user-visible explanation. */
export function audioSwitchBlockedReason(directPlay: boolean, video: HTMLVideoElement | null): string | null {
  if (!directPlay) return "This session is transcoded — the server selected the audio track";
  if (!audioTracksApiSupported(video)) return "This browser doesn't support switching audio tracks";
  return null;
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
  /** Whether the <video> element is playing the original file's own bytes
   *  (VideoPlayer's `attachStrategy === 'direct-play'`). False for every
   *  HLS session, where the audio track is server-resolved and unswitchable
   *  from here — see this file's header. */
  directPlay: boolean;
  onSelectAudio: (index: number) => void;
  onSelectSubtitle: (index: number | null) => void;
}

export function TrackPickers({
  audioStreams,
  subtitleStreams,
  selectedAudioIndex,
  selectedSubtitleIndex,
  videoElement,
  directPlay,
  onSelectAudio,
  onSelectSubtitle,
}: TrackPickersProps): React.JSX.Element {
  const audioBlockedReason = audioStreams.length > 1 ? audioSwitchBlockedReason(directPlay, videoElement) : null;
  const serverSelectedAudio = audioStreams.length > 1 && !directPlay;

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
              disabled={audioBlockedReason !== null}
              title={audioBlockedReason ?? undefined}
              onClick={() => onSelectAudio(stream.index)}
            >
              <span>{describeAudio(stream)}</span>
              {serverSelectedAudio && <span className={styles.optionMeta}>server-selected for this session</span>}
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
  // The element's track list only lines up with the file's stream list when
  // the element is playing that file's own bytes. An HLS session carries a
  // single server-resolved track no matter how many the file has, so the
  // loop below would disable the ONE real track — bail instead of guessing.
  if (tracks.length !== streams.length) return;
  const orderIndex = streams.findIndex((s) => s.index === streamIndex);
  if (orderIndex === -1) return;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (track) track.enabled = i === orderIndex;
  }
}
