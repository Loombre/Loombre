// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/media-info.ts
//
// getMediaInfoAssembly — builds the docs/PLAYBACK.md §2.1 MediaInfo shape
// from a media_files row + its media_streams rows, guarded by the SAME item
// visibility check every other guarded read in this package uses
// (getItemById). This is the one place apps/server's playback module gets a
// MediaInfo-shaped object to hand to
// @loombre/playback-engine's checkStaticCompat() (P2.17) — this package does
// NOT depend on @loombre/playback-engine itself (no new cross-package
// dependency for a handful of structurally-identical field types; see the
// exported Assembled* types below, which mirror docs/PLAYBACK.md §2.1
// field-for-field on purpose so a caller that DOES import
// @loombre/playback-engine's MediaInfo type can pass this function's return
// value straight through — TypeScript's structural typing accepts it
// without either package importing the other, the same "shapes agree by
// convention, not by import" relationship the contract/db/playback-engine
// trio already has everywhere else in this codebase).
//
// Known gap (documented, not fixed here): media_streams has no
// is_external/external_path columns — the scanner never resolves sidecar
// subtitle files (NFO/sidecar reading is scanner-only per CLAUDE.md
// invariant 8, and external-subtitle resolution specifically is not part of
// Phase 1's probe pipeline). Every assembled SubtitleStream therefore has
// isExternal: false, externalPath: null. Direct-play-only Phase 2 has no
// caller that needs external subtitles (no burn-in/HLS pipeline exists yet),
// so this is a documented limitation, not a silent bug.
//
// "Not ready" handling: a media_files row that hasn't been probed yet
// (container/duration_ms/probed_at_ms still NULL, docs/PLAN.md §8.3) cannot
// produce a valid MediaInfo.container (the enum has no "unknown" member) —
// getMediaInfoAssembly returns undefined for such a file rather than
// fabricating one, exactly like getItemById returns undefined for
// nonexistent/invisible rows. The caller (apps/server) is expected to
// surface this as a 404/409 rather than crash.

import type { Kysely } from 'kysely';
import type { DB } from '../types.js';
import type { ViewerContext } from '../context.js';
import { getItemById } from './items.js';

// v1.1 widening (STATE.md H3, docs/PLAYBACK.md §2.1): asf/mpeg/flv/aac/aiff.
export type AssembledContainer =
  | 'mp4'
  | 'mkv'
  | 'webm'
  | 'avi'
  | 'ts'
  | 'mov'
  | 'flac'
  | 'mp3'
  | 'ogg'
  | 'm4a'
  | 'wav'
  | 'asf'
  | 'mpeg'
  | 'flv'
  | 'aac'
  | 'aiff';
export type AssembledVideoCodec = 'h264' | 'hevc' | 'av1' | 'vp9' | 'mpeg2' | 'vc1' | 'mpeg4' | 'unknown';
export type AssembledAudioCodec =
  | 'aac'
  | 'ac3'
  | 'eac3'
  | 'truehd'
  | 'dts'
  | 'dtshd'
  | 'flac'
  | 'opus'
  | 'mp3'
  | 'vorbis'
  | 'pcm'
  | 'unknown';
export type AssembledSubtitleCodec = 'subrip' | 'ass' | 'webvtt' | 'mov_text' | 'pgs' | 'vobsub' | 'dvbsub' | 'unknown';
export type AssembledHdr = 'none' | 'hdr10' | 'hlg' | 'dv';

export interface AssembledVideoStream {
  index: number;
  codec: AssembledVideoCodec;
  profile: string | null;
  level: number | null;
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12;
  frameRate: number;
  bitrateBps: number | null;
  hdr: AssembledHdr;
  dvProfile: number | null;
  dvBlCompatId: number | null;
  interlaced: boolean;
  /** docs/PLAYBACK.md §2.1 (added 2026-08-10) — mirrors
   *  @loombre/playback-engine's VideoStream.openGop field-for-field (this
   *  module's own header). Sourced from media_streams.open_gop
   *  (migrations/0038_media_streams_open_gop.sql); see toOpenGop below for
   *  the NULL -> false mapping rule. */
  openGop: boolean;
}

export interface AssembledAudioStream {
  index: number;
  codec: AssembledAudioCodec;
  channels: number;
  sampleRate: number;
  bitrateBps: number | null;
  language: string | null;
  isDefault: boolean;
  hasAtmos: boolean;
}

