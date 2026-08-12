// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared "scene noise" vocabulary and stripping helpers for the movie and TV
 * rulesets: resolution/source/codec/audio/color/misc release tags, bracketed
 * release-group tags, and trailing `-GROUPNAME` suffixes.
 *
 * Matching is separator-aware, not naive substring matching: a token only
 * matches when bounded by `.`, `_`, `-`, whitespace, a bracket/brace/paren,
 * or string start/end — so e.g. "Amelie" never loses letters to a token
 * that happens to be a substring.
 */

const RESOLUTION_TOKENS = ["480p", "576p", "720p", "1080p", "1080i", "2160p", "4320p", "4k", "8k"];

const SOURCE_TOKENS = [
  "bluray",
  "blu-ray",
  "bdrip",
  "brrip",
  "bd25",
  "bd50",
  "webdl",
  "web-dl",
  "webrip",
  "web",
  "hdrip",
  "dvdrip",
  "dvdr",
  "dvd",
  "hdtv",
  "pdtv",
  "sdtv",
  "hdcam",
  "cam",
  "telesync",
  "tc",
  "r5",
  "remux",
];

const CODEC_TOKENS = ["x264", "x265", "h264", "h265", "hevc", "avc", "xvid", "divx", "av1", "vp9", "10bit", "8bit"];

const AUDIO_TOKENS = [
  "aac",
  "ac3",
  "eac3",
  "dts-hd",
  "dtshd",
  "dts",
  "truehd",
  "atmos",
  "flac",
  "mp3",
  "opus",
  "ddp5.1",
  "ddp7.1",
  "dd5.1",
  "dd7.1",
  "5.1",
  "7.1",
  "2.0",
];

const COLOR_TOKENS = ["hdr10+", "hdr10", "hdr", "dovi", "dv", "sdr", "hlg"];

const MISC_TOKENS = [
  "proper",
  "repack",
  "limited",
  "unrated",
  "internal",
  "nf",
  "amzn",
  "dsnp",
  "atvp",
  "hulu",
  "hmax",
  "multi",
  "dual",
  "dubbed",
  "subbed",
  "extended",
];

/** All tokens, longest-first so e.g. "web-dl" wins over a bare "web" prefix match. */
const ALL_NOISE_TOKENS = [
  ...RESOLUTION_TOKENS,
  ...SOURCE_TOKENS,
  ...CODEC_TOKENS,
  ...AUDIO_TOKENS,
  ...COLOR_TOKENS,
  ...MISC_TOKENS,
].sort((a, b) => b.length - a.length);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEP_CLASS = String.raw`[\s._\-\[\](){}]`;
const NOISE_TOKEN_SOURCE = `(?<=^|${SEP_CLASS})(${ALL_NOISE_TOKENS.map(escapeRegex).join("|")})(?=$|${SEP_CLASS})`;
const NOISE_TOKEN_REGEX = new RegExp(NOISE_TOKEN_SOURCE, "gi");

/**
 * Bracketed `[...]`/`(...)`/`{...}` chunks that are not an `{edition-...}`
 * marker. Parens are included here (not just square brackets) because some
 * release groups wrap quality tags in parens (e.g. "Show - 245 (1080p)");
 * this never collides with movie year extraction, which slices the chosen
 * `(YYYY)` match out of the title/remainder split before generic noise
 * stripping ever sees the remainder.
 */
const BRACKET_CHUNK_SOURCE = String.raw`\[[^\]]*\]|\((?!edition-)[^)]*\)|\{(?!edition-)[^}]*\}`;
const BRACKET_CHUNK_REGEX = new RegExp(BRACKET_CHUNK_SOURCE, "gi");

/** Trailing scene release-group suffix: a hyphen followed by an all-caps/alnum token at the very end. */
const TRAILING_GROUP_REGEX = /-([A-Za-z0-9]{2,20})$/;

export interface StripResult {
  cleaned: string;
  /** Distinct reason codes for what was removed, in first-seen order. */
  reasons: string[];
}

/**
 * Removes bracketed chunks, quality/source/codec/audio/color/misc noise
 * tokens, and (optionally) a trailing release-group suffix from `text`.
 * Whitespace-only cleanup (collapsing/trim) is the caller's job via
 * `cleanupWhitespace` — this function only ever widens separators to spaces.
 */
export function stripNoise(text: string, options: { stripTrailingGroup?: boolean } = {}): StripResult {
  const reasons: string[] = [];
  let working = text;

  if (new RegExp(BRACKET_CHUNK_SOURCE, "i").test(working)) {
    reasons.push("noise:bracket-stripped");
  }
  working = working.replace(BRACKET_CHUNK_REGEX, " ");

  if (options.stripTrailingGroup) {
    const trimmedForGroup = working.trim();
    const groupMatch = TRAILING_GROUP_REGEX.exec(trimmedForGroup);
    if (groupMatch && !isKnownNoiseToken(groupMatch[1]!)) {
      reasons.push("group:trailing-stripped");
      working = trimmedForGroup.slice(0, groupMatch.index);
    }
  }

  if (new RegExp(NOISE_TOKEN_SOURCE, "i").test(working)) {
    reasons.push("noise:tokens-stripped");
  }
  working = working.replace(NOISE_TOKEN_REGEX, " ");

  return { cleaned: working, reasons };
}

export function isKnownNoiseToken(token: string): boolean {
  return ALL_NOISE_TOKENS.includes(token.toLowerCase());
}

/**
 * Index of the earliest "noise zone" start in `text` — either a recognized
 * noise token or a bracketed chunk — or -1 if `text` contains neither.
 * Used to split a year-less filename into title vs. trailing noise.
 */
export function findNoiseZoneStart(text: string): number {
  let idx = -1;
  const tokenMatch = new RegExp(NOISE_TOKEN_SOURCE, "i").exec(text);
  if (tokenMatch) idx = tokenMatch.index;
  const bracketMatch = new RegExp(BRACKET_CHUNK_SOURCE, "i").exec(text);
  if (bracketMatch && (idx === -1 || bracketMatch.index < idx)) idx = bracketMatch.index;
  return idx;
}
