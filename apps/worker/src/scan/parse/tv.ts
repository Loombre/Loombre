// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TV filename/folder parser — docs/PLAN.md §8.1.
 *
 * Precedence (documented here because this is where the rule lives, per
 * CLAUDE.md working agreements):
 *
 *  1. SxxEyy family (S01E01, s01e01, 1x01, S01.E01 — case/separator
 *     insensitive) is checked FIRST, before anything else. Multi-episode:
 *     consecutive `E<nn>` tokens joined by `.`/space/nothing are a LIST
 *     (kept exactly as given, e.g. S01E01E03 -> [1, 3]); a `-`-prefixed
 *     tail (S01E01-E03, S01E01-03) is a RANGE and is expanded inclusively
 *     ([1, 2, 3]) — this is the documented list-vs-range distinction.
 *  2. Dated (`YYYY-MM-DD` / `YYYY.MM.DD`) is checked next.
 *  3. Bare episode markers (`E01`, `Episode 01`) with NO season prefix pull
 *     their season from directory context ("Season 01/", "Season 1/" ->
 *     that number; "Specials/" -> season 0 + isSpecial).
 *  4. Absolute (anime) numbering is the LAST resort: attempted only when
 *     none of the above matched. This is the absolute-vs-SxxEyy conflict
 *     resolution rule the mission calls out — a SxxEyy match always wins
 *     over a bare trailing number, because SxxEyy is unambiguous and a
 *     bare number is not.
 *
 * Series title: the show-root directory (first path segment) wins when
 * present (handles "Show (2019)/Season 01/Show.S01E01.mkv" — the parens
 * year there is a disambiguation aid, not stored on TvGuess); otherwise the
 * text preceding whichever pattern matched in the filename is used. A
 * leading `[Group]` bracket (anime release tag) is stripped before any
 * other matching is attempted, from either source.
 */
import { basename, cleanupWhitespace, dirSegments, dottedToSpaces, isDottedStyle, splitExtension } from "./path-utils.js";
import { findNoiseZoneStart, stripNoise } from "./noise.js";
import type { Confidence, TvGuess } from "./types.js";

const LEADING_GROUP_REGEX = /^\[([^\]]+)\][\s._-]*/;

const SEASON_LOOKAHEAD = /(?<=^|[\s._[(-])s(\d{1,2})(?=[\s._-]*e\d)/i;
const EP_TOKEN_REGEX = /^[\s._]*e(\d{1,3})/i;
const EP_RANGE_REGEX = /^[\s._-]*-[\s._-]*e?(\d{1,3})(?=$|[\s._\])-])/i;

// No trailing boundary on the base/continue regexes themselves — "1x01x02"
// needs "x02" to follow "1x01" with zero separator, so the boundary can only
// be checked once, after the continuation loop has consumed everything.
const X_STYLE_REGEX = /(?<=^|[\s._[(-])(\d{1,2})x(\d{1,3})/i;
const X_STYLE_CONTINUE_REGEX = /^x(\d{1,3})/i;
const TRAILING_BOUNDARY_REGEX = /^(?:$|[\s._\])-])/;

const DATED_REGEX = /(?<=^|[\s._-])(\d{4})(?:-(\d{2})-(\d{2})|\.(\d{2})\.(\d{2}))(?=$|[\s._-])/;

const BARE_EP_REGEX = /(?<=^|[\s._[(-])e(\d{1,3})(?=$|[\s._\])-])/i;
const EPISODE_WORD_REGEX = /(?<=^|[\s._-])episode[\s._-]*0*(\d{1,3})(?=$|[\s._-])/i;

const ABSOLUTE_REGEX = /(?<=^|[\s._-])0*(\d{2,4})(?:v(\d+))?$/i;

const SEASON_DIR_REGEX = /^season[\s._-]*0*(\d{1,3})$/i;
const SPECIALS_DIR_REGEX = /^specials?$/i;
const DIR_YEAR_REGEX = /^(.*?)[\s._-]*\((\d{4})\)\s*$/;