export interface AssembledSubtitleStream {
  index: number;
  codec: AssembledSubtitleCodec;
  language: string | null;
  isForced: boolean;
  isDefault: boolean;
  isExternal: boolean;
  externalPath: string | null;
}

export interface AssembledMediaInfo {
  fileId: string;
  container: AssembledContainer;
  durationMs: number;
  sizeBytes: number;
  overallBitrateBps: number;
  video: AssembledVideoStream[];
  audio: AssembledAudioStream[];
  subtitle: AssembledSubtitleStream[];
}

export interface MediaInfoAssembly {
  itemId: string;
  fileId: string;
  media: AssembledMediaInfo;
}

export interface GetMediaInfoAssemblyParams {
  /** Resolve the item's primary media file (first non-missing row, deriving
   *  determinism from id ordering — see resolvePrimaryFile below). Ignored
   *  when `fileId` is also supplied. */
  itemId?: string;
  /** Resolve this exact file. Its owning item is still guard-checked. */
  fileId?: string;
}

const CONTAINERS: ReadonlySet<string> = new Set([
  'mp4',
  'mkv',
  'webm',
  'avi',
  'ts',
  'mov',
  'flac',
  'mp3',
  'ogg',
  'm4a',
  'wav',
  'asf',
  'mpeg',
  'flv',
  'aac',
  'aiff',
]);
const VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg2', 'vc1', 'mpeg4', 'unknown']);
const AUDIO_CODECS: ReadonlySet<string> = new Set([
  'aac',
  'ac3',
  'eac3',
  'truehd',
  'dts',
  'dtshd',
  'flac',
  'opus',
  'mp3',
  'vorbis',
  'pcm',
  'unknown',
]);
const SUBTITLE_CODECS: ReadonlySet<string> = new Set(['subrip', 'ass', 'webvtt', 'mov_text', 'pgs', 'vobsub', 'dvbsub', 'unknown']);
const HDR_KINDS: ReadonlySet<string> = new Set(['none', 'hdr10', 'hlg', 'dv']);

// Exported (not just module-local) so catalog-detail.ts's fetchMediaFilesBatch
// can apply the SAME untrusted-column -> strict-enum defense when it surfaces
// a handful of these same media_streams columns on MediaFileSummary (movie
// detail's VERSIONS cards, Phosphor W2 L4) — one mapping, two callers, rather
// than a second copy of the same enum sets drifting out of sync.
export function toVideoCodec(v: string | null): AssembledVideoCodec {
  return v !== null && VIDEO_CODECS.has(v) ? (v as AssembledVideoCodec) : 'unknown';
}
export function toAudioCodec(v: string | null): AssembledAudioCodec {
  return v !== null && AUDIO_CODECS.has(v) ? (v as AssembledAudioCodec) : 'unknown';
}
export function toSubtitleCodec(v: string | null): AssembledSubtitleCodec {
  return v !== null && SUBTITLE_CODECS.has(v) ? (v as AssembledSubtitleCodec) : 'unknown';
}
export function toHdr(v: string | null): AssembledHdr {
  return v !== null && HDR_KINDS.has(v) ? (v as AssembledHdr) : 'none';
}
export function toBitDepth(v: number | null): 8 | 10 | 12 {
  return v === 10 ? 10 : v === 12 ? 12 : 8;
}
/** migrations/0038_media_streams_open_gop.sql: NULL ("not yet probed for
 *  this fact") maps to `false` — conservative by construction, never strip
 *  GOP-boundary NAL units (playback-engine's seek-restart bitstream filter)
 *  unless the probe pipeline POSITIVELY detected an open-GOP HEVC stream.
 *  A real `true`/`false` verdict passes straight through. */
export function toOpenGop(v: boolean | null): boolean {
  return v === true;
}

/**
 * Deterministically picks the item's "primary" media file among possibly
 * several (multi-version/multi-part, migrations/0003_media_files_version_label.sql):
 * the un-labelled row (version_label IS NULL) wins if present, else the
 * lowest id (UUIDv7 -> earliest-ingested) among non-missing rows.
 */
