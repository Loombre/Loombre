// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/media-assembly.ts
//
// Guard-free twin of src/query/media-info.ts's getMediaInfoAssembly, keyed
// directly by a KNOWN media_files id rather than resolved-and-guarded via
// an itemId + ViewerContext. Exists for exactly one caller: the transcode
// session runtime's seek-restart path (apps/worker/src/transcode/args.ts),
// which needs to regenerate ffmpeg args via @loombre/playback-engine's
// buildFfmpegArgs(input, planShape, {withSeek:true}) — that function reads
// `input.media`/`input.selection`/`input.device.video`, and the worker
// already knows the session's own `file_id` (from the row it is
// authoritatively supervising, docs/PLAYBACK.md §9) with no viewer request
// in flight to guard against. Field mapping is intentionally identical to
// query/media-info.ts's — see that file's header for the "not yet probed"/
// container-membership handling this mirrors verbatim.

import type { DbOrTx } from './tx.js';
import type {
  AssembledAudioStream,
  AssembledMediaInfo,
  AssembledSubtitleStream,
  AssembledVideoStream,
} from '../query/media-info.js';

const CONTAINERS: ReadonlySet<string> = new Set([
  'mp4', 'mkv', 'webm', 'avi', 'ts', 'mov', 'flac', 'mp3', 'ogg', 'm4a', 'wav',
]);
const VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg2', 'vc1', 'mpeg4', 'unknown']);
const AUDIO_CODECS: ReadonlySet<string> = new Set([
  'aac', 'ac3', 'eac3', 'truehd', 'dts', 'dtshd', 'flac', 'opus', 'mp3', 'vorbis', 'pcm', 'unknown',
]);
const SUBTITLE_CODECS: ReadonlySet<string> = new Set(['subrip', 'ass', 'webvtt', 'mov_text', 'pgs', 'vobsub', 'dvbsub', 'unknown']);
const HDR_KINDS: ReadonlySet<string> = new Set(['none', 'hdr10', 'hlg', 'dv']);

function toVideoCodec(v: string | null): AssembledVideoStream['codec'] {
  return v !== null && VIDEO_CODECS.has(v) ? (v as AssembledVideoStream['codec']) : 'unknown';
}
function toAudioCodec(v: string | null): AssembledAudioStream['codec'] {
  return v !== null && AUDIO_CODECS.has(v) ? (v as AssembledAudioStream['codec']) : 'unknown';
}
function toSubtitleCodec(v: string | null): AssembledSubtitleStream['codec'] {
  return v !== null && SUBTITLE_CODECS.has(v) ? (v as AssembledSubtitleStream['codec']) : 'unknown';
}
function toHdr(v: string | null): AssembledVideoStream['hdr'] {
  return v !== null && HDR_KINDS.has(v) ? (v as AssembledVideoStream['hdr']) : 'none';
}
function toBitDepth(v: number | null): 8 | 10 | 12 {
  return v === 10 ? 10 : v === 12 ? 12 : 8;
}

/**
 * Assembles the §2.1 MediaInfo shape for a KNOWN media_files id. Returns
 * `undefined` when the file does not exist or has not been probed yet
 * (same "not ready" handling as the guarded twin) — a seek-restart can
 * only ever be requested against a session whose file was already probed
 * at session-create time, so this is a defensive check, not an expected
 * path.
 */
export async function getMediaInfoForFile(db: DbOrTx, fileId: string): Promise<AssembledMediaInfo | undefined> {
  const file = await db.selectFrom('media_files').selectAll().where('id', '=', fileId).executeTakeFirst();
  if (!file) return undefined;
  if (file.probed_at_ms === null || file.container === null || file.duration_ms === null) return undefined;
  if (!CONTAINERS.has(file.container)) return undefined;

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
      isExternal: false,
      externalPath: null,
    }));

  const sizeBytes = file.size_bytes ?? 0;
  const durationMs = file.duration_ms;
  const overallBitrateBps = durationMs > 0 ? Math.round((sizeBytes * 8) / (durationMs / 1000)) : 0;

  return {
    fileId: file.id,
    container: file.container as AssembledMediaInfo['container'],
    durationMs,
    sizeBytes,
    overallBitrateBps,
    video,
    audio,
    subtitle,
  };
}
