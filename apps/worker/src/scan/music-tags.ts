// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Music tag reading — tag-first is the deliberate correctness choice for
 * music (STATE.md P1.4, docs/PLAN.md §8.1: filenames alone are unreliable
 * for music, unlike movies/TV): `parseMusicPath` (./parse/music.ts) is the
 * FALLBACK layer only; this module is what the scanner tries FIRST for
 * audio files.
 *
 * `TagReader` is an injectable seam (deliberately, per the task's test
 * requirement: "fixture the music-metadata output boundary with a thin
 * injectable tag-reader seam") — ./scanner.ts takes one via ScanDeps,
 * defaulting to `readTagsWithMusicMetadata` below. Tests can substitute a
 * fake reader that returns canned tags (or `null`, simulating an
 * untaggable/corrupt file) without needing a real audio codec or a real
 * ffmpeg-tagged fixture, while apps/worker/test/scan/music-tag-first.spec.ts
 * additionally exercises the REAL music-metadata parseFile() path against a
 * real ffmpeg-tagged mp3.
 */
import { parseFile } from "music-metadata";

export interface ParsedTags {
  artist: string | null;
  album: string | null;
  discNumber: number | null;
  trackNumber: number | null;
  title: string | null;
}

export type TagReader = (absPath: string) => Promise<ParsedTags | null>;

/** Real implementation: music-metadata's parseFile(). Returns null (never
 * throws) when tags are missing/unreadable/corrupt — the caller falls back
 * to parseMusicPath in that case, per P1.4's documented precedence. */
export const readTagsWithMusicMetadata: TagReader = async (absPath) => {
  try {
    const metadata = await parseFile(absPath);
    const common = metadata.common;
    const hasAnyTag =
      Boolean(common.title) || Boolean(common.artist) || Boolean(common.album) || common.track.no !== null;
    if (!hasAnyTag) return null;
    return {
      artist: common.artist ?? null,
      album: common.album ?? null,
      discNumber: common.disk.no ?? null,
      trackNumber: common.track.no ?? null,
      title: common.title ?? null,
    };
  } catch {
    return null;
  }
};
