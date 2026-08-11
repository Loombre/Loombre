// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/files.ts
//
// media_files / media_streams writers. File identity is content_hash + path
// (D16, §8.2): relinkFile is the rename/move path that keeps the same
// media_files row (and therefore the same item_id, so progress rows for
// that item are untouched by construction — there is nothing here that
// touches catalog_items or progress).

import { sql, type Selectable } from 'kysely';
import type { MediaFilesTable, MediaStreamsTable } from '../types.js';
import type { DbOrTx } from './tx.js';
import { withTransaction } from './tx.js';

export type MediaFileRow = Selectable<MediaFilesTable>;
export type MediaStreamRow = Selectable<MediaStreamsTable>;

export async function findFileByContentHash(
  db: DbOrTx,
  contentHash: string
): Promise<MediaFileRow | undefined> {
  return db
    .selectFrom('media_files')
    .selectAll()
    .where('content_hash', '=', contentHash)
    .executeTakeFirst();
}

export async function findFileByPath(db: DbOrTx, path: string): Promise<MediaFileRow | undefined> {
  return db.selectFrom('media_files').selectAll().where('path', '=', path).executeTakeFirst();
}

/** By primary key — the probe job consumer's entry point (docs/PLAN.md
 * §8.3/P1.5: the 'probe' {mediaFileId} job payload IS the media_files id). */
export async function getMediaFileById(db: DbOrTx, id: string): Promise<MediaFileRow | undefined> {
  return db.selectFrom('media_files').selectAll().where('id', '=', id).executeTakeFirst();
}

/**
 * Re-point an existing media_files row at a new path after a content-hash
 * match (rename/move detection, D16). Deliberately narrow: updates only
 * `path` and clears `missing_since_ms` (the file has been found again) on
 * the SAME row, so item_id — and therefore every progress row keyed on
 * item_id — is untouched. Does not itself emit an event; callers that want
 * a `file.relocated` event write it via writeEvent() in the same
 * transaction as this call.
 */
