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
 * permanently unplayable.
 *
 * v1.1 (STATE.md H3): the common legacy formats wmv/mpg/mpeg/vob/flv
 * (video) and aac/aiff (audio) are REINSTATED here — probe can extract all
 * of them (docs/PLAYBACK.md §2.1's Container union was widened to match:
 * wmv/wma->'asf', mpg/mpeg/vob->'mpeg', flv, aac, aiff — see that section's
 * widening note and apps/worker/src/probe/extract.ts's
 * SIMPLE_CONTAINER_MAP), and the playback engine's plan() already decides
 * transcoding for anything a device can't direct-play — ingestion
 * generosity here is the architecture working as designed, not a gap.
 *
 * `EXCLUDED_MEDIA_EXTENSIONS` below stays OUT of v1 deliberately. It has
 * two tiers with one treatment: ape/wv/wma (the original v1 policy call —
 * genuinely rare formats with thin codec support) plus the broader
 * recognized-media tail (mts, mka, asf, ogv, 3gp, … — added by the Lane R
 * review of STATE.md H3, which found that anything recognizable as media
 * but in NEITHER set fell through to ordinary "ignored" junk, silently:
 * the exact class the H3 finding was about). Unlike the old blanket
 * narrowing, an excluded extension is never SILENTLY dropped —
 * apps/worker/src/scan/scanner.ts classifies it distinctly from ordinary
 * "ignored" junk (parse/auxiliary.ts's classifyAuxiliary) and counts +
 * reports it in the scan.completed payload's skippedUnsupportedCount/
 * skippedUnsupportedFiles, so an admin can always see exactly what was
 * left out and why. Truly unrecognized suffixes (notes, junk, artwork)
 * still fall to "ignored" — that boundary is what the docs promise.
 *
 * `.mts` note for a future widening: it is the same AVCHD MPEG-TS as the
 * admitted `.m2ts` (identical ffprobe format_name 'mpegts' → 'ts') and
 * would be admittable at zero cost — kept excluded-but-visible only
 * because the H3 brief enumerated the reinstated list exactly; owner
 * call recorded in STATE.md. `.aif` IS admitted: it is the common alias
 * suffix of `.aiff` (same content; ffprobe reports 'aiff' for both,
 * verified empirically), the same alias treatment mpg/mpeg get.
 *
 * apps/worker/test/scan/media-extensions.spec.ts pins both directions
 * (every admitted extension resolves to a Container; every excluded
 * extension never leaks into MEDIA_EXTENSIONS).
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
  "wmv",
  "mpg",
  "mpeg",
  "vob",
  "flv",
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
  "aac",
  "aiff",
  "aif",
]);

export const MEDIA_EXTENSIONS = new Set<string>([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

/**
 * Known-media-but-unsupported-in-v1 extensions (STATE.md H3): genuinely
 * rare formats with thin codec support (Monkey's Audio, WavPack, legacy
 * Windows Media Audio). Deliberately kept separate from "junk"
 * (parse/auxiliary.ts's `'ignored'` classification, e.g. .txt/.nfo/
 * .DS_Store) — a file with one of these extensions IS recognizable media,
 * so silently dropping it the way junk is dropped would be exactly the
 * kind of invisible non-ingestion this reinstatement effort was meant to
 * close. The scanner (scanner.ts's processOneFile) checks this set
 * BEFORE/distinct from classifyAuxiliary's generic "ignored" so these
 * always land in the scan report's visible skip count/list instead.
 */
export const EXCLUDED_MEDIA_EXTENSIONS = new Set([
  // original v1 policy exclusions (rare + thin codec support)
  "ape",
  "wv",
  "wma",
  // recognized-media tail (Lane R review): video
  "mts",
  "asf",
  "ogv",
  "3gp",
  "3g2",
  "divx",
  "m2v",
  "rm",
  "rmvb",
  "wtv",
  "f4v",
  "dv",
  // recognized-media tail: audio
  "mka",
  "m4b",
  "dsf",
  "dff",
  "mpc",
  "tta",
  "ra",
  "shn",
  "amr",
  "ac3",
  "dts",
  "spx",
]);

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
