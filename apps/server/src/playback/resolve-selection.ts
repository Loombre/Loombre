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
//             SUBTITLE-LANGUAGE-PREF when the user has one, else the
//             RESOLVED audio stream's language (auto) -> else none (H1,
//             orchestrator adjudication A-2 — see below).
// Selection never emits reasons (§2.6: "it is input").
//
// H1 (orchestrator adjudication A-2, closed alongside user_settings.prefs
// becoming a real writer): both language-preference legs above now match
// via @loombre/shared's languageMatches() rather than `===`, so a preference
// stored as one ISO 639-2 bibliographic/terminologic code (e.g. "fra")
// matches a stream tagged with its equivalence-pair partner ("fre") — see
// packages/shared/src/language-codes.ts's LANGUAGE_EQUIVALENCE_PAIRS. The
// subtitle leg's matching key is `subtitleLanguagePref ?? resolvedAudioLanguage`
// — an EXPLICIT subtitle-language preference always wins over the
// audio-language auto-match when both are present; neither present ->
// unchanged "no forced-sub match -> none" behavior. This is deliberately
// NOT "auto-select any subtitle in the preferred language" (only forced
// tracks are ever auto-selected here) — that would be a materially bigger
// behavior change than H1 authorizes.

import type { AssembledAudioStream, AssembledMediaInfo, AssembledSubtitleStream, AssembledVideoStream } from "@loombre/db";
import type { TrackSelection } from "@loombre/playback-engine";
import { languageMatches } from "@loombre/shared";

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
    const byLanguage = audio.find((a) => languageMatches(a.language, audioLanguagePref));
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
  subtitleLanguagePref: string | null | undefined,
): number | null {
  const pinned = pinnedStream(subtitle, pins.subtitleStreamIndex);
  if (pinned) return pinned.index;

  // A-2: an explicit subtitle-language preference is the matching key when
  // present; otherwise fall back to the RESOLVED audio stream's language,
  // exactly as before this preference existed.
  const matchLanguage = subtitleLanguagePref ?? resolvedAudioLanguage;
  if (matchLanguage) {
    const forced = subtitle.find((s) => s.isForced && languageMatches(s.language, matchLanguage));
    if (forced) return forced.index;
  }

  return null;
}

/**
 * Resolves the full §2.6 TrackSelection. `audioLanguagePref`/
 * `subtitleLanguagePref` are the caller's already-read user settings (this
 * module takes them as plain data — reading `user_settings.prefs` is the
 * CALLER's job, see plan-assembly.ts); `null`/`undefined`/empty-string all
 * mean "no preference" for either, falling through to the next rule in the
 * cascade exactly as if that preference had never been asked for.
 * `subtitleLanguagePref` is optional (omitted entirely by any caller that
 * predates H1) and, when present, takes priority over the resolved audio
 * language for the forced-subtitle auto-match (A-2) — see this module's
 * header.
 */
export function resolveTrackSelection(
  media: Pick<AssembledMediaInfo, "video" | "audio" | "subtitle">,
  pins: SelectionPins,
  audioLanguagePref: string | null | undefined,
  subtitleLanguagePref?: string | null | undefined,
): TrackSelection {
  const videoStreamIndex = resolveVideoIndex(media.video, pins);
  const audioStreamIndex = resolveAudioIndex(media.audio, pins, audioLanguagePref);
  const resolvedAudioLanguage =
    audioStreamIndex !== null ? (media.audio.find((a) => a.index === audioStreamIndex)?.language ?? null) : null;
  const subtitleStreamIndex = resolveSubtitleIndex(media.subtitle, pins, resolvedAudioLanguage, subtitleLanguagePref);

  return { videoStreamIndex, audioStreamIndex, subtitleStreamIndex };
}