interface MatchResult {
  seasonNumber: number | null;
  episodeNumbers: number[];
  isSpecial: boolean;
  matchStart: number;
  matchEnd: number;
  reasons: string[];
}

function matchSxxEyy(text: string): MatchResult | null {
  const sm = SEASON_LOOKAHEAD.exec(text);
  if (!sm) return null;
  const season = Number(sm[1]!);
  let cursor = sm.index + sm[0].length;
  const episodes: number[] = [];
  for (;;) {
    const rest = text.slice(cursor);
    const em = EP_TOKEN_REGEX.exec(rest);
    if (!em) break;
    episodes.push(Number(em[1]!));
    cursor += em[0].length;
  }
  if (episodes.length === 0) return null;

  const reasons = ["matched:sxxexx"];
  const rangeMatch = EP_RANGE_REGEX.exec(text.slice(cursor));
  if (rangeMatch) {
    const start = episodes[0]!;
    const end = Number(rangeMatch[1]!);
    if (end > start && end - start <= 50) {
      episodes.length = 0;
      for (let n = start; n <= end; n++) episodes.push(n);
      cursor += rangeMatch[0].length;
      reasons.push("matched:multi-episode-range");
    }
  } else if (episodes.length > 1) {
    reasons.push("matched:multi-episode-list");
  }

  const isSpecial = season === 0;
  if (isSpecial) reasons.push("special:s00");

  return { seasonNumber: season, episodeNumbers: episodes, isSpecial, matchStart: sm.index, matchEnd: cursor, reasons };
}

function matchXStyle(text: string): MatchResult | null {
  const m = X_STYLE_REGEX.exec(text);
  if (!m) return null;
  const season = Number(m[1]!);
  const episodes = [Number(m[2]!)];
  let cursor = m.index + m[0].length;
  for (;;) {
    const rest = text.slice(cursor);
    const cm = X_STYLE_CONTINUE_REGEX.exec(rest);
    if (!cm) break;
    episodes.push(Number(cm[1]!));
    cursor += cm[0].length;
  }
  // Boundary check happens once, after all "x<nn>" continuations are consumed
  // (each continuation is glued directly onto the previous one with no
  // separator, so checking it per-token would reject "1x01x02" at the first
  // step).
  if (!TRAILING_BOUNDARY_REGEX.test(text.slice(cursor))) return null;
  const reasons = ["matched:1x01"];
  if (episodes.length > 1) reasons.push("matched:multi-episode-list");
  const isSpecial = season === 0;
  if (isSpecial) reasons.push("special:s00");
  return { seasonNumber: season, episodeNumbers: episodes, isSpecial, matchStart: m.index, matchEnd: cursor, reasons };
}

interface DatedResult {
  airDate: string;
  matchStart: number;
  matchEnd: number;
}

function matchDated(text: string): DatedResult | null {
  const m = DATED_REGEX.exec(text);
  if (!m) return null;
  const year = m[1]!;
  const month = m[2] ?? m[4]!;
  const day = m[3] ?? m[5]!;
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
  return { airDate: `${year}-${month}-${day}`, matchStart: m.index, matchEnd: m.index + m[0].length };
}

interface BareEpisodeResult {
  episodeNumbers: number[];
  matchStart: number;
  matchEnd: number;
  reasons: string[];
}

function matchBareEpisode(text: string): BareEpisodeResult | null {
  const wm = EPISODE_WORD_REGEX.exec(text);
  if (wm) {
    return {
      episodeNumbers: [Number(wm[1]!)],
      matchStart: wm.index,
      matchEnd: wm.index + wm[0].length,
      reasons: ["matched:bare-episode"],
    };
  }
  const em = BARE_EP_REGEX.exec(text);
  if (em) {
    return {
      episodeNumbers: [Number(em[1]!)],
      matchStart: em.index,
      matchEnd: em.index + em[0].length,
      reasons: ["matched:bare-episode"],
    };
  }
  return null;
}

