// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Movie filename/folder parser — docs/PLAN.md §8.1.
 *
 * Precedence (documented here because this is where the rule lives, per
 * CLAUDE.md working agreements):
 *
 *  1. Year: prefer a parenthesized `(YYYY)` group over a bare dotted-style
 *     year token. When MULTIPLE `(YYYY)` groups exist (e.g. an edition also
 *     in parens before the release year), the LAST one wins — this is what
 *     makes year-in-title traps work: "2001 A Space Odyssey (1968)" and
 *     "1917 (2019)" both keep the leading number as part of the title
 *     because it is never inside parens, while "Blade Runner 2049 (2017)"
 *     keeps "2049" in the title for the same reason.
 *  2. Dotted style with no parens ("The.Matrix.1999.1080p.mkv"): among all
 *     bounded 4-digit tokens in [1888, 2099], prefer one immediately
 *     followed by a known quality/source/codec/audio/color noise token
 *     (this is the scene-release convention: year sits right before the
 *     technical block); fall back to the LAST candidate otherwise.
 *  3. No year found in the filename → retry the same two rules against the
 *     immediate parent directory name (handles "Title (Year)/Title.mkv").
 *  4. Still no year → the whole (noise-stripped) string is the title, year
 *     is null, confidence is "low".
 *
 * Edition: a `{edition-...}` brace (a common media-server edition-tag
 * convention) wins if present anywhere in the source string (checked first,
 * independent of the year split). Else,
 * whatever remains after year/part/noise/group stripping is checked against
 * a closed list of edition keywords ("Title (Year) - Director's Cut" style)
 * — an unrecognized trailing phrase is deliberately NOT treated as an
 * edition (avoids false positives on stray subtitle-like suffixes).
 *
 * Multi-part (cd1/part1/pt.1/disc1) is extracted before edition/noise
 * stripping so it never gets mistaken for edition text.
 */
import { basename, cleanupWhitespace, dirSegments, dottedToSpaces, isDottedStyle, splitExtension } from "./path-utils.js";
import { findNoiseZoneStart, stripNoise } from "./noise.js";
import type { Confidence, MovieGuess } from "./types.js";

const MIN_YEAR = 1888;
const MAX_YEAR = 2099;

const PART_REGEX = /(?<=^|[\s._-])(cd|part|pt\.?|disc)[\s._-]*0*([1-9]\d?)(?=$|[\s._-])/i;

// Longest-first so e.g. "extended edition" wins over a bare "extended".
const EDITION_KEYWORDS = [
  "director's cut",
  "directors cut",
  "theatrical edition",
  "anniversary edition",
  "criterion edition",
  "extended edition",
  "ultimate edition",
  "special edition",
  "imax edition",
  "theatrical cut",
  "unrated cut",
  "extended cut",
  "final cut",
  "remastered",
  "unrated",
  "uncut",
].sort((a, b) => b.length - a.length);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matched against an apostrophe-normalized copy of the remainder (see below) so
// "Director's Cut" (straight ') and "Director’s Cut" (curly ’) both match —
// normalization preserves string length, so match indices stay valid against
// the original (non-normalized) remainder for extracting the display text.
const EDITION_REGEX = new RegExp(
  `(?<=^|[\\s._-])(${EDITION_KEYWORDS.map(escapeRegex).join("|")})(?=$|[\\s._-])`,
  "i",
);

interface YearCandidate {
  index: number;
  length: number;
  year: number;
}

function findAllParenYears(source: string): YearCandidate[] {
  const out: YearCandidate[] = [];
  const re = /\((\d{4})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const year = Number(m[1]);
    if (year >= MIN_YEAR && year <= MAX_YEAR) {
      out.push({ index: m.index, length: m[0].length, year });
    }
  }
  return out;
}

function findDottedYearCandidates(source: string): YearCandidate[] {
  const out: YearCandidate[] = [];
  const re = /(?<=^|[\s._-])(\d{4})(?=$|[\s._-])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const year = Number(m[1]);
    if (year >= MIN_YEAR && year <= MAX_YEAR) {
      out.push({ index: m.index, length: 4, year });
    }
  }
  return out;
}

function nextTokenIsNoise(source: string, afterIndex: number): boolean {
  const after = source.slice(afterIndex).replace(/^[\s._-]+/, "");
  const nextToken = after.split(/[\s._-]+/)[0] ?? "";
  if (!nextToken) return false;
  return findNoiseZoneStart(nextToken) === 0;
}

interface CoreSplit {
  title: string;
  year: number | null;
  yearSource: "paren" | "dotted" | null;
  remainder: string;
}

