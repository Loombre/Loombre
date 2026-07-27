// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure path-string helpers shared by the parse rulesets. No `node:path`
 * import on purpose: inputs are library-root-relative POSIX paths supplied
 * as plain strings (§8.1), and pulling in a platform path module would be a
 * gratuitous coupling for something this small.
 */

/**
 * The extensions the scanner admits — deliberately narrower than "every
 * extension a media file could carry". Every member must resolve to the
 * probe pipeline's CLOSED Container union (docs/PLAYBACK.md §2.1, mapped by
 * apps/worker/src/probe/extract.ts's resolveContainer): admitting anything
 * else creates a catalog item and an item.added event for a file whose
 * probe then fails deterministically forever — visible in the catalog,
 * permanently unplayable. Excluded for exactly that reason in v1 (their
 * ffprobe format_name has no §2.1 container): wmv/wma ('asf'), mpg/mpeg/vob
 * ('mpeg'), flv, aac (bare ADTS), ape, wv, aiff. Widening the set means
 * widening §2.1 first (a spec change plus new engine matrix cases).
 * apps/worker/test/scan/media-extensions.spec.ts pins both directions.
 */
export const VIDEO_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "avi",
  "mov",
  "m4v",
  "ts",
  "m2ts",
  "webm",
]);

export const AUDIO_EXTENSIONS = new Set([
  "flac",
  "mp3",
  "m4a",
  "ogg",
  "oga",
  "opus",
  "wav",
  "alac",
]);

export const MEDIA_EXTENSIONS = new Set<string>([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

/** Splits a relative path into non-empty segments, ignoring `.`/`..`/empty runs. */
export function splitSegments(relPath: string): string[] {
  return relPath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

/** Last path segment (the filename), or "" for an empty/root-only path. */
export function basename(relPath: string): string {
  const segments = splitSegments(relPath);
  return segments.length > 0 ? segments[segments.length - 1]! : "";
}

/** All segments except the last (directory chain), root-to-leaf order. */
export function dirSegments(relPath: string): string[] {
  const segments = splitSegments(relPath);
  return segments.slice(0, -1);
}

export interface SplitExtension {
  /** Filename without the extension (and without the dot). */
  stem: string;
  /** Lowercased extension without the leading dot, or "" if none. */
  ext: string;
}

/**
 * Splits a bare filename (no directories) into stem + extension. A leading
 * dot (dotfiles: ".DS_Store") is never treated as an extension separator.
 */
export function splitExtension(filename: string): SplitExtension {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return { stem: filename, ext: "" };
  }
  return { stem: filename.slice(0, lastDot), ext: filename.slice(lastDot + 1).toLowerCase() };
}

/**
 * Collapses runs of whitespace and trims stray separator debris from an
 * extracted title/segment. Deliberately does NOT strip bracket/brace/paren
 * characters here — titles/albums legitimately end in a parenthetical
 * (e.g. "The Beatles (White Album)"), so blanket-stripping them would
 * corrupt balanced pairs. Callers that need to discard a specific
 * unmatched/stray bracket left over from consuming a wrapped token (see
 * tv.ts's extractTrailingText) do that narrowly themselves.
 */
export function cleanupWhitespace(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s._\-,:]+/, "")
    .replace(/[\s._\-,:]+$/, "")
    .trim();
}

/** True if `value` looks like dot/underscore "scene style" separation rather than natural spacing. */
export function isDottedStyle(value: string): boolean {
  return !value.includes(" ") && (value.includes(".") || value.includes("_"));
}

/** Converts dotted/underscored scene-style separators to single spaces. */
export function dottedToSpaces(value: string): string {
  return value.replace(/[._]+/g, " ");
}