interface AbsoluteResult {
  absoluteNumbers: number[];
  version: number | null;
  matchStart: number;
  matchEnd: number;
}

function matchAbsolute(text: string): AbsoluteResult | null {
  // Search only the "core" zone before any trailing noise/bracket block
  // (e.g. strip " [1080p]" from "Show - 012 [1080p]") so the trailing-anchor
  // match below lines up with the actual number, not trailing release noise.
  const noiseZoneStart = findNoiseZoneStart(text);
  const core = (noiseZoneStart === -1 ? text : text.slice(0, noiseZoneStart)).trimEnd();
  const m = ABSOLUTE_REGEX.exec(core);
  if (!m) return null;
  const num = Number(m[1]!);
  if (num === 0) return null;
  return {
    absoluteNumbers: [num],
    version: m[2] ? Number(m[2]) : null,
    matchStart: m.index,
    matchEnd: m.index + m[0].length,
  };
}

// A single unmatched closing bracket/paren/brace immediately after the
// consumed season/episode token — e.g. "Show [S01E01].mkv" leaves a lone
// "]" behind, since the SxxEyy matcher only consumes "S01E01" itself, not
// its wrapping "[...]". Stripped narrowly (not via generic cleanup) so a
// legitimately bracket-ending episode title is never touched.
const LEADING_STRAY_CLOSE_BRACKET_REGEX = /^[\])}][\s._-]*/;

function extractTrailingText(raw: string): string | null {
  const withoutLeadSep = raw.replace(/^[\s._-]+/, "").replace(LEADING_STRAY_CLOSE_BRACKET_REGEX, "");
  if (!withoutLeadSep) return null;
  // Noise-strip BEFORE converting dots to spaces: tokens like "5.1"/"DDP5.1"
  // are only recognizable while their internal dot is still intact — convert
  // first and "DDP5.1" becomes the unrecognizable "DDP5 1".
  const stripped = stripNoise(withoutLeadSep, { stripTrailingGroup: true });
  const dotted = isDottedStyle(stripped.cleaned);
  const cleaned = cleanupWhitespace(dotted ? dottedToSpaces(stripped.cleaned) : stripped.cleaned);
  return cleaned.length > 0 ? cleaned : null;
}