async function resolvePrimaryFile(db: Kysely<DB>, itemId: string) {
  const unlabelled = await db
    .selectFrom('media_files')
    .selectAll()
    .where('item_id', '=', itemId)
    .where('missing_since_ms', 'is', null)
    .where('version_label', 'is', null)
    .orderBy('id', 'asc')
    .executeTakeFirst();
  if (unlabelled) return unlabelled;

  return db
    .selectFrom('media_files')
    .selectAll()
    .where('item_id', '=', itemId)
    .where('missing_since_ms', 'is', null)
    .orderBy('id', 'asc')
    .executeTakeFirst();
}

export async function getMediaInfoAssembly(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: GetMediaInfoAssemblyParams
): Promise<MediaInfoAssembly | undefined> {
  let file: { id: string; item_id: string; path: string; container: string | null; duration_ms: number | null; size_bytes: number | null; probed_at_ms: number | null } | undefined;

  if (params.fileId) {
    const row = await db.selectFrom('media_files').selectAll().where('id', '=', params.fileId).executeTakeFirst();
    if (!row) return undefined;
    // Defense in depth: when a caller supplies BOTH itemId and fileId (e.g.
    // PlanRequest.mediaFileId alongside PlanRequest.itemId), the file must
    // actually belong to that item — a mismatched pair is treated as not
    // found rather than silently preferring one over the other.
    if (params.itemId && params.itemId !== row.item_id) return undefined;
    const item = await getItemById(db, ctx, row.item_id);
    if (!item) return undefined;
    file = row;
  } else if (params.itemId) {
    const item = await getItemById(db, ctx, params.itemId);
    if (!item) return undefined;
    const row = await resolvePrimaryFile(db, params.itemId);
    if (!row) return undefined;
    file = row;
  } else {
    return undefined;
  }

  if (file.probed_at_ms === null || file.container === null || file.duration_ms === null) {
    // Not yet probed — see module header ("Not ready" handling).
    return undefined;
  }
  if (!CONTAINERS.has(file.container)) {
    return undefined;
  }

  const streams = await db
    .selectFrom('media_streams')
    .selectAll()
    .where('file_id', '=', file.id)
    .orderBy('stream_index', 'asc')
    .execute();

  const video: AssembledVideoStream[] = streams
    .filter((s) => s.stream_type === 'video')
    .map((s) => ({
      index: s.stream_index,
      codec: toVideoCodec(s.codec),
      profile: s.profile,
      level: s.level !== null ? Number.parseFloat(s.level) : null,
      width: s.width ?? 0,
      height: s.height ?? 0,
      bitDepth: toBitDepth(s.bit_depth),
      frameRate: s.frame_rate ?? 0,
      bitrateBps: s.bitrate_bps,
      hdr: toHdr(s.hdr),
      dvProfile: s.dv_profile,
      dvBlCompatId: s.dv_bl_compat_id,
      interlaced: s.interlaced ?? false,
      openGop: toOpenGop(s.open_gop),
    }));

  const audio: AssembledAudioStream[] = streams
    .filter((s) => s.stream_type === 'audio')
    .map((s) => ({
      index: s.stream_index,
      codec: toAudioCodec(s.codec),
      channels: s.channels ?? 0,
      sampleRate: s.sample_rate ?? 0,
      bitrateBps: s.bitrate_bps,
      language: s.language,
      isDefault: s.is_default,
      hasAtmos: s.has_atmos ?? false,
    }));

  const subtitle: AssembledSubtitleStream[] = streams
    .filter((s) => s.stream_type === 'subtitle')
    .map((s) => ({
      index: s.stream_index,
      codec: toSubtitleCodec(s.codec),
      language: s.language,
      isForced: s.is_forced,
      isDefault: s.is_default,
      // Not modeled by media_streams yet — see module header.
      isExternal: false,
      externalPath: null,
    }));

  const sizeBytes = file.size_bytes ?? 0;
  const durationMs = file.duration_ms;
  const overallBitrateBps = durationMs > 0 ? Math.round((sizeBytes * 8) / (durationMs / 1000)) : 0;

  return {
    itemId: file.item_id,
    fileId: file.id,
    media: {
      fileId: file.id,
      container: file.container as AssembledContainer,
      durationMs,
      sizeBytes,
      overallBitrateBps,
      video,
      audio,
      subtitle,
    },
  };
}