export async function relinkFile(
  db: DbOrTx,
  fileId: string,
  newPath: string
): Promise<MediaFileRow> {
  return db
    .updateTable('media_files')
    .set({ path: newPath, missing_since_ms: null })
    .where('id', '=', fileId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function markFileMissing(
  db: DbOrTx,
  fileId: string,
  atMs: number
): Promise<void> {
  await db
    .updateTable('media_files')
    .set({ missing_since_ms: atMs })
    .where('id', '=', fileId)
    .where('missing_since_ms', 'is', null)
    .execute();
}

export async function clearFileMissing(db: DbOrTx, fileId: string): Promise<void> {
  await db
    .updateTable('media_files')
    .set({ missing_since_ms: null })
    .where('id', '=', fileId)
    .execute();
}

export interface CreateMediaFileInput {
  itemId: string;
  path: string;
  contentHash: string;
  sizeBytes: number;
  /** Edition ("Director's Cut") or multi-part ("part 1") label — see
   *  migrations/0003_media_files_version_label.sql. Omit/null for the
   *  common one-file-per-item case. */
  versionLabel?: string | null;
  /** Filesystem mtime (stat().mtimeMs, truncated to an integer ms) at
   *  creation time — migrations/0010_media_files_mtime_ms.sql. Omit/null
   *  when the caller has no stat() result on hand (never true for the
   *  scanner's own insert path, but not required for callers like seed
   *  scripts). */
  mtimeMs?: number | null;
}

/**
 * Insert a brand-new media_files row for a file the scanner has not seen
 * before (no path match, no content-hash match — the "new" branch of the
 * scan pipeline, docs/PLAN.md §8.1). Probe fields (container, duration_ms,
 * probe, probed_at_ms) start NULL; the probe job consumer fills them in
 * once it runs.
 */
export async function createMediaFile(db: DbOrTx, input: CreateMediaFileInput): Promise<MediaFileRow> {
  return db
    .insertInto('media_files')
    .values({
      item_id: input.itemId,
      path: input.path,
      content_hash: input.contentHash,
      size_bytes: input.sizeBytes,
      version_label: input.versionLabel ?? null,
      mtime_ms: input.mtimeMs ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Re-encoded-file path (docs/PLAN.md §8.1, "path match, different hash"):
 * the file at this path is a different bitstream than the one this row
 * describes, so its identity (content_hash, size_bytes) is refreshed and
 * every probe-derived field is nulled out — the caller re-enqueues a
 * 'probe' job for the SAME media_files/item row to repopulate them. The
 * row is never deleted-and-readded (D16): item_id, path, and any
 * version_label are untouched.
 *
 * Also refreshes mtime_ms (migrations/0010_media_files_mtime_ms.sql) to the
 * caller's current stat() reading — this is the "content actually changed"
 * branch (triggered either by a size delta, docs/PLAN.md §8.1's original
 * path, or by a same-size in-place edit that the mtime comparison caught,
 * STATE.md P3.10), so the new mtime_ms baseline must land alongside the new
 * hash. Optional (defaults to NULL) so pre-existing callers that don't have
 * a stat() reading on hand keep compiling unchanged; the scanner's own call
 * sites always pass it.
 */
export async function updateMediaFileHash(
  db: DbOrTx,
  fileId: string,
  input: { contentHash: string; sizeBytes: number; mtimeMs?: number | null }
): Promise<MediaFileRow> {
  return db
    .updateTable('media_files')
    .set({
      content_hash: input.contentHash,
      size_bytes: input.sizeBytes,
      mtime_ms: input.mtimeMs ?? null,
      container: null,
      duration_ms: null,
      probe: null,
      probed_at_ms: null,
      missing_since_ms: null,
    })
    .where('id', '=', fileId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Backfill-only path (STATE.md P3.10): size matches and the file re-hashes
 * to the SAME content_hash, so nothing about the file's identity actually
 * changed — only mtime_ms needed to catch up (either a legacy NULL row
 * observed for the first time since migrations/0010 landed, or a mtime
 * bump with no real content change, e.g. a touch/chmod). Deliberately
 * narrow: no probe-field reset, no missing_since_ms touch, no event —
 * this is bookkeeping, not a content change, so it must not re-trigger the
 * 'probe' job or an item.updated event the way updateMediaFileHash's
 * re-encode path does.
 */
export async function updateMediaFileMtime(db: DbOrTx, fileId: string, mtimeMs: number): Promise<MediaFileRow> {
  return db
    .updateTable('media_files')
    .set({ mtime_ms: mtimeMs })
    .where('id', '=', fileId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface SetProbeResultInput {
  probe: Record<string, unknown>;
  probedAtMs: number;
  durationMs: number | null;
  container: string | null;
}

/** Stores the raw ffprobe JSON + derived container/duration_ms (P1.5). */
export async function setMediaFileProbeResult(
  db: DbOrTx,
  fileId: string,
  input: SetProbeResultInput
): Promise<MediaFileRow> {
  return db
    .updateTable('media_files')
    .set({
      probe: input.probe,
      probed_at_ms: input.probedAtMs,
      duration_ms: input.durationMs,
      container: input.container,
    })
    .where('id', '=', fileId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Permanently removes a media_files row (hard-cascade sweep only — see
 *  docs/PLAN.md §8.2 / D16's 72h grace window). Does NOT touch the owning
 *  catalog_items row; see STATE.md's missing-cascade decision note for why
 *  items are left as an empty (files-less) shell rather than deleted. */
export async function deleteMediaFile(db: DbOrTx, fileId: string): Promise<void> {
  await db.deleteFrom('media_files').where('id', '=', fileId).execute();
}

/** Every media_files row belonging to an item in `libraryId`, regardless of
 *  missing state — the full-scan "which files were not seen this pass"
 *  sweep join target (docs/PLAN.md §8.2, P1.2). */
export async function listMediaFilesForLibrary(db: DbOrTx, libraryId: string): Promise<MediaFileRow[]> {
  return db
    .selectFrom('media_files')
    .innerJoin('catalog_items', 'catalog_items.id', 'media_files.item_id')
    .where('catalog_items.library_id', '=', libraryId)
    .selectAll('media_files')
    .execute();
}

/** media_files rows in `libraryId` that have been missing since before
 *  `olderThanMs` — the hard-cascade sweep's candidate set (72h grace
 *  window, D16/P1.2). */
export async function listStaleMissingFiles(
  db: DbOrTx,
  libraryId: string,
  olderThanMs: number
): Promise<MediaFileRow[]> {
  return db
    .selectFrom('media_files')
    .innerJoin('catalog_items', 'catalog_items.id', 'media_files.item_id')
    .where('catalog_items.library_id', '=', libraryId)
    .where('media_files.missing_since_ms', 'is not', null)
    .where('media_files.missing_since_ms', '<', olderThanMs)
    .selectAll('media_files')
    .execute();
}

// ============================================================================
// Data-freedom import addition (apps/worker/src/import — deliverable E).
// ============================================================================

export interface InsertMediaFilePlaceholderInput {
  /** Omit to let the DB DEFAULT loombre_uuidv7() mint a fresh id (import's
   *  merge-mode "create new" branch, which never preserves archive ids —
   *  see the import consumer's module header); supply the archive's own
   *  media_files id for the empty-target ID-preservation restore path. */
  id?: string;
  itemId: string;
  /**
   * Synthesized, never a real filesystem path — packages/contract/
   * openapi.yaml's MediaFileSummary (the only media_files representation
   * ExportArchive carries) has no `path`/`content_hash` field at all (an
   * archive contract gap; see the import consumer's module header), so
   * there is no real path to restore. `path` is still TEXT NOT NULL UNIQUE
   * (migrations/0001_init.sql) and must never collide with a real scanned
   * path — the caller is responsible for a scheme (e.g. an opaque
   * `loombre-import-placeholder://<mediaFileId>` URI) that can never be
   * produced by the scanner's own path resolution.
   */
  placeholderPath: string;
  container: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  versionLabel: string | null;
  /** Always set at insert time (P1.2's missing-file state, entered
   *  immediately rather than waiting for a scan to notice) — see the
   *  import consumer's module header for why this is correct, not a
   *  workaround. */
  missingSinceMs: number;
}

/**
 * Id-preserving media_files insert for an item whose real file the
 * exporting machine reported but whose bytes/path/hash the archive cannot
 * carry (see InsertMediaFilePlaceholderInput's doc comment). `content_hash`,
 * `probe`, `probed_at_ms`, and `mtime_ms` are always NULL — there is no
 * archive data to populate them from, and a NULL content_hash correctly
 * makes this row invisible to findFileByContentHash's rename/relink
 * matching (P1.1), so a later real scan creates a fresh, independent
 * media_files row for the real file rather than misappropriating this one
 * — see the import consumer's module header for the full self-heal story.
 */
export async function insertMediaFilePlaceholderForImport(
  db: DbOrTx,
  input: InsertMediaFilePlaceholderInput
): Promise<MediaFileRow> {
  return db
    .insertInto('media_files')
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      item_id: input.itemId,
      path: input.placeholderPath,
      content_hash: null,
      size_bytes: input.sizeBytes,
      container: input.container,
      duration_ms: input.durationMs,
      probe: null,
      probed_at_ms: null,
      missing_since_ms: input.missingSinceMs,
      version_label: input.versionLabel,
      mtime_ms: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface ReplaceStreamInput {
  streamIndex: number;
  streamType: MediaStreamsTable['stream_type'];
  codec?: string | null;
  profile?: string | null;
  level?: string | null;
  width?: number | null;
  height?: number | null;
  bitDepth?: number | null;
  colorTransfer?: string | null;
  channels?: number | null;
  sampleRate?: number | null;
  bitrateBps?: number | null;
  frameRate?: number | null;
  language?: string | null;
  isDefault?: boolean;
  isForced?: boolean;
  hdr?: MediaStreamsTable['hdr'];
  dvProfile?: number | null;
  dvBlCompatId?: number | null;
  hasAtmos?: boolean | null;
  interlaced?: boolean | null;
  /** migrations/0038_media_streams_open_gop.sql — video-only, HEVC-only in
   *  v1. Omitted/undefined (every non-video-stream caller, and any video
   *  caller that hasn't run the detector) writes NULL ("not yet probed"),
   *  never a guessed value. */
  openGop?: boolean | null;
}

/**
 * Atomically replace every media_streams row for `fileId` with `streams`
 * (delete-then-insert in one transaction) — re-probing a file always
 * supersedes its prior stream list wholesale rather than trying to diff
 * individual streams by index.
 */
export async function replaceFileStreams(
  db: DbOrTx,
  fileId: string,
  streams: ReplaceStreamInput[]
): Promise<MediaStreamRow[]> {
  return withTransaction(db, async (trx) => {
    await trx.deleteFrom('media_streams').where('file_id', '=', fileId).execute();

    if (streams.length === 0) {
      return [];
    }

    return trx
      .insertInto('media_streams')
      .values(
        streams.map((s) => ({
          file_id: fileId,
          stream_index: s.streamIndex,
          stream_type: s.streamType,
          codec: s.codec ?? null,
          profile: s.profile ?? null,
          level: s.level ?? null,
          width: s.width ?? null,
          height: s.height ?? null,
          bit_depth: s.bitDepth ?? null,
          color_transfer: s.colorTransfer ?? null,
          channels: s.channels ?? null,
          sample_rate: s.sampleRate ?? null,
          bitrate_bps: s.bitrateBps ?? null,
          frame_rate: s.frameRate ?? null,
          language: s.language ?? null,
          ...(s.isDefault !== undefined ? { is_default: s.isDefault } : {}),
          ...(s.isForced !== undefined ? { is_forced: s.isForced } : {}),
          hdr: s.hdr ?? null,
          dv_profile: s.dvProfile ?? null,
          dv_bl_compat_id: s.dvBlCompatId ?? null,
          has_atmos: s.hasAtmos ?? null,
          interlaced: s.interlaced ?? null,
          open_gop: s.openGop ?? null,
        }))
      )
      .returningAll()
      .execute();
  });
}

// ============================================================================
// open_gop backfill (migrations/0038_media_streams_open_gop.sql) — worker-
// only queries backing apps/worker/src/probe/opengop-backfill-consumer.ts.
// Existing libraries were probed before this column existed, so every
// pre-existing media_streams row (video AND non-video) has open_gop = NULL.
// Only HEVC video rows need the real bounded ffmpeg scan; every other
// NULL video row can be bulk-set false in one statement (the engine never
// consults this field for non-hevc codecs — same "false, no scan needed"
// rule the live probe path applies at write time, see toStreamInputs in
// apps/worker/src/probe/consumer.ts). Non-video rows (audio/subtitle) are
// left NULL forever, same as the hdr/dv_profile/interlaced columns this
// mirrors (migrations/0002_phase1_catalog.sql) — open_gop is video-only by
// definition and this backfill never touches them.
// ============================================================================

export interface HevcStreamNeedingOpenGopProbeRow {
  id: string;
  file_id: string;
  file_path: string;
  /** Always 'hevc' (the query's own WHERE clause guarantees it) — selected
   *  explicitly rather than assumed so this row is self-describing for
   *  detectOpenGop's codec-guard parameter (opus review finding 11,
   *  apps/worker/src/probe/opengop.ts), the same defense-in-depth reasoning
   *  as passing the stream's own codec at the live-probe call site
   *  (./consumer.ts's resolveOpenGopByIndex) rather than hardcoding it. */
  codec: string;
  /** 0-based position of this stream among ITS FILE's video streams only
   *  (ffmpeg's own `-map 0:v:N` addressing) — NOT media_streams.stream_index,
   *  which is the raw ffprobe absolute index across every stream. Computed
   *  as "how many video streams in this file have stream_index <= mine,
   *  minus one" so a file with more than one video stream still maps each
   *  row to the ffmpeg map index the detector needs. */
  video_type_index: number;
  /** media_files.duration_ms for this row's file — threaded straight
   *  through to detectOpenGop's own `durationMs` parameter (opus review
   *  finding 1's mid-file-vs-from-start scan-window choice). NULL means
   *  "not yet probed" or ffprobe reported no format.duration — opengop.ts
   *  treats NULL as "unknown", never as zero. */
  duration_ms: number | null;
}

/**
 * Boot-time "is there anything left for the backfill to do" check
 * (apps/worker/src/index.ts's enqueueOpenGopBackfillIfNeeded, mirroring
 * enqueueImageBackfillIfNeeded's own listImagesNeedingDominantColor
 * limit-1 pending check). Covers BOTH halves of the backfill in one cheap
 * query: a HEVC row still needing the real scan, OR a non-HEVC row still
 * needing the one-shot bulk-false UPDATE — either case means open_gop IS
 * NULL on a video row, so a plain existence check suffices without
 * distinguishing which half would resolve it.
 *
 * Excludes rows whose file is currently missing (opus review finding 10):
 * a deleted/unmounted file's media_streams row stays open_gop NULL
 * forever (nothing will ever scan it), which without this exclusion would
 * make this check — and therefore the boot-time backfill enqueue — fire on
 * EVERY worker start for as long as that row exists, not just once. A
 * present-but-unscannable file (corrupt container, scan failure/timeout)
 * is NOT excluded by this join and WILL still re-trigger a sweep on every
 * boot — see opengop-backfill-consumer.ts's module header for why that
 * residual is accepted as bounded/rare rather than also special-cased
 * here.
 */
export async function hasVideoStreamsNeedingOpenGopBackfill(db: DbOrTx): Promise<boolean> {
  const row = await db
    .selectFrom('media_streams')
    .innerJoin('media_files', 'media_files.id', 'media_streams.file_id')
    .select('media_streams.id')
    .where('media_streams.stream_type', '=', 'video')
    .where('media_streams.open_gop', 'is', null)
    .where('media_files.missing_since_ms', 'is', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Id-ordered, cursor-paginated batch of HEVC video streams still missing an
 * open_gop verdict (NULL — never a real boolean, which is a resolved verdict
 * and must never be re-selected). `afterId` is the last-processed
 * media_streams id from the previous batch (null for the first page).
 *
 * Excludes rows whose file is currently missing (opus review finding 10 —
 * see hasVideoStreamsNeedingOpenGopBackfill's doc comment for the full
 * rationale, which applies identically here: without this, a deleted/
 * unmounted file's row would be selected — and its real detectOpenGop scan
 * attempted against a path that no longer resolves — on every sweep
 * forever, not just once).
 */
export async function listHevcStreamsNeedingOpenGopProbe(
  db: DbOrTx,
  opts: { afterId: string | null; limit: number }
): Promise<HevcStreamNeedingOpenGopProbeRow[]> {
  const result = await sql<{
    id: string;
    file_id: string;
    file_path: string;
    codec: string;
    video_type_index: number;
    duration_ms: number | null;
  }>`
    SELECT
      ms.id AS id,
      ms.file_id AS file_id,
      mf.path AS file_path,
      ms.codec AS codec,
      (
        SELECT count(*)::int
        FROM media_streams ms2
        WHERE ms2.file_id = ms.file_id
          AND ms2.stream_type = 'video'
          AND ms2.stream_index <= ms.stream_index
      ) - 1 AS video_type_index,
      mf.duration_ms AS duration_ms
    FROM media_streams ms
    INNER JOIN media_files mf ON mf.id = ms.file_id
    WHERE ms.stream_type = 'video'
      AND ms.codec = 'hevc'
      AND ms.open_gop IS NULL
      AND mf.missing_since_ms IS NULL
      ${opts.afterId !== null ? sql`AND ms.id > ${opts.afterId}` : sql``}
    ORDER BY ms.id ASC
    LIMIT ${opts.limit}
  `.execute(db);
  return result.rows;
}

/** Writes the detector's resolved verdict (never NULL — a failed/timed-out
 *  scan simply skips this call, leaving the row NULL for the next sweep to
 *  retry, see opengop-backfill-consumer.ts's module header). */
export async function setStreamOpenGop(db: DbOrTx, streamId: string, openGop: boolean): Promise<void> {
  await db.updateTable('media_streams').set({ open_gop: openGop }).where('id', '=', streamId).execute();
}

/**
 * One bulk UPDATE for every non-HEVC video stream still missing an
 * open_gop verdict — no scan needed (the engine only ever consults this
 * field for hevc). Returns the number of rows updated — opus review
 * finding 15c: opengop-backfill-consumer.ts's fresh-sweep branch logs this
 * count, so it is an actual observability signal, not a value nothing
 * reads.
 * The backfill consumer calls this exactly once per fresh sweep (cursor
 * === null), not on every batch — an indexed-free WHERE over the whole
 * media_streams table is cheap once, not worth repeating on every
 * resumed batch.
 */
export async function bulkSetNonHevcVideoOpenGopFalse(db: DbOrTx): Promise<number> {
  const result = await db
    .updateTable('media_streams')
    .set({ open_gop: false })
    .where('stream_type', '=', 'video')
    .where('open_gop', 'is', null)
    .where((eb) => eb.or([eb('codec', '!=', 'hevc'), eb('codec', 'is', null)]))
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}