export function parseTvPath(relPath: string): TvGuess | null {
  const file = basename(relPath);
  if (!file) return null;
  const { stem } = splitExtension(file);

  const dirs = dirSegments(relPath);
  const reasons: string[] = [];

  let dirSeason: number | null = null;
  let dirIsSpecial = false;
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (SPECIALS_DIR_REGEX.test(trimmed)) {
      dirSeason = 0;
      dirIsSpecial = true;
      continue;
    }
    const seasonDirMatch = SEASON_DIR_REGEX.exec(trimmed);
    if (seasonDirMatch) {
      dirSeason = Number(seasonDirMatch[1]!);
    }
  }

  let seriesTitleFromDir: string | null = null;
  if (dirs.length > 0) {
    const rootDir = dirs[0]!.trim();
    const yearMatch = DIR_YEAR_REGEX.exec(rootDir);
    if (yearMatch) {
      seriesTitleFromDir = cleanupWhitespace(yearMatch[1]!);
      reasons.push("series-year:from-directory");
    } else if (!SEASON_DIR_REGEX.test(rootDir) && !SPECIALS_DIR_REGEX.test(rootDir)) {
      seriesTitleFromDir = cleanupWhitespace(isDottedStyle(rootDir) ? dottedToSpaces(rootDir) : rootDir);
    }
  }

  let workingStem = stem;
  let leadingGroup: string | null = null;
  const groupMatch = LEADING_GROUP_REGEX.exec(workingStem);
  if (groupMatch) {
    leadingGroup = groupMatch[1]!;
    workingStem = workingStem.slice(groupMatch[0].length);
  }

  let seasonNumber: number | null = null;
  let episodeNumbers: number[] = [];
  let airDate: string | null = null;
  let absoluteNumbers: number[] | null = null;
  let isSpecial = dirIsSpecial;
  let episodeTitle: string | null = null;
  let filenamePrefix = "";
  let confidence: Confidence = "low";
  let matched = false;

  const sxxeyy = matchSxxEyy(workingStem);
  if (sxxeyy) {
    matched = true;
    seasonNumber = sxxeyy.seasonNumber;
    episodeNumbers = sxxeyy.episodeNumbers;
    isSpecial = isSpecial || sxxeyy.isSpecial;
    reasons.push(...sxxeyy.reasons);
    filenamePrefix = workingStem.slice(0, sxxeyy.matchStart);
    episodeTitle = extractTrailingText(workingStem.slice(sxxeyy.matchEnd));
    confidence = "high";
  } else {
    const xstyle = matchXStyle(workingStem);
    if (xstyle) {
      matched = true;
      seasonNumber = xstyle.seasonNumber;
      episodeNumbers = xstyle.episodeNumbers;
      isSpecial = isSpecial || xstyle.isSpecial;
      reasons.push(...xstyle.reasons);
      filenamePrefix = workingStem.slice(0, xstyle.matchStart);
      episodeTitle = extractTrailingText(workingStem.slice(xstyle.matchEnd));
      confidence = "high";
    } else {
      const dated = matchDated(workingStem);
      if (dated) {
        matched = true;
        airDate = dated.airDate;
        reasons.push("matched:dated");
        filenamePrefix = workingStem.slice(0, dated.matchStart);
        episodeTitle = extractTrailingText(workingStem.slice(dated.matchEnd));
        confidence = "medium";
      } else {
        const bare = matchBareEpisode(workingStem);
        if (bare) {
          matched = true;
          episodeNumbers = bare.episodeNumbers;
          reasons.push(...bare.reasons);
          filenamePrefix = workingStem.slice(0, bare.matchStart);
          episodeTitle = extractTrailingText(workingStem.slice(bare.matchEnd));
          if (dirSeason !== null) {
            seasonNumber = dirSeason;
            reasons.push("season:from-directory");
            confidence = "medium";
          } else {
            confidence = "low";
          }
        } else {
          const absolute = matchAbsolute(workingStem);
          if (absolute) {
            matched = true;
            absoluteNumbers = absolute.absoluteNumbers;
            reasons.push("matched:absolute-number");
            if (absolute.version !== null) reasons.push("matched:absolute-versioned");
            filenamePrefix = workingStem.slice(0, absolute.matchStart).replace(/[\s._-]+$/, "");
            confidence = "medium";
          }
        }
      }
    }
  }

  if (leadingGroup !== null) {
    reasons.push(absoluteNumbers !== null ? "group:anime-bracket-stripped" : "group:bracket-stripped");
  }

  if (dirIsSpecial) {
    // "Specials/" alone (no S00 in the filename) still pins season 0.
    seasonNumber = seasonNumber ?? 0;
  }

  const dottedStem = isDottedStyle(workingStem);
  const filenamePrefixClean = cleanupWhitespace(dottedStem ? dottedToSpaces(filenamePrefix) : filenamePrefix);
  const wholeStemClean = cleanupWhitespace(dottedStem ? dottedToSpaces(workingStem) : workingStem);

  let seriesTitle: string;
  if (seriesTitleFromDir) {
    seriesTitle = seriesTitleFromDir;
    reasons.push("title:from-directory");
  } else if (matched && filenamePrefixClean) {
    seriesTitle = filenamePrefixClean;
    reasons.push("title:from-filename");
  } else if (!matched && wholeStemClean) {
    seriesTitle = wholeStemClean;
    reasons.push("title:from-filename");
  } else {
    seriesTitle = "";
  }

  if (!seriesTitle) return null;

  if (!matched) {
    reasons.push("matched:none");
    confidence = "low";
  }

  return {
    seriesTitle,
    seasonNumber,
    episodeNumbers,
    airDate,
    absoluteNumbers,
    isSpecial,
    episodeTitle,
    confidence,
    reasons,
  };
}