/** Splits a raw title-bearing string (filename stem or directory name) into title/year/remainder. */
function splitCore(source: string): CoreSplit {
  const parenCandidates = findAllParenYears(source);
  if (parenCandidates.length > 0) {
    const chosen = parenCandidates[parenCandidates.length - 1]!;
    return {
      title: cleanupWhitespace(source.slice(0, chosen.index)),
      year: chosen.year,
      yearSource: "paren",
      remainder: source.slice(chosen.index + chosen.length),
    };
  }

  const dottedCandidates = findDottedYearCandidates(source);
  if (dottedCandidates.length > 0) {
    const preferred = dottedCandidates.find((c) => nextTokenIsNoise(source, c.index + c.length));
    const chosen = preferred ?? dottedCandidates[dottedCandidates.length - 1]!;
    const dotted = isDottedStyle(source);
    const titleRaw = source.slice(0, chosen.index);
    return {
      title: cleanupWhitespace(dotted ? dottedToSpaces(titleRaw) : titleRaw),
      year: chosen.year,
      yearSource: "dotted",
      remainder: source.slice(chosen.index + chosen.length),
    };
  }

  // Noise-zone search runs on the RAW (un-converted) source: tokens like
  // "5.1"/"DDP5.1" are only recognizable while their internal dot is intact
  // — converting dots to spaces first would make them unmatchable.
  const dotted = isDottedStyle(source);
  const zoneStart = findNoiseZoneStart(source);
  if (zoneStart === -1) {
    return { title: cleanupWhitespace(dotted ? dottedToSpaces(source) : source), year: null, yearSource: null, remainder: "" };
  }
  const titleRaw = source.slice(0, zoneStart);
  return {
    title: cleanupWhitespace(dotted ? dottedToSpaces(titleRaw) : titleRaw),
    year: null,
    yearSource: null,
    remainder: source.slice(zoneStart),
  };
}

export function parseMoviePath(relPath: string): MovieGuess | null {
  const file = basename(relPath);
  if (!file) return null;
  const { stem } = splitExtension(file);
  if (!stem.trim()) return null;

  const reasons: string[] = [];

  // `{edition-...}` braces are stripped from whichever source string
  // supplies the year (stem, or the parent directory on fallback) BEFORE
  // that string is split into title/year — the brace can land on either
  // side of the year ("Title {edition-X} (Year)" or "Title (Year) {edition-X}"),
  // and removing it up front means splitCore never has to know about it.
  function extractBrace(text: string): { split: string; edition: string | null } {
    const m = /\{edition-([^}]+)\}/i.exec(text);
    if (!m) return { split: text, edition: null };
    return { split: text.replace(/\{edition-[^}]+\}/i, " "), edition: m[1]!.trim() };
  }

  const stemBrace = extractBrace(stem);
  let core = splitCore(stemBrace.split);
  let edition: string | null = stemBrace.edition;
  let usedDirFallback = false;

  if (core.year === null) {
    const parents = dirSegments(relPath);
    const parentDir = parents.length > 0 ? parents[parents.length - 1] : undefined;
    if (parentDir) {
      const dirBrace = extractBrace(parentDir);
      const dirCore = splitCore(dirBrace.split);
      if (dirCore.year !== null) {
        core = dirCore;
        edition = dirBrace.edition;
        usedDirFallback = true;
      }
    }
  }

  if (core.year !== null) {
    reasons.push(core.yearSource === "paren" ? "matched:title-year-paren" : "matched:title-year-dotted");
    if (usedDirFallback) reasons.push("year:from-directory");
  } else {
    reasons.push("year:none-found");
  }

  if (!core.title) return null;
  if (edition) reasons.push("edition:edition-brace");

  const title = core.title;
  let remainder = core.remainder;
  let partNumber: number | null = null;
  const partMatch = PART_REGEX.exec(remainder);
  if (partMatch) {
    partNumber = Number(partMatch[2]);
    reasons.push(`part:${partMatch[1]!.toLowerCase().replace(".", "")}`);
    remainder = remainder.slice(0, partMatch.index) + remainder.slice(partMatch.index + partMatch[0].length);
  }

  if (!edition) {
    // Detected against an apostrophe-normalized copy so straight/curly ' both
    // match; the extracted display text is sliced from the ORIGINAL
    // remainder (normalization is length-preserving, so indices line up).
    // Required to be a genuine "- Keyword" dash-suffix (a bare noise word
    // like "UNRATED" with no dash is left for stripNoise, not treated as an
    // edition — that would over-trigger on quality-tag vocabulary overlap).
    const apostropheNormalized = remainder.replace(/[’]/g, "'");
    const editionMatch = EDITION_REGEX.exec(apostropheNormalized);
    if (editionMatch && /-\s*$/.test(remainder.slice(0, editionMatch.index))) {
      edition = cleanupWhitespace(remainder.slice(editionMatch.index, editionMatch.index + editionMatch[0].length));
      reasons.push("edition:dash-suffix");
      remainder = remainder.slice(0, editionMatch.index) + remainder.slice(editionMatch.index + editionMatch[0].length);
    }
  }

  // Strip noise on the raw remainder (dots intact) so tokens like "5.1" stay
  // recognizable — see the identical note in splitCore's no-year branch.
  const stripped = stripNoise(remainder, { stripTrailingGroup: true });
  reasons.push(...stripped.reasons);

  const confidence: Confidence =
    core.year !== null && core.yearSource === "paren" && !usedDirFallback
      ? "high"
      : core.year !== null
        ? "medium"
        : "low";

  return {
    title,
    year: core.year,
    edition,
    partNumber,
    extras: false,
    confidence,
    reasons,
  };
}
