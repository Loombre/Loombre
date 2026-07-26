// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The 'probe' job handler (deliverable B, docs/PLAN.md §8.3/P1.5). Loads
 * the media_files row named by the job payload, runs ffprobe, stores the
 * RAW json + probed_at_ms, extracts typed MediaInfo and replaces the
 * file's media_streams rows (including the 0002 hdr/dv_profile/
 * dv_bl_compat_id/has_atmos/interlaced columns), and derives
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
import { runFfprobe, extractMediaInfo } from "./index.js";
import type { RawProbeResult, MediaInfo, VideoStream, AudioStream, SubtitleStream } from "./index.js";

export interface ProbeDeps {
  db: DbOrTx;
  clock?: () => number;
  /** Test seam — bypasses the real ffprobe spawn (see
   *  test/probe/consumer.spec.ts's fake-ffprobe fixtures, mirroring
   *  test/probe/probe.integration.spec.ts's own convention). Defaults to
   *  the real runFfprobe. */
  runFfprobe?: (filePath: string) => Promise<RawProbeResult>;
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

function toStreamInputs(info: MediaInfo, raw: RawProbeResult): ReplaceStreamInput[] {
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

  await replaceFileStreams(deps.db, file.id, toStreamInputs(info, raw));

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
