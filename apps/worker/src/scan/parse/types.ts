// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Filename/folder parser types — docs/PLAN.md §8.1.
 *
 * Deterministic, fixture-tested ruleset. Every function here is pure: no I/O,
 * no fs, no clock, no locale dependence. Inputs are library-root-relative
 * POSIX paths (callers normalize Windows separators before calling in).
 *
 * Music is tag-first upstream (STATE.md P1.4) — parseMusicPath is the
 * fallback layer only, used when tags are missing/incomplete.
 */

export type Confidence = "high" | "medium" | "low";

export interface MovieGuess {
  title: string;
  year: number | null;
  edition: string | null;
  partNumber: number | null;
  /** Always false: this is the movie-guess shape, not an auxiliary-file guess. */
  extras: false;
  confidence: Confidence;
  /** Machine-readable codes explaining what matched — see movie.ts REASONS. */
  reasons: string[];
}

export interface TvGuess {
  seriesTitle: string;
  seasonNumber: number | null;
  /** Multi-episode aware; empty array when no explicit episode number was found. */
  episodeNumbers: number[];
  /** YYYY-MM-DD for dated (talk-show style) episodes, else null. */
  airDate: string | null;
  /** Anime-style absolute episode numbering; null when not applicable/attempted. */
  absoluteNumbers: number[] | null;
  /** True for S00 / "Specials" directory episodes. */
  isSpecial: boolean;
  episodeTitle: string | null;
  confidence: Confidence;
  reasons: string[];
}

export interface MusicGuess {
  artist: string | null;
  album: string | null;
  discNumber: number | null;
  trackNumber: number | null;
  title: string | null;
  confidence: Confidence;
  reasons: string[];
}

// "unsupported" (STATE.md H3): a known-media-but-excluded-in-v1 extension
// (parse/path-utils.ts's EXCLUDED_MEDIA_EXTENSIONS — ape/wv/wma) — kept
// distinct from "ignored" (junk: .txt/.nfo/.DS_Store/wrong-media-kind) so
// the scanner can count and visibly report it instead of silently dropping
// it. See parse/auxiliary.ts's classifyAuxiliary header for precedence.
export type AuxiliaryKind = "extra" | "sample" | "ignored" | "unsupported" | null;
