// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/detail/format.ts
//
// Small presentation-only formatters shared by the item detail route and
// its season/episode/track row components. No business logic — the API
// already did every decision (runtimeMs nullability, etc.).

export function formatRuntime(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms <= 0) return null;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function formatRating(rating: number | null | undefined): string | null {
  if (rating === null || rating === undefined) return null;
  return rating.toFixed(1);
}

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || bytes <= 0) return null;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${FILE_SIZE_UNITS[unitIndex]}`;
}

export function formatResolution(height: number | null | undefined): string | null {
  if (height === null || height === undefined || height <= 0) return null;
  return `${height}p`;
}

/** Channel COUNT -> the conventional "N.1"/stereo/mono layout label used in
 *  the movie-detail VERSIONS/METADATA cards' codec specs (Phosphor W2 L4).
 *  Derived straight from the real `channels` column (media_streams) — this
 *  is the standard channel-count convention (2 -> stereo, 6 -> 5.1, 8 ->
 *  7.1), not a fabricated value; anything above 8 channels (rare, but not
 *  impossible for e.g. a 9.1 mix) falls back to "(N-1).1" rather than a
 *  hardcoded table, since the arithmetic still holds. */
export function formatChannelLayout(channels: number | null | undefined): string | null {
  if (channels === null || channels === undefined || channels <= 0) return null;
  if (channels === 1) return "MONO";
  if (channels === 2) return "STEREO";
  return `${channels - 1}.1`;
}

/** One media_streams audio row -> "EAC3 5.1" style label. Null codec/
 *  channels are honestly omitted rather than padded with a placeholder. */
export function formatAudioTrackLabel(track: { codec: string; channels: number | null }): string {
  const layout = formatChannelLayout(track.channels);
  return [track.codec.toUpperCase(), layout].filter((part): part is string => Boolean(part)).join(" ");
}

/** Uppercases a real ISO 639-2 language code for mono-label display (e.g.
 *  METADATA's Audio/Subtitles rows); "UNKNOWN" only when the stream's
 *  language genuinely wasn't probed (media_streams.language NULL), never a
 *  guessed default. */
export function formatLanguageLabel(language: string | null | undefined): string {
  return language ? language.toUpperCase() : "UNKNOWN";
}

interface CreditLike {
  name: string;
  role: string;
}

/** METADATA card's "Director" row (Phosphor W2 L4) — real PersonCredit
 *  data, role === 'director', joined when a movie has more than one. Never
 *  fabricates a name: "Unknown" only when no director is credited at all. */
export function formatDirectorLabel(people: CreditLike[] | null | undefined): string {
  const directors = (people ?? []).filter((p) => p.role === "director");
  if (directors.length === 0) return "Unknown";
  return directors.map((d) => d.name).join(", ");
}

interface AudioTrackLike {
  codec: string;
  channels: number | null;
  language: string | null;
}

/** METADATA card's "Audio" row — every audio track on the item's DEFAULT
 *  file (MediaFileSummary.audioTracks), codec+layout per track plus the
 *  distinct languages present, e.g. "EAC3 5.1 · ENG". "Not probed" (not a
 *  fabricated codec) when the file has no audio streams recorded yet. */
export function formatAudioMetaRow(tracks: AudioTrackLike[] | null | undefined): string {
  const list = tracks ?? [];
  if (list.length === 0) return "Not probed";
  const codecParts = list.map((t) => formatAudioTrackLabel(t));
  const languages = [...new Set(list.map((t) => t.language).filter((l): l is string => Boolean(l)))];
  const parts = languages.length > 0 ? [...codecParts, languages.map((l) => l.toUpperCase()).join("/")] : codecParts;
  return parts.join(" · ");
}

interface SubtitleTrackLike {
  language: string | null;
  isForced: boolean;
}

/** METADATA card's "Subtitles" row — every subtitle track on the default
 *  file. "None" (a real, honest absence) when there are no subtitle
 *  streams, never omitted-as-blank. */
export function formatSubtitlesMetaRow(tracks: SubtitleTrackLike[] | null | undefined): string {
  const list = tracks ?? [];
  if (list.length === 0) return "None";
  return list.map((t) => formatLanguageLabel(t.language) + (t.isForced ? " (FORCED)" : "")).join(" · ");
}

/** Millisecond epoch -> "3D AGO" / "2H AGO" / "JUST NOW" mono readout for
 *  METADATA's "Added" row (addedAtMs, real CatalogItemBase column). Coarse
 *  on purpose (days/hours only, no fabricated precision), clamped so a
 *  clock-skewed or future addedAtMs never reads as a negative duration. */
export function formatRelativeAdded(addedAtMs: number, nowMs: number = Date.now()): string {
  const deltaMs = Math.max(0, nowMs - addedAtMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "JUST NOW";
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}M AGO`;
  const days = Math.floor(hours / 24);
  if (days < 1) return `${hours}H AGO`;
  if (days < 30) return `${days}D AGO`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}MO AGO`;
  const years = Math.floor(months / 12);
  return `${years}Y AGO`;
}
