// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Auxiliary-path classifier — docs/PLAN.md §8.1. Called FIRST by the
 * scanner, before any movie/TV/music parsing is attempted, so the parsers
 * never have to reason about extras/sample/junk paths themselves.
 *
 * Precedence (first match wins):
 *  1. Hidden/system files (dotfiles, AppleDouble `._*`, Thumbs.db) → 'ignored'.
 *     Checked before anything else because these are junk regardless of
 *     which directory they happen to sit in (including inside an extras dir).
 *  2. Non-media extension (not a known video/audio container) → 'ignored'.
 *     Same rationale: a stray .jpg/.nfo/.txt inside "Featurettes/" is still
 *     not a media file this parser subsystem should touch.
 *  3. Sample files: a "Sample"/"Samples" directory anywhere in the path, or
 *     a "sample" token in the filename itself → 'sample'.
 *  4. Nested extras directories anywhere in the path → 'extra'.
 *  5. Otherwise → null (not auxiliary; proceed with normal kind-specific parsing).
 */
import { basename, MEDIA_EXTENSIONS, splitExtension, splitSegments } from "./path-utils.js";
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
  if (ext && !MEDIA_EXTENSIONS.has(ext)) return "ignored";

  const dirs = segments.slice(0, -1).map((d) => d.toLowerCase());

  if (dirs.some((d) => SAMPLE_DIR_NAMES.has(d)) || hasSampleToken(stem)) return "sample";

  if (dirs.some((d) => EXTRAS_DIR_NAMES.has(d))) return "extra";

  return null;
}
