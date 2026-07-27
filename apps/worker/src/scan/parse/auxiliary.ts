// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Auxiliary-path classifier — docs/PLAN.md §8.1. Called FIRST by the
 * scanner, before any movie/TV/music parsing is attempted, so the parsers
 * never have to reason about extras/sample/junk/unsupported paths themselves.
 *
 * Precedence (first match wins):
 *  1. Hidden/system files (dotfiles, AppleDouble `._*`, Thumbs.db) → 'ignored'.
 *     Checked before anything else because these are junk regardless of
 *     which directory they happen to sit in (including inside an extras dir).
 *  2. Known-media-but-excluded-in-v1 extension (EXCLUDED_MEDIA_EXTENSIONS —
 *     ape/wv/wma, STATE.md H3) → 'unsupported'. Checked BEFORE the generic
 *     non-media-extension rule below, and deliberately NOT folded into it:
 *     this is recognizable media the scanner is choosing not to ingest, not
 *     junk — the scanner counts and visibly reports it (scan.completed's
 *     skippedUnsupportedCount/skippedUnsupportedFiles), so it must never be
 *     swallowed into the same undifferentiated 'ignored' bucket as a stray
 *     .txt file.
 *  3. Non-media extension (not a known video/audio container, and not an
 *     excluded one either) → 'ignored'. Same rationale as rule 1: a stray
 *     .jpg/.nfo/.txt inside "Featurettes/" is still not a media file this
 *     parser subsystem should touch.
 *  4. Sample files: a "Sample"/"Samples" directory anywhere in the path, or
 *     a "sample" token in the filename itself → 'sample'.
 *  5. Nested extras directories anywhere in the path → 'extra'.
 *  6. Otherwise → null (not auxiliary; proceed with normal kind-specific parsing).
 */
import {
  basename,
  EXCLUDED_MEDIA_EXTENSIONS,
  MEDIA_EXTENSIONS,
  splitExtension,
  splitSegments,
} from "./path-utils.js";
import type { AuxiliaryKind } from "./types.js";

const EXTRAS_DIR_NAMES = new Set([
  "featurettes",
  "behind the scenes",
  "extras",
  "trailers",
  "interviews",
  "deleted scenes",
  "shorts",
  "other",
]);

const SAMPLE_DIR_NAMES = new Set(["sample", "samples"]);

function isHiddenOrSystemFile(name: string): boolean {
  if (name.startsWith(".")) return true; // .DS_Store, .gitkeep, dotfiles in general
  if (name.startsWith("._")) return true; // macOS AppleDouble sidecar (redundant with above, kept for clarity)
  if (name.toLowerCase() === "thumbs.db") return true;
  if (name.toLowerCase() === "desktop.ini") return true;
  return false;
}

function hasSampleToken(stem: string): boolean {
  return /(?<=^|[\s._-])sample(?=$|[\s._-])/i.test(stem);
}

export function classifyAuxiliary(relPath: string): AuxiliaryKind {
  const segments = splitSegments(relPath);
  if (segments.length === 0) return null;

  const file = basename(relPath);
  if (isHiddenOrSystemFile(file)) return "ignored";

  const { stem, ext } = splitExtension(file);
  if (ext && EXCLUDED_MEDIA_EXTENSIONS.has(ext)) return "unsupported";
  if (ext && !MEDIA_EXTENSIONS.has(ext)) return "ignored";

  const dirs = segments.slice(0, -1).map((d) => d.toLowerCase());

  if (dirs.some((d) => SAMPLE_DIR_NAMES.has(d)) || hasSampleToken(stem)) return "sample";

  if (dirs.some((d) => EXTRAS_DIR_NAMES.has(d))) return "extra";

  return null;
}
