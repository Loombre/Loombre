// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/player/PlayerControls.tsx
//
// Glass control bar over the video (deliverable 1): auto-hide is driven by
// the parent VideoPlayer (which owns the idle timer, since it also needs to
// know "is idle" to render the P2.11 ambient backdrop) — this component is
// purely presentational plus the pointer/keyboard affordances themselves.
//
// Wave 2 L7 (U7): play/pause and the seek buttons are Phosphor custom
// glyphs now (components/icon/phosphor-paths.ts) — lucide's Play/Pause/
// RotateCcw/RotateCw are gone from this file. The seek buttons themselves
// changed from a symmetric ±10s (RotateCcw/RotateCw) to the prototype's
// iOS gobackward.15/goforward.30 convention (README "Player": "back-15 /
// play-pause / forward-30 with numerals in the glyphs") — the numeral is
// baked into the glyph, so the seek AMOUNT had to move to match (15s back,
// 30s forward) or the button would show a number it doesn't act on; see
// VideoPlayer.tsx's keyboard ArrowLeft/ArrowRight, which mirror the exact
// same amounts so keyboard and click never disagree (both were ±10s
// before this lane, in lockstep — this preserves that 1:1 parity rather
// than only changing the buttons).
import { useState } from "react";
import { ArrowLeft, Maximize, Minimize, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import type { components } from "@loombre/sdk";
import { Icon } from "../icon/Icon.js";
import { BlazeSpinner } from "../ui/BlazeSpinner.js";
import { decisionLabel } from "../../lib/playback-fallback.js";
import { Scrubber, defaultFormatTime, type BufferedRange } from "./Scrubber.js";
import { TrackPickers } from "./TrackPickers.js";
import styles from "./PlayerControls.module.css";

type AudioStream = components["schemas"]["AudioStream"];
type SubtitleStream = components["schemas"]["SubtitleStream"];
type PlaybackPlan = components["schemas"]["PlaybackPlan"];

/** Real fact from the session's audio track list — never invented (H6).
 *  Undefined when nothing is selected yet (still resolving). */
function describeAudioFact(stream: AudioStream | undefined): string | null {
  if (!stream) return null;
  return `${stream.codec.toUpperCase()} ${stream.channels}CH`;
}

/** Real fact: whether a subtitle track is currently selected, and which
 *  one — "SUBTITLES OFF" is exactly as true a fact as naming the track,
 *  since `selectedSubtitleIndex` is real client state either way (H6). */
function describeSubtitleFact(stream: SubtitleStream | undefined, hasSelection: boolean): string {
  if (!hasSelection || !stream) return "SUBTITLES OFF";
  const parts = [stream.codec.toUpperCase()];
  if (stream.language) parts.push(stream.language.toUpperCase());
  return parts.join(" ");
}

export interface PlayerControlsProps {
  visible: boolean;
  title: string;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number | null;
  buffered: BufferedRange[];
  volume: number;
  muted: boolean;
  isFullscreen: boolean;
  buffering: boolean;
  audioStreams: AudioStream[];
  subtitleStreams: SubtitleStream[];
  selectedAudioIndex: number | null;
  selectedSubtitleIndex: number | null;
  videoElement: HTMLVideoElement | null;
  /** Forwarded straight to TrackPickers — see its header for why client-
   *  side audio switching only applies to direct-play. */
  directPlay: boolean;
  /** The session's real decision (direct-play/direct-stream/remux/
   *  transcode) — H6's "decision mode chip at minimum". Null while a
   *  session hasn't resolved yet; the chip is simply omitted, never
   *  fabricated. */
  plan: PlaybackPlan | null;
  onBack: () => void;
  onTogglePlay: () => void;
  onSeek: (ms: number) => void;
  onSeekRelative: (deltaMs: number) => void;
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onSelectAudio: (index: number) => void;
  onSelectSubtitle: (index: number | null) => void;
}

export function PlayerControls(props: PlayerControlsProps): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const hasTracks = props.audioStreams.length > 0 || props.subtitleStreams.length > 0;

  // H6 capability chips — every value below is a real fact the player
  // already holds (session plan / track lists / selection state), never a
  // fixture. Chips absent from the dc's "class" (4K/HDR/CC/AIRPLAY/QUEUE)
  // have no backing data anywhere in this component's props and are
  // deliberately omitted rather than guessed — see this lane's freeze
  // report.
  const decisionChipLabel = props.plan ? decisionLabel(props.plan.decision).toUpperCase() : null;
  // `selected*Index` is a media STREAM index (ffprobe's, as carried on
  // AudioStream.index) — NOT a position in these arrays, which skip the
  // file's video streams. Resolve by identity, never by subscript.
  const audioStream = props.audioStreams.find((s) => s.index === props.selectedAudioIndex);
  const audioChipLabel = props.audioStreams.length > 0 ? describeAudioFact(audioStream) : null;
  const subtitleStream = props.subtitleStreams.find((s) => s.index === props.selectedSubtitleIndex);
  const subtitleChipLabel =
    props.subtitleStreams.length > 0 ? describeSubtitleFact(subtitleStream, props.selectedSubtitleIndex !== null) : null;
  const hasCapabilityChips = decisionChipLabel !== null || audioChipLabel !== null || subtitleChipLabel !== null;

  return (
    <>
      {props.buffering && (
        <div className={styles.buffering}>
          <BlazeSpinner size={48} surface="rgba(0, 0, 0, 0.5)" aria-label="Buffering" />
        </div>
      )}

      <div className={[styles.topBar, props.visible ? "" : styles.hidden].join(" ")}>
        <button type="button" className={styles.backButton} aria-label="Back" onClick={props.onBack}>
          <Icon icon={ArrowLeft} />
        </button>
        <span className={styles.title}>{props.title}</span>
      </div>

      <div className={[styles.bottomBar, props.visible ? "" : styles.hidden].join(" ")}>
        <div className={styles.scrubberRow}>
          <span className={styles.time}>{defaultFormatTime(props.positionMs)}</span>
          <Scrubber positionMs={props.positionMs} durationMs={props.durationMs} buffered={props.buffered} onSeek={props.onSeek} />
          <span className={styles.time}>{props.durationMs !== null ? defaultFormatTime(props.durationMs) : "–:–"}</span>
        </div>
        <div className={styles.controlsRow}>
          <button type="button" className={styles.iconButton} aria-label="Back 15 seconds" onClick={() => props.onSeekRelative(-15_000)}>
            <Icon icon="seekBack15" />
          </button>
          <button type="button" className={styles.playPauseButton} aria-label={props.isPlaying ? "Pause" : "Play"} onClick={props.onTogglePlay}>
            <Icon icon={props.isPlaying ? "pause" : "play"} />
          </button>
          <button type="button" className={styles.iconButton} aria-label="Forward 30 seconds" onClick={() => props.onSeekRelative(30_000)}>
            <Icon icon="seekForward30" />
          </button>

          <button type="button" className={styles.iconButton} aria-label={props.muted ? "Unmute" : "Mute"} onClick={props.onToggleMute}>
            <Icon icon={props.muted || props.volume === 0 ? VolumeX : Volume2} />
          </button>
          <input
            className={styles.volumeSlider}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={props.muted ? 0 : props.volume}
            aria-label="Volume"
            onChange={(e) => props.onVolumeChange(Number(e.target.value))}
          />

          <span className={styles.spacer} />

          {hasTracks && (
            <div className={styles.pickerAnchor}>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Audio and subtitle tracks"
                aria-pressed={pickerOpen}
                onClick={() => setPickerOpen((v) => !v)}
              >
                <Icon icon={SlidersHorizontal} />
              </button>
              {pickerOpen && (
                <div className={styles.pickerPopover}>
                  <TrackPickers
                    audioStreams={props.audioStreams}
                    subtitleStreams={props.subtitleStreams}
                    selectedAudioIndex={props.selectedAudioIndex}
                    selectedSubtitleIndex={props.selectedSubtitleIndex}
                    videoElement={props.videoElement}
                    directPlay={props.directPlay}
                    onSelectAudio={props.onSelectAudio}
                    onSelectSubtitle={props.onSelectSubtitle}
                  />
                </div>
              )}
            </div>
          )}

          <button type="button" className={styles.iconButton} aria-label={props.isFullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={props.onToggleFullscreen}>
            <Icon icon={props.isFullscreen ? Minimize : Maximize} />
          </button>
        </div>

        {hasCapabilityChips && (
          <div className={styles.capabilityRow}>
            {decisionChipLabel && (
              <span className={styles.capabilityChip} data-tone="accent">
                {decisionChipLabel}
              </span>
            )}
            {audioChipLabel && <span className={styles.capabilityChip}>{audioChipLabel}</span>}
            {subtitleChipLabel && <span className={styles.capabilityChip}>{subtitleChipLabel}</span>}
          </div>
        )}
      </div>
    </>
  );
}
