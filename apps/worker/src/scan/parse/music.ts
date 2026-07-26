// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Music filename/folder parser — docs/PLAN.md §8.1. FALLBACK LAYER ONLY:
 * tags win upstream (STATE.md P1.4); this exists for files with missing or
 * unreliable tags.
 *
 * Directory precedence: `Artist/Album/[Disc N|CD N/]Track` is the primary
 * shape. The last directory segment is checked for a "Disc N"/"CD N"
 * pattern first (and consumed as discNumber if found); of what remains, the
 * last directory is the album (year suffix stripped, e.g. "Album (2019)"),
 * the one before it is the artist. A single remaining directory is treated
 * as artist-only (no album layer).
 *
 * Filename precedence: `D-NN Title` (disc-track composite) beats a plain
 * leading `NN Title` (track only) beats the flat dash form
 * `Artist - Album - NN - Title` (attempted only when the path has NO
 * directories at all — it is a self-contained encoding) beats a bare title
 * with no track number (track-number-less files, e.g. from a
 * pre-scan/library that never numbered tracks).
 */
import { basename, cleanupWhitespace, dirSegments, splitExtension } from "./path-utils.js";
import type { Confidence, MusicGuess } from "./types.js";

const DISC_DIR_REGEX = /^(disc|cd)[\s._-]*0*(\d{1,3})$/i;
const ALBUM_YEAR_SUFFIX_REGEX = /^(.*?)[\s._-]*\((\d{4})\)\s*$/;

const DISC_TRACK_PREFIX_REGEX = /^0*(\d{1,2})-0*(\d{1,3})[\s._-]+(.+)$/;
const TRACK_PREFIX_REGEX = /^0*(\d{1,3})[\s._-]+(.+)$/;

export function parseMusicPath(relPath: string): MusicGuess | null {
  const file = basename(relPath);
  if (!file) return null;
  const { stem } = splitExtension(file);
  if (!stem.trim()) return null;

  const reasons: string[] = [];
  const dirs = dirSegments(relPath);
  let dirsWorking = dirs;

  let discNumber: number | null = null;
  let artist: string | null = null;
  let album: string | null = null;

  if (dirsWorking.length > 0) {
    const last = dirsWorking[dirsWorking.length - 1]!.trim();
    const discDirMatch = DISC_DIR_REGEX.exec(last);
    if (discDirMatch) {
      discNumber = Number(discDirMatch[2]!);
      reasons.push("dir:disc");
      dirsWorking = dirsWorking.slice(0, -1);
    }
  }

  if (dirsWorking.length >= 2) {
    // Year-suffix stripping runs on the RAW directory name, before
    // cleanupWhitespace: cleanupWhitespace trims trailing ")" as boundary
    // punctuation, which would otherwise destroy the very "(YYYY)" the
    // regex below needs to match intact.
    const rawAlbum = dirsWorking[dirsWorking.length - 1]!;
    const yearMatch = ALBUM_YEAR_SUFFIX_REGEX.exec(rawAlbum.trim());
    album = cleanupWhitespace(yearMatch ? yearMatch[1]! : rawAlbum);
    artist = cleanupWhitespace(dirsWorking[dirsWorking.length - 2]!);
    reasons.push("dir:artist-album");
    if (yearMatch) reasons.push("year:stripped-from-album-dir");
  } else if (dirsWorking.length === 1) {
    artist = cleanupWhitespace(dirsWorking[0]!);
    reasons.push("dir:artist-only");
  }

  let trackNumber: number | null = null;
  let title: string;
  const trimmedStem = stem.trim();

  const compositeMatch = DISC_TRACK_PREFIX_REGEX.exec(trimmedStem);
  if (compositeMatch) {
    discNumber = Number(compositeMatch[1]!);
    trackNumber = Number(compositeMatch[2]!);
    title = cleanupWhitespace(compositeMatch[3]!);
    reasons.push("matched:disc-track");
  } else {
    const trackMatch = TRACK_PREFIX_REGEX.exec(trimmedStem);
    if (trackMatch) {
      trackNumber = Number(trackMatch[1]!);
      title = cleanupWhitespace(trackMatch[2]!);
      reasons.push("matched:track-title");
    } else if (dirs.length === 0) {
      const parts = trimmedStem
        .split(" - ")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length === 4 && /^\d{1,3}$/.test(parts[2]!)) {
        artist = parts[0]!;
        album = parts[1]!;
        trackNumber = Number(parts[2]!);
        title = parts[3]!;
        reasons.push("matched:flat-artist-album-track");
      } else if (parts.length === 3 && /^\d{1,3}$/.test(parts[1]!)) {
        artist = parts[0]!;
        trackNumber = Number(parts[1]!);
        title = parts[2]!;
        reasons.push("matched:flat-artist-track");
      } else {
        title = cleanupWhitespace(trimmedStem);
        reasons.push("track:absent");
      }
    } else {
      title = cleanupWhitespace(trimmedStem);
      reasons.push("track:absent");
    }
  }

  if (!title) return null;

  const hasTrack = trackNumber !== null;
  const hasArtistAlbum = artist !== null && album !== null;
  const confidence: Confidence = hasTrack && hasArtistAlbum ? "high" : hasTrack || hasArtistAlbum ? "medium" : "low";

  return { artist, album, discNumber, trackNumber, title, confidence, reasons };
}
