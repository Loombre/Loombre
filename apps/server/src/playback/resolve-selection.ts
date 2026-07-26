// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/resolve-selection.ts
//
// TrackSelection resolution (docs/PLAYBACK.md §2.6, Phase 3 §11 step 6b
// deliverable 2). Resolved by THIS module before plan() is invoked; pure
// and unit-tested in isolation (no DB/HTTP — takes only plain data), per
// this step's explicit instruction.
//
// Order (§2.6, quoted, + this step's own elaboration of the audio/subtitle
// cascades):
//   video:    request-body pin -> else "first non-thumbnail video stream".
//             This package's VideoStream/AssembledVideoStream types have no
//             thumbnail concept to exclude (the scanner/probe pipeline
//             never models embedded thumbnail streams as a `video`
//             §2.1 entry), so "first" reduces to "lowest index" here.
//   audio:    request-body pin -> else language-pref match (from user
//             prefs, when present) -> else isDefault -> else lowest index.
//   subtitle: request-body pin -> else forced-flag stream matching the
//             RESOLVED audio stream's language (auto) -> else none.
// Selection never emits reasons (§2.6: "it is input").

import type { AssembledAudioStream, AssembledMediaInfo, AssembledSubtitleStream, AssembledVideoStream } from "@loombre/db";
import type { TrackSelection } from "@loombre/playback-engine";

/** Request-body pins (PlanRequest.selection, all optional/nullable per the
 *  contract's TrackSelection schema — see plan-request.ts's parsing). */
export interface SelectionPins {
  videoStreamIndex?: number | null;
  audioStreamIndex?: number | null;
  subtitleStreamIndex?: number | null;
}

function lowestIndex<T extends { index: number }>(streams: readonly T[]): T | undefined {
  return streams.reduce<T | undefined>((min, s) => (min === undefined || s.index < min.index ? s : min), undefined);
}

/** A pin resolves only when it names a stream that ACTUALLY exists on this
 *  file — a client pinning a stale/nonexistent index falls through to the
 *  normal cascade rather than producing a selection pointing at nothing. */
function pinnedStream<T extends { index: number }>(streams: readonly T[], pinned: number | null | undefined): T | undefined {
  if (pinned === null || pinned === undefined) return undefined;
  return streams.find((s) => s.index === pinned);
}

function resolveVideoIndex(video: readonly AssembledVideoStream[], pins: SelectionPins): number | null {
  if (video.length === 0) return null;
  const pinned = pinnedStream(video, pins.videoStreamIndex);
  if (pinned) return pinned.index;
  return lowestIndex(video)?.index ?? null;
}

function resolveAudioIndex(
  audio: readonly AssembledAudioStream[],
  pins: SelectionPins,
  audioLanguagePref: string | null | undefined,
): number | null {
  if (audio.length === 0) return null;

  const pinned = pinnedStream(audio, pins.audioStreamIndex);
  if (pinned) return pinned.index;

  if (audioLanguagePref) {
    const byLanguage = audio.find((a) => a.language === audioLanguagePref);
    if (byLanguage) return byLanguage.index;
  }

  const byDefault = audio.find((a) => a.isDefault);
  if (byDefault) return byDefault.index;

  return lowestIndex(audio)?.index ?? null;
}

function resolveSubtitleIndex(
  subtitle: readonly AssembledSubtitleStream[],
  pins: SelectionPins,
  resolvedAudioLanguage: string | null,
): number | null {
  const pinned = pinnedStream(subtitle, pins.subtitleStreamIndex);
  if (pinned) return pinned.index;

  if (resolvedAudioLanguage) {
    const forced = subtitle.find((s) => s.isForced && s.language === resolvedAudioLanguage);
    if (forced) return forced.index;
  }

  return null;
}

/**
 * Resolves the full §2.6 TrackSelection. `audioLanguagePref` is the
 * caller's already-read user setting (this module takes it as plain data —
 * reading `user_settings.prefs` is the CALLER's job, see
 * plan-assembly.ts); `null`/`undefined`/empty-string all mean "no
 * preference", falling through to the isDefault/lowest-index rule exactly
 * as if no preference had ever been asked for.
 */
export function resolveTrackSelection(
  media: Pick<AssembledMediaInfo, "video" | "audio" | "subtitle">,
  pins: SelectionPins,
  audioLanguagePref: string | null | undefined,
): TrackSelection {
  const videoStreamIndex = resolveVideoIndex(media.video, pins);
  const audioStreamIndex = resolveAudioIndex(media.audio, pins, audioLanguagePref);
  const resolvedAudioLanguage =
    audioStreamIndex !== null ? (media.audio.find((a) => a.index === audioStreamIndex)?.language ?? null) : null;
  const subtitleStreamIndex = resolveSubtitleIndex(media.subtitle, pins, resolvedAudioLanguage);

  return { videoStreamIndex, audioStreamIndex, subtitleStreamIndex };
}
