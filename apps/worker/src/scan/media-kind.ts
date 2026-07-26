// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-library-media-kind extension filtering (docs/PLAN.md §8.1: "Media
 * extensions per library.media_kind"). `classifyAuxiliary()`
 * (./parse/auxiliary.ts) already rejects anything outside the COMBINED
 * video+audio extension set as 'ignored', but it has no notion of which
 * library it's running against — a stray .mp3 sitting in a movie library
 * is a real file `classifyAuxiliary` would NOT flag as auxiliary (it's a
 * legitimate media extension, just the wrong kind for this library). This
 * module is the second, kind-aware filter the scanner applies right after
 * classifyAuxiliary().
 */
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from "./parse/index.js";
import type { MediaKind } from "@loombre/shared";

/** True when `ext` (lowercase, no leading dot) is a playable media
 * extension for `mediaKind`: video extensions for 'movie'/'tv', audio
 * extensions for 'music'. */
export function isMediaExtensionForKind(ext: string, mediaKind: MediaKind): boolean {
  if (mediaKind === "music") return AUDIO_EXTENSIONS.has(ext);
  return VIDEO_EXTENSIONS.has(ext);
}

/** Lowercase extension (no leading dot) of a POSIX relative path's
 * filename, or "" if there is none. Minimal, deliberately NOT imported
 * from parse/path-utils.ts's splitExtension (that would be reaching into
 * parse internals beyond the barrel this module is meant to consume) —
 * this is a tiny, independent string operation, not a parsing RULE. */
export function extensionOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? "";
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === base.length - 1) return "";
  return base.slice(lastDot + 1).toLowerCase();
}
