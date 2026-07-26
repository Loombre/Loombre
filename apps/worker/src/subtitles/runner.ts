// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Segmented-VTT subtitle side-track extraction runtime (docs/PLAYBACK.md
 * §9, STATE.md P3.9(e), Phase 3 §11 step 6b — packages/jobs/src/types.ts's
 * `SubtitleExtractJobPayload` header has the enqueue-side contract this
 * implements the worker half of). One job = one `playback_sessions` row,
 * exactly like ../transcode/runner.ts's `runTranscodeSession` — every fact
 * this needs (file path, the stored plan's `subtitle.streamIndex`) is read
 * fresh from the row/its joins, never duplicated into the job payload.
 *
 * Deliberately reuses ../transcode's OWN staging/process primitives rather
 * than re-implementing guarded directory creation or ffmpeg spawn/stderr
 * handling: `createSessionDir` (../transcode/staging.ts) resolves the SAME
 * deterministic `<stagingRoot>/<sessionId>` path the transcode runtime
 * would use for this same session, and `spawnFfmpegRun` (../transcode/
 * process.ts) is a plain "spawn one child process, wait for it, capture a
 * stderr tail" primitive with no throttle/suspend concerns this one-shot
 * job needs. Neither call mutates or extends the transcode runtime itself —
 * this module only ever calls its exported functions (this step's "consume
 * the seam, do not touch worker transcode runtime internals" boundary).
 *
 * ---------------------------------------------------------------------------
 * EXTERNAL-SIDECAR HONESTY CHECK (task instruction, reported prominently —
 * NOT faked): packages/db/src/query/media-info.ts's own header documents
 * that `media_streams` has no `is_external`/`external_path` columns at all —
 * the scanner never resolves sidecar subtitle files (NFO/sidecar reading is
 * scanner-only per CLAUDE.md invariant 8, and external-subtitle resolution
 * specifically was never part of Phase 1's probe pipeline). Both
 * `getMediaInfoAssembly` (guarded) and `getMediaInfoForFile` (this
 * package's internal twin, used below) therefore ALWAYS return
 * `isExternal: false, externalPath: null` for every subtitle stream —
 * an external sidecar can never structurally reach this consumer today.
 * This module implements ONLY the embedded-subtitle extraction path
 * (`-map 0:s:{typeRelativeIndex}`); an `isExternal` stream (which the TYPE
 * technically still allows, even though no real row can ever produce one)
 * fails loudly here rather than being silently ignored or faked. Logged as
 * an Open item for the audit wave, exactly as this step's instructions
 * require — external-sidecar ingestion into this job is NOT implemented.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbOrTx } from "@loombre/db/internal";
import {
  ensureSessionStagingDir,
  getMediaFileById,
  getMediaInfoForFile,
  getTranscodeSessionRow,
} from "@loombre/db/internal";
import { nowMs as clockNowMs } from "@loombre/shared";
import { resolveFfmpeg } from "../probe/ffprobe.js";
import { spawnFfmpegRun, type SpawnFn } from "../transcode/process.js";
import { createSessionDir } from "../transcode/staging.js";
import { resolveTranscodeStagingRoot } from "../transcode/config.js";
import { parseStoredPlan } from "../transcode/plan-shape.js";
import { renderSubtitlePlaylist } from "./playlist.js";

export class SubtitleExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtitleExtractionError";
  }
}

export interface RunSubtitleExtractionDeps {
  db: DbOrTx;
  /** Overrides ffmpeg resolution (tests). Defaults to resolveFfmpeg(). */
  ffmpegPath?: string;
  stagingRoot?: string;
  /** Injected process spawn (tests substitute a fake child process — see
   *  ../transcode/process.ts's own header). */
  spawnFn?: SpawnFn;
  now?: () => number;
}

/** Converts an ABSOLUTE stream index to its TYPE-RELATIVE position within
 *  `streams` (already the same-kind — subtitle-only — array): sort by
 *  `.index`, find the selected stream's position. `-map 0:s:{n}` takes a
 *  TYPE-RELATIVE `n`, exactly the same correctness trap
 *  @loombre/playback-engine's `args/builder.ts` documents for video/audio —
 *  replicated locally rather than imported since the engine does not
 *  export that helper (it is not part of its public API). */
function typeRelativeIndex(streams: readonly { index: number }[], selectedIndex: number): number {
  const sorted = [...streams].sort((a, b) => a.index - b.index);
  const pos = sorted.findIndex((s) => s.index === selectedIndex);
  return pos === -1 ? 0 : pos;
}

const VTT_SEGMENT_FILENAME = "sub0.vtt";

/**
 * Extracts the session's SELECTED subtitle stream (per the stored plan's
 * `subtitle.streamIndex`) to `<sessionDir>/subs/sub0.vtt` and writes a
 * single-segment HLS subtitle media playlist at
 * `<sessionDir>/subs/media.m3u8` (target duration = the file's own full
 * duration, docs/PLAYBACK.md §9/P3.9(e) — see ./playlist.ts). A no-op when
 * the session no longer exists, is already terminal, or its stored plan's
 * subtitle strategy isn't `'hls-vtt'` (defensive — the enqueue site, Lane B,
 * only ever enqueues this job when it is).
 */
export async function runSubtitleExtraction(deps: RunSubtitleExtractionDeps, sessionId: string): Promise<void> {
  const db = deps.db;
  const now = deps.now ?? clockNowMs;
  const stagingRoot = deps.stagingRoot ?? resolveTranscodeStagingRoot();

  const sessionRow = await getTranscodeSessionRow(db, sessionId);
  if (!sessionRow) return; // Row vanished before the job ran.
  if (sessionRow.status === "ended" || sessionRow.status === "failed") return; // Already closed out.

  const plan = parseStoredPlan(sessionRow.plan);
  if (plan.subtitle.strategy !== "hls-vtt" || plan.subtitle.streamIndex === undefined) {
    return;
  }

  if (!sessionRow.file_id) {
    throw new SubtitleExtractionError(`subtitle-extract: session ${sessionId} has no file_id`);
  }
  const file = await getMediaFileById(db, sessionRow.file_id);
  if (!file) {
    throw new SubtitleExtractionError(`subtitle-extract: media file ${sessionRow.file_id} not found`);
  }
  const media = await getMediaInfoForFile(db, sessionRow.file_id);
  if (!media) {
    throw new SubtitleExtractionError(`subtitle-extract: media info for file ${sessionRow.file_id} is unavailable`);
  }

  const subtitleStream = media.subtitle.find((s) => s.index === plan.subtitle.streamIndex);
  if (!subtitleStream) {
    throw new SubtitleExtractionError(
      `subtitle-extract: selected subtitle stream index ${plan.subtitle.streamIndex} not found on file ${sessionRow.file_id}`,
    );
  }
  // Module header's honesty check — see there for why this is structurally
  // unreachable today, and why it is guarded rather than silently ignored.
  if (subtitleStream.isExternal) {
    throw new SubtitleExtractionError(
      "subtitle-extract: external sidecar subtitle extraction is not implemented (no scanner path populates " +
        "media_streams.is_external — see packages/db/src/query/media-info.ts's header). Logged as an Open item.",
    );
  }

  let ffmpegPath = deps.ffmpegPath;
  if (!ffmpegPath) {
    const resolved = resolveFfmpeg();
    if (!resolved.ok) {
      throw new SubtitleExtractionError(`subtitle-extract: ffmpeg could not be resolved: ${resolved.error.message}`);
    }
    ffmpegPath = resolved.binary.path;
  }

  // Deterministic per-session directory, shared with (and independent of)
  // the 'transcode' job's own staging_dir — see ensureSessionStagingDir's
  // header for why this is always safe, never a clobber.
  const sessionDir = await createSessionDir(stagingRoot, sessionId);
  await ensureSessionStagingDir(db, sessionId, sessionDir, now());

  const subsDir = join(sessionDir, "subs");
  await mkdir(subsDir, { recursive: true });

  const typeRelative = typeRelativeIndex(media.subtitle, subtitleStream.index);
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-i",
    file.path,
    "-map",
    `0:s:${typeRelative}`,
    "-c:s",
    "webvtt",
    VTT_SEGMENT_FILENAME,
  ];

  const handle = spawnFfmpegRun(ffmpegPath, args, {
    cwd: subsDir,
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
  });
  const result = await handle.result;
  if (result.exitCode !== 0) {
    throw new SubtitleExtractionError(
      `subtitle-extract: ffmpeg exited ${String(result.exitCode)} for session ${sessionId}: ${result.stderrTail}`,
    );
  }

  const durationSec = media.durationMs / 1000;
  await writeFile(join(subsDir, "media.m3u8"), renderSubtitlePlaylist(durationSec, VTT_SEGMENT_FILENAME), "utf8");
}
