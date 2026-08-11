// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The 'probe' job handler (deliverable B, docs/PLAN.md §8.3/P1.5). Loads
 * the media_files row named by the job payload, runs ffprobe, stores the
 * RAW json + probed_at_ms, extracts typed MediaInfo and replaces the
 * file's media_streams rows (including the 0002 hdr/dv_profile/
 * dv_bl_compat_id/has_atmos/interlaced columns, and — migrations/0038_
 * media_streams_open_gop.sql — a bounded ffmpeg trace_headers scan per
 * HEVC video stream, see resolveOpenGopByIndex/./opengop.ts), and derives
 * media_files.duration_ms + container.
 *
 * Runtime-derived fields, NOT stored here (see module-level decision
 * notes below and STATE.md's Phase-0-wave-3 note n1: "Episode.runtimeMs
 * derives from media_files.duration_ms"):
 *   - movie_details.runtime_ms / episode "runtime": episode_details
 *     (migrations/0001_init.sql) has NO runtime_ms column at all — the
 *     contract's Episode.runtimeMs is computed at API-read time FROM
 *     media_files.duration_ms, not stored redundantly here. This module
 *     only ever writes media_files.duration_ms; it does not touch
 *     movie_details either, for the same "single source of truth, derive
 *     at read time" reason, even though movie_details.runtime_ms exists
 *     as a column — precedent set by the episode case, applied
 *     consistently rather than writing it for movies only.
 *   - track_details.duration_ms DOES exist and IS backfilled here (the
 *     task explicitly calls out "track runtime ... only set if column
 *     exists" — it does for tracks) by reading the current track_number/
 *     disc_number first (upsertSatellite's track branch always writes all
 *     three columns together) and re-upserting with the probed duration.
 *
 * No keyframe indexing (deliverable B is explicitly keyframe-free v1).
 * ffprobe absent -> the ProbeError propagates as a normal job failure
 * (P1.9 spirit: absence is a clean, reportable condition, never a crash).
 */
import {
  getMediaFileById,
  getCatalogItemById,
  getTrackDetails,
  upsertSatellite,
  setMediaFileProbeResult,
  replaceFileStreams,
  type DbOrTx,
  type ReplaceStreamInput,
} from "@loombre/db/internal";
import { runFfprobe, extractMediaInfo, detectOpenGop } from "./index.js";
import type { RawProbeResult, MediaInfo, VideoStream, AudioStream, SubtitleStream, OpenGopVerdict } from "./index.js";

export interface ProbeDeps {
  db: DbOrTx;
  clock?: () => number;
  /** Test seam — bypasses the real ffprobe spawn (see
   *  test/probe/consumer.spec.ts's fake-ffprobe fixtures, mirroring
   *  test/probe/probe.integration.spec.ts's own convention). Defaults to
   *  the real runFfprobe. */
  runFfprobe?: (filePath: string) => Promise<RawProbeResult>;
  /** Test seam — bypasses the real bounded ffmpeg trace_headers scan (see
   *  test/probe/opengop.spec.ts's fake-detector convention). Defaults to
   *  the real detectOpenGop (./opengop.ts). Signature matches
   *  detectOpenGop's own (filePath, videoTypeIndex, codec, durationMs) ->
   *  OpenGopVerdict. */
  detectOpenGop?: (
    filePath: string,
    videoTypeIndex: number,
    codec: string,
    durationMs: number | null,
  ) => Promise<OpenGopVerdict>;
}

export interface RunProbeParams {
  mediaFileId: string;
}

/** Raw color_transfer per video stream index, straight from ffprobe. The
 *  §2.1 VideoStream shape deliberately drops this in favour of the derived
 *  `hdr` enum (that's what the playback engine consumes), but PLAN §6.3
 *  lists media_streams.color_transfer as a stored field, so we backfill the
 *  column from the raw probe rather than leaving it NULL. */
function rawColorTransferByIndex(raw: RawProbeResult): Map<number, string | null> {
  const byIndex = new Map<number, string | null>();
  const streams = (raw as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return byIndex;
  for (const entry of streams) {
    const s = entry as Record<string, unknown>;
    if (s["codec_type"] === "video" && typeof s["index"] === "number") {
      const ct = s["color_transfer"];
      byIndex.set(s["index"], typeof ct === "string" && ct.length > 0 ? ct : null);
    }
  }
  return byIndex;
}

/**
 * Runs detectOpenGop for every HEVC video stream, sequentially (one ffmpeg
 * child at a time — a single probe job never fans out N concurrent
 * trace_headers scans, mirroring the single-ffprobe-at-a-time shape the
 * rest of this consumer already has). Non-HEVC video streams get `false`
 * with no scan at all (docs/PLAYBACK.md §2.1/migrations/0038's HEVC-only-
 * in-v1 rule — the engine never consults this field for other codecs; this
 * short-circuit is a performance optimization only — detectOpenGop's own
 * codec parameter would resolve the same `false` without spawning either
 * way, see opengop.ts's "Codec guard" doc section).
 * Keyed by the stream's ABSOLUTE ffprobe index (VideoStream.index), which
 * toStreamInputs below looks up per video entry; `videoTypeIndex` (the
 * detector's own `-map 0:v:N` argument) is simply the stream's 0-based
 * POSITION within `video` — MediaInfo.video is already sorted by absolute
 * index (extract.ts's byIndex), so array position IS ffmpeg's per-type
 * demux order. `durationMs` is the file's overall duration from this same
 * probe run (extractMediaInfo's MediaInfo.durationMs, §2.1's "format.
 * duration s->ms" conversion) — 0 (ffprobe reported no format.duration at
 * all) is normalized to `null` ("unknown") here, since opengop.ts's
 * detectOpenGop treats `null` as "fall back to the raised from-start
 * bound", never as a genuine zero-length file.
 */
async function resolveOpenGopByIndex(
  detect: (filePath: string, videoTypeIndex: number, codec: string, durationMs: number | null) => Promise<OpenGopVerdict>,
  filePath: string,
  video: VideoStream[],
  durationMs: number,
): Promise<Map<number, OpenGopVerdict>> {
  const result = new Map<number, OpenGopVerdict>();
  const knownDurationMs = durationMs > 0 ? durationMs : null;
  for (const [videoTypeIndex, stream] of video.entries()) {
    if (stream.codec !== "hevc") {
      result.set(stream.index, false);
      continue;
    }
    result.set(stream.index, await detect(filePath, videoTypeIndex, stream.codec, knownDurationMs));
  }
  return result;
}

function toStreamInputs(
  info: MediaInfo,
  raw: RawProbeResult,
  openGopByIndex: Map<number, OpenGopVerdict>,
): ReplaceStreamInput[] {
  const colorTransferByIndex = rawColorTransferByIndex(raw);
  const video: ReplaceStreamInput[] = info.video.map((s: VideoStream) => ({
    streamIndex: s.index,
    streamType: "video",
    codec: s.codec,
    profile: s.profile,
    level: s.level === null ? null : String(s.level),
    width: s.width,
    height: s.height,
    bitDepth: s.bitDepth,
    colorTransfer: colorTransferByIndex.get(s.index) ?? null,
    bitrateBps: s.bitrateBps,
    frameRate: s.frameRate,
    hdr: s.hdr,
    dvProfile: s.dvProfile,
    dvBlCompatId: s.dvBlCompatId,
    interlaced: s.interlaced,
    openGop: openGopByIndex.get(s.index) ?? null,
  }));
  const audio: ReplaceStreamInput[] = info.audio.map((s: AudioStream) => ({
    streamIndex: s.index,
    streamType: "audio",
    codec: s.codec,
    channels: s.channels,
    sampleRate: s.sampleRate,
    bitrateBps: s.bitrateBps,
    language: s.language,
    isDefault: s.isDefault,
    hasAtmos: s.hasAtmos,
  }));
  const subtitle: ReplaceStreamInput[] = info.subtitle.map((s: SubtitleStream) => ({
    streamIndex: s.index,
    streamType: "subtitle",
    codec: s.codec,
    language: s.language,
    isDefault: s.isDefault,
    isForced: s.isForced,
  }));
  return [...video, ...audio, ...subtitle];
}

export async function runProbe(deps: ProbeDeps, params: RunProbeParams): Promise<void> {
  const clock = deps.clock ?? Date.now;
  const probeFn = deps.runFfprobe ?? ((filePath: string) => runFfprobe(filePath));
  const detectOpenGopFn = deps.detectOpenGop ?? detectOpenGop;

  const file = await getMediaFileById(deps.db, params.mediaFileId);
  if (!file) {
    throw new Error(`probe: media_files ${params.mediaFileId} does not exist`);
  }

  // Binary-missing / spawn / timeout / nonzero-exit / invalid-json all
  // surface as a typed ProbeError here and propagate unchanged — the job
  // queue (packages/jobs) records it as a failed job with the error
  // message, no crash (P1.9 spirit).
  const raw = await probeFn(file.path);

  const sizeBytes = file.size_bytes ?? 0;
  const info = extractMediaInfo(raw, { sizeBytes, fileId: file.id, filenameHint: file.path });

  const now = clock();
  await setMediaFileProbeResult(deps.db, file.id, {
    probe: raw as Record<string, unknown>,
    probedAtMs: now,
    durationMs: info.durationMs,
    container: info.container,
  });

  const openGopByIndex = await resolveOpenGopByIndex(detectOpenGopFn, file.path, info.video, info.durationMs);
  await replaceFileStreams(deps.db, file.id, toStreamInputs(info, raw, openGopByIndex));

  const item = await getCatalogItemById(deps.db, file.item_id);
  if (item?.item_type === "track") {
    const existing = await getTrackDetails(deps.db, item.id);
    await upsertSatellite(deps.db, {
      itemType: "track",
      item_id: item.id,
      track_number: existing?.track_number ?? null,
      disc_number: existing?.disc_number ?? null,
      duration_ms: info.durationMs,
    });
  }
}
