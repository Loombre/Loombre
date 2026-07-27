// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The 'scan' job handler (docs/PLAN.md §8.1/§8.2, deliverable A). Walks a
 * library's paths (./walk.ts, deterministic + streamed), resolves each
 * media file's identity (./identity/*, D16/P1.1: path match, content-hash
 * match, or genuinely new), finds-or-creates the catalog hierarchy
 * (./hierarchy.ts), and checkpoints progress every 50 files (P1.12) so a
 * crashed/retried job resumes instead of rescanning from scratch.
 *
 * Every event write (scan.started/scan.completed/file.relocated/
 * item.added/item.updated) happens in the SAME transaction as the state
 * change it describes (docs/PLAN.md §4.3's outbox rule) — see the
 * `withTransaction` call sites below.
 */
import { stat as fsStat, access as fsAccess } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  findFileByPath,
  findFileByContentHash,
  relinkFile,
  markFileMissing,
  clearFileMissing,
  createMediaFile,
  updateMediaFileHash,
  updateMediaFileMtime,
  deleteMediaFile,
  listMediaFilesForLibrary,
  listStaleMissingFiles,
  getLibraryById,
  writeCheckpoint,
  getCheckpoint,
  writeEvent,
  withTransaction,
  type DbOrTx,
  type CatalogItemRow,
} from "@loombre/db/internal";
import { classifyAuxiliary, parseMoviePath, parseTvPath, parseMusicPath } from "./parse/index.js";
import { extensionOf, isMediaExtensionForKind } from "./media-kind.js";
import { walkLibraryPaths } from "./walk.js";
import { resolveMovieItem, resolveEpisodeItem, resolveTrackItem } from "./hierarchy.js";
import { readTagsWithMusicMetadata, type TagReader } from "./music-tags.js";
import type { ProbeJobPayload, ImageJobPayload, MetadataJobPayload } from "@loombre/jobs";

const CHECKPOINT_INTERVAL_FILES = 50;
/** Registry default for scanner.missingFileGraceHours (packages/shared/
 *  src/settings-registry.ts) — 72h, D16/P1.2. Used when `deps.
 *  missingFileGraceHours` is omitted (e.g. a direct test call to
 *  runScan()); the real production call site (apps/worker/src/index.ts's
 *  'scan' job handler) resolves the effective value fresh at the START of
 *  every scan job (the natural boundary: mid-job is naturally safe too —
 *  see this lane's report — but "next scan job" is the simplest honest
 *  guarantee and matches every other worker-side boundary choice). */
const DEFAULT_MISSING_FILE_GRACE_HOURS = 72;

/** The exact transaction-handle type withTransaction()'s callback receives,
 * extracted structurally from withTransaction's own type signature — this
 * lets emitItemAdded/emitItemUpdated below declare an accurate parameter
 * type without ever importing kysely's `Transaction` directly (banned
 * outside packages/db by dependency-cruiser; @loombre/db/internal is the
 * only door, same pattern as everywhere else in this file). */
type Trx = Parameters<Parameters<typeof withTransaction>[1]>[0];

export interface HashPoolLike {
  hashFile(filePath: string, sizeBytes: number): Promise<string>;
}

export interface QueueLike {
  enqueue(type: "probe", payload: ProbeJobPayload): Promise<string>;
  enqueue(type: "image", payload: ImageJobPayload): Promise<string>;
  enqueue(type: "metadata", payload: MetadataJobPayload): Promise<string>;
}

/** Catalog item types the metadata consumer actually enriches
 * (metadata/consumer.ts's SUPPORTED_ITEM_TYPES). Enqueuing a metadata job
 * for a season/episode/track would just no-op in the consumer, so the
 * scanner only enqueues for these — the one place scan→metadata is wired
 * (the provider pipeline is otherwise unreachable). */
const METADATA_ENRICHABLE_TYPES = new Set(["movie", "series", "artist", "album"]);

/** Map the library's media_kind to the metadata job's mediaKind (they share
 * @loombre/shared's MediaKind values). */
function mediaKindForLibrary(kind: "movie" | "tv" | "music"): MetadataJobPayload["mediaKind"] {
  return kind;
}

export interface ScanDeps {
  db: DbOrTx;
  queue: QueueLike;
  hashPool: HashPoolLike;
  tagReader?: TagReader;
  /** Defaults to Date.now — injectable for deterministic tests. */
  clock?: () => number;
  /** scanner.missingFileGraceHours (Addendum A registry) — hours a
   *  missing-on-disk file may stay before its row is hard-cascaded. Defaults
   *  to DEFAULT_MISSING_FILE_GRACE_HOURS (72) when omitted. The real
   *  production caller (apps/worker/src/index.ts) resolves this fresh at
   *  scan-job start via the worker-side effective-settings reader. */
  missingFileGraceHours?: number;
}

export interface RunScanParams {
  libraryId: string;
  full: boolean;
}

export interface RunScanMeta {
  jobId: string;
}

interface ScanCounters {
  itemsAdded: number;
  itemsUpdated: number;
  itemsRemoved: number;
}

const ARTWORK_CANDIDATES: Array<{ names: string[]; kind: string }> = [
  { names: ["poster.jpg", "poster.png", "poster.jpeg"], kind: "poster" },
  { names: ["folder.jpg", "folder.png", "folder.jpeg"], kind: "poster" },
  { names: ["cover.jpg", "cover.png", "cover.jpeg"], kind: "poster" },
  { names: ["fanart.jpg", "fanart.png", "fanart.jpeg"], kind: "backdrop" },
];

/** Best-effort local-artwork discovery (docs/PLAN.md §8.1: "Local artwork
 * ... adjacent, cover art -> enqueue 'image' jobs with source paths").
 * Looks only in the media file's own directory for a small closed set of
 * conventional filenames — a deliberately light v1 (the image PIPELINE
 * itself, i.e. how these jobs get turned into pre-scaled variants, is
 * another agent's surface per the task brief; this is only discovery +
 * enqueue). Never throws — a stat failure just means "not found". */
async function findLocalArtwork(dirAbsPath: string): Promise<Array<{ kind: string; absPath: string }>> {
  const found: Array<{ kind: string; absPath: string }> = [];
  for (const candidate of ARTWORK_CANDIDATES) {
    for (const name of candidate.names) {
      const candidatePath = join(dirAbsPath, name);
      try {
        await fsAccess(candidatePath);
        found.push({ kind: candidate.kind, absPath: candidatePath });
      } catch {
        // not present — expected for most candidates, not an error
      }
    }
  }
  return found;
}

async function enqueueArtworkJobs(deps: ScanDeps, itemId: string, dirAbsPath: string): Promise<void> {
  const artwork = await findLocalArtwork(dirAbsPath);
  for (const art of artwork) {
    await deps.queue.enqueue("image", {
      // 'catalog_item' is the canonical ImageEntityType (packages/db/src/
      // query/images.ts) the image consumer resolves against — an
      // unrecognized value is a silent green no-op, not a failure.
      entityType: "catalog_item",
      entityId: itemId,
      kind: art.kind,
      sourcePath: art.absPath,
    });
  }
}

async function emitItemAdded(trx: Trx, now: number, item: CatalogItemRow): Promise<void> {
  await writeEvent(trx, {
    type: "item.added",
    tsMs: now,
    actorUserId: null,
    payload: {
      itemId: item.id,
      libraryId: item.library_id,
      itemType: item.item_type,
      contentClass: item.content_class,
      parentId: item.parent_id,
      addedAtMs: now,
    },
  });
}

async function emitItemUpdated(
  trx: Trx,
  now: number,
  item: CatalogItemRow,
  changedFields: string[]
): Promise<void> {
  await writeEvent(trx, {
    type: "item.updated",
    tsMs: now,
    actorUserId: null,
    payload: {
      itemId: item.id,
      libraryId: item.library_id,
      itemType: item.item_type,
      contentClass: item.content_class,
      changedFields,
      updatedAtMs: now,
    },
  });
}

interface NewFileResolution {
  leafItem: CatalogItemRow;
  leafIsNew: boolean;
  newlyCreated: CatalogItemRow[];
  versionLabel: string | null;
}

/** Media-kind-specific parse + find-or-create dispatch for the "genuinely
 * new file" branch (docs/PLAN.md §8.1 step 3). Returns null when the file
 * cannot be parsed/placed at all (unparseable filename, or a music file
 * whose tags and filename TOGETHER yield no artist/title) — the caller
 * skips the file rather than guessing. */
async function resolveNewFile(
  trx: DbOrTx,
  mediaKind: "movie" | "tv" | "music",
  libraryId: string,
  relPath: string,
  absPath: string,
  now: number,
  tagReader: TagReader
): Promise<NewFileResolution | null> {
  if (mediaKind === "movie") {
    const guess = parseMoviePath(relPath);
    if (!guess) return null;
    const resolved = await resolveMovieItem(trx, {
      libraryId,
      title: guess.title,
      year: guess.year,
      nowMs: now,
    });
    const versionLabel = guess.edition ?? (guess.partNumber !== null ? `part ${guess.partNumber}` : null);
    return {
      leafItem: resolved.item,
      leafIsNew: resolved.isNew,
      newlyCreated: resolved.isNew ? [resolved.item] : [],
      versionLabel,
    };
  }

  if (mediaKind === "tv") {
    const guess = parseTvPath(relPath);
    if (!guess) return null;
    // A file with no episode number of any kind (not even absolute) cannot
    // be placed in the series->season->episode hierarchy — skipped rather
    // than guessed (documented decision).
    const episodeNumber = guess.episodeNumbers[0] ?? guess.absoluteNumbers?.[0] ?? null;
    if (episodeNumber === null) return null;
    // Absolute-numbered (anime) files with no season component at all
    // default to season 1 (documented decision — see hierarchy.ts's
    // module docstring for why a season layer always exists).
    const seasonNumber = guess.seasonNumber ?? (guess.isSpecial ? 0 : 1);

    const resolved = await resolveEpisodeItem(trx, {
      libraryId,
      seriesTitle: guess.seriesTitle,
      seasonNumber,
      episodeNumber,
      episodeTitle: guess.episodeTitle,
      nowMs: now,
    });
    const newlyCreated = [resolved.series, resolved.season, resolved.episode]
      .filter((r) => r.isNew)
      .map((r) => r.item);
    return {
      leafItem: resolved.episode.item,
      leafIsNew: resolved.episode.isNew,
      newlyCreated,
      versionLabel: null,
    };
  }

  // music: tag-first (P1.4) — precedence is PER FIELD (docs/PLAN.md §8.3),
  // not per source: every field a tag leaves null falls back to the
  // filename parse. Partially-tagged files (a compilation rip carrying only
  // an album, say) are the common case, and parseMusicPath is pure
  // synchronous string work, so it is computed unconditionally.
  const tags = await tagReader(absPath).catch(() => null);
  const fallback = parseMusicPath(relPath);
  if (!tags && !fallback) return null;

  const artistName = tags?.artist ?? fallback?.artist ?? null;
  if (!artistName) return null; // neither source yields an identity — skip

  const title = tags?.title ?? fallback?.title ?? null;
  if (!title) return null;

  const resolved = await resolveTrackItem(trx, {
    libraryId,
    artistName,
    albumTitle: tags?.album ?? fallback?.album ?? null,
    albumYear: null,
    trackNumber: tags?.trackNumber ?? fallback?.trackNumber ?? null,
    discNumber: tags?.discNumber ?? fallback?.discNumber ?? null,
    title,
    nowMs: now,
  });
  const newlyCreated = [resolved.artist, resolved.album, resolved.track]
    .filter((r) => r.isNew)
    .map((r) => r.item);
  return {
    leafItem: resolved.track.item,
    leafIsNew: resolved.track.isNew,
    newlyCreated,
    versionLabel: null,
  };
}

/**
 * Every CHECKPOINT_INTERVAL_FILES (50), ALSO emits a live `job.updated`
 * event carrying progress (Phosphor retheme Wave 2, Lane L2 — the admin
 * dashboard's live scan percentage bar). `progress.total` is honestly
 * `null` (U9, never fabricated): walkLibraryPaths is a streaming,
 * single-pass generator with no upfront file count — a determinate
 * percentage would require either buffering the whole tree first (defeats
 * the streaming design, docs/PLAN.md §8.1) or a second full filesystem
 * walk purely to count. The dashboard renders an indeterminate,
 * compositor-animated bar plus this live `current` count instead — logged
 * as a deliberate scope deviation from a literal "percentage", not an
 * oversight. Same transaction as the checkpoint write (the outbox rule,
 * docs/PLAN.md §4.3) — both are bookkeeping about THIS periodic tick, never
 * worth two round trips.
 */
async function maybeCheckpoint(
  deps: ScanDeps,
  meta: RunScanMeta,
  libraryId: string,
  lastProcessedPath: string,
  filesSeen: number,
  filesProcessed: number,
  now: number
): Promise<void> {
  if (filesSeen % CHECKPOINT_INTERVAL_FILES !== 0) return;
  await withTransaction(deps.db, async (trx) => {
    await writeCheckpoint(trx, {
      jobId: meta.jobId,
      libraryId,
      phase: "scanning",
      lastProcessedPath,
      filesSeen,
      filesProcessed,
      updatedAtMs: now,
    });
    await writeEvent(trx, {
      type: "job.updated",
      tsMs: now,
      actorUserId: null,
      payload: {
        jobId: meta.jobId,
        jobType: "scan",
        status: "active",
        progress: { current: filesProcessed, total: null, phase: "scanning" },
        errorMessage: null,
        updatedAtMs: now,
      },
    });
  });
}

export async function runScan(deps: ScanDeps, params: RunScanParams, meta: RunScanMeta): Promise<void> {
  const clock = deps.clock ?? Date.now;
  const tagReader = deps.tagReader ?? readTagsWithMusicMetadata;
  const startedAtMs = clock();

  const library = await getLibraryById(deps.db, params.libraryId);
  if (!library) {
    throw new Error(`scan: library ${params.libraryId} does not exist`);
  }

  await withTransaction(deps.db, async (trx) => {
    await writeEvent(trx, {
      type: "scan.started",
      tsMs: startedAtMs,
      actorUserId: null,
      payload: { jobId: meta.jobId, libraryId: params.libraryId, full: params.full, startedAtMs },
    });
  });

  const counters: ScanCounters = { itemsAdded: 0, itemsUpdated: 0, itemsRemoved: 0 };
  let firstError: string | null = null;

  try {
    const checkpoint = await getCheckpoint(deps.db, meta.jobId);
    let resuming = checkpoint?.last_processed_path != null;
    // filesSeen is THIS run's own walk-position counter, always starting
    // fresh at 0 — the walk itself always covers the whole tree on every
    // run (only per-file WORK is skipped while resuming), so re-seeding it
    // from a prior attempt's checkpoint would double-count. filesProcessed
    // DOES carry over: it counts real work done, and files skipped this
    // run because they were already processed in a prior attempt still
    // count as processed.
    let filesSeen = 0;
    let filesProcessed = checkpoint?.files_processed ?? 0;
    const seenAbsPaths = new Set<string>();
    let lastAbsPath: string | null = checkpoint?.last_processed_path ?? null;

    for await (const walked of walkLibraryPaths(library.paths)) {
      filesSeen++;
      lastAbsPath = walked.absPath;

      if (resuming) {
        seenAbsPaths.add(walked.absPath);
        if (walked.absPath === checkpoint!.last_processed_path) {
          resuming = false;
        }
        await maybeCheckpoint(deps, meta, params.libraryId, walked.absPath, filesSeen, filesProcessed, clock());
        continue;
      }

      try {
        const processed = await processOneFile(deps, library, params, walked, tagReader, counters, clock);
        if (processed) {
          seenAbsPaths.add(walked.absPath);
          filesProcessed++;
        }
      } catch (err) {
        firstError ??= err instanceof Error ? err.message : String(err);
      }

      await maybeCheckpoint(deps, meta, params.libraryId, walked.absPath, filesSeen, filesProcessed, clock());
    }

    // Final checkpoint at walk completion, independent of the every-50
    // periodic cadence (maybeCheckpoint) — without this, a scan with fewer
    // files than CHECKPOINT_INTERVAL_FILES between the last periodic write
    // and the end would leave scan_checkpoints stale, understating real
    // progress for anything (an admin UI, a resumed retry) that reads it
    // back afterwards. Idempotent/harmless if a periodic checkpoint already
    // covered the exact same last file.
    await writeCheckpoint(deps.db, {
      jobId: meta.jobId,
      libraryId: params.libraryId,
      phase: "completed",
      lastProcessedPath: lastAbsPath,
      filesSeen,
      filesProcessed,
      updatedAtMs: clock(),
    });

    if (params.full) {
      const allFiles = await listMediaFilesForLibrary(deps.db, params.libraryId);
      for (const file of allFiles) {
        if (!seenAbsPaths.has(file.path) && file.missing_since_ms === null) {
          await markFileMissing(deps.db, file.id, clock());
          counters.itemsRemoved++;
        }
      }

      const graceMs = (deps.missingFileGraceHours ?? DEFAULT_MISSING_FILE_GRACE_HOURS) * 60 * 60 * 1000;
      const cutoff = clock() - graceMs;
      const stale = await listStaleMissingFiles(deps.db, params.libraryId, cutoff);
      for (const file of stale) {
        await deleteMediaFile(deps.db, file.id);
      }
    }

    const completedAtMs = clock();
    await withTransaction(deps.db, async (trx) => {
      await writeEvent(trx, {
        type: "scan.completed",
        tsMs: completedAtMs,
        actorUserId: null,
        payload: {
          jobId: meta.jobId,
          libraryId: params.libraryId,
          full: params.full,
          itemsAdded: counters.itemsAdded,
          itemsUpdated: counters.itemsUpdated,
          itemsRemoved: counters.itemsRemoved,
          durationMs: completedAtMs - startedAtMs,
          status: firstError ? "partial" : "succeeded",
          errorMessage: firstError,
          completedAtMs,
        },
      });
    });

    if (firstError) {
      // The job itself still completes (per-file errors are non-fatal —
      // scan.completed already reports 'partial' with the first error
      // message); nothing further to throw here.
      return;
    }
  } catch (err) {
    const completedAtMs = clock();
    const message = err instanceof Error ? err.message : String(err);
    await withTransaction(deps.db, async (trx) => {
      await writeEvent(trx, {
        type: "scan.completed",
        tsMs: completedAtMs,
        actorUserId: null,
        payload: {
          jobId: meta.jobId,
          libraryId: params.libraryId,
          full: params.full,
          itemsAdded: counters.itemsAdded,
          itemsUpdated: counters.itemsUpdated,
          itemsRemoved: counters.itemsRemoved,
          durationMs: completedAtMs - startedAtMs,
          status: "failed",
          errorMessage: message,
          completedAtMs,
        },
      });
    });
    throw err;
  }
}

/** Returns true if the file was a genuine media file this scanner acted on
 * (counts toward filesProcessed/the resume checkpoint's meaning), false if
 * it was auxiliary/wrong-kind and correctly skipped. */
async function processOneFile(
  deps: ScanDeps,
  library: { id: string; media_kind: "movie" | "tv" | "music" },
  params: RunScanParams,
  walked: { absPath: string; relPath: string },
  tagReader: TagReader,
  counters: ScanCounters,
  clock: () => number
): Promise<boolean> {
  const auxKind = classifyAuxiliary(walked.relPath);
  if (auxKind !== null) return false;

  const ext = extensionOf(walked.relPath);
  if (!isMediaExtensionForKind(ext, library.media_kind)) return false;

  let stats;
  try {
    stats = await fsStat(walked.absPath);
  } catch {
    return false; // vanished between walk and stat — treated as not-seen
  }

  const now = clock();
  const existingByPath = await findFileByPath(deps.db, walked.absPath);

  if (existingByPath) {
    // Short-circuit rule (STATE.md P3.10 — supersedes the old path+size-only
    // comment that used to live here): media_files now has an mtime_ms
    // column (migrations/0010_media_files_mtime_ms.sql), so the incremental
    // fast path compares path+size+mtime, matching the task's original
    // wording. A same-path/same-size/same-mtime row is genuinely unchanged
    // (mtime cannot survive a real content edit — every filesystem bumps it
    // on write) and is skipped without re-hashing.
    //
    // size matches but mtime_ms is NULL (a legacy row that predates this
    // column, never yet observed under it) or differs (a same-byte-length
    // in-place edit, or a touch/chmod with no content change) falls through
    // to the hash path instead of being silently trusted:
    //   - hash unchanged => nothing about the file's *content* actually
    //     changed; only mtime_ms needed to catch up. Backfill it via
    //     updateMediaFileMtime alone — no probe-field reset, no re-probe
    //     job, no item.updated event (this is bookkeeping, not a real
    //     change).
    //   - hash changed => a genuine same-size in-place edit (e.g. an
    //     in-place remux). Same re-encode-in-place handling as the
    //     different-size branch below: refresh identity via
    //     updateMediaFileHash (which also lands the new mtime_ms) and
    //     re-enqueue a 'probe' job for the same row.
    const currentMtimeMs = Math.trunc(stats.mtimeMs);
    if (existingByPath.size_bytes === stats.size) {
      if (existingByPath.mtime_ms !== null && existingByPath.mtime_ms === currentMtimeMs) {
        if (existingByPath.missing_since_ms !== null) {
          await clearFileMissing(deps.db, existingByPath.id);
        }
        return true;
      }

      const rehash = await deps.hashPool.hashFile(walked.absPath, stats.size);
      if (rehash === existingByPath.content_hash) {
        // Content unchanged (legacy-NULL backfill, or a no-op mtime bump) —
        // catch up mtime_ms only, and still clear a stale missing flag (the
        // file was found at this path, so it is present), but no probe/
        // event work: nothing about the file's content changed.
        await updateMediaFileMtime(deps.db, existingByPath.id, currentMtimeMs);
        if (existingByPath.missing_since_ms !== null) {
          await clearFileMissing(deps.db, existingByPath.id);
        }
        return true;
      }

      // Re-encoded in place: same path, same size, different hash.
      await updateMediaFileHash(deps.db, existingByPath.id, {
        contentHash: rehash,
        sizeBytes: stats.size,
        mtimeMs: currentMtimeMs,
      });
      await deps.queue.enqueue("probe", { mediaFileId: existingByPath.id });
      return true;
    }

    // Re-encoded: same path, different size => different identity.
    const newHash = await deps.hashPool.hashFile(walked.absPath, stats.size);
    await updateMediaFileHash(deps.db, existingByPath.id, {
      contentHash: newHash,
      sizeBytes: stats.size,
      mtimeMs: currentMtimeMs,
    });
    await deps.queue.enqueue("probe", { mediaFileId: existingByPath.id });
    return true;
  }

  const hash = await deps.hashPool.hashFile(walked.absPath, stats.size);
  const existingByHash = await findFileByContentHash(deps.db, hash);

  if (existingByHash) {
    // Hash match, different path => rename/move (D16). SAME item, SAME
    // media_files row — progress rows (keyed on item_id) are untouched by
    // construction (relinkFile never touches catalog_items/progress).
    const relocatedAtMs = now;
    await withTransaction(deps.db, async (trx) => {
      const relinked = await relinkFile(trx, existingByHash.id, walked.absPath);
      await writeEvent(trx, {
        type: "file.relocated",
        tsMs: relocatedAtMs,
        actorUserId: null,
        payload: {
          itemId: relinked.item_id,
          mediaFileId: relinked.id,
          previousPath: existingByHash.path,
          newPath: walked.absPath,
          contentHash: hash,
          relocatedAtMs,
        },
      });
    });
    return true;
  }

  // Genuinely new file.
  const resolution = await withTransaction(deps.db, async (trx) => {
    const result = await resolveNewFile(
      trx,
      library.media_kind,
      library.id,
      walked.relPath,
      walked.absPath,
      now,
      tagReader
    );
    if (!result) return null;

    const createdFile = await createMediaFile(trx, {
      itemId: result.leafItem.id,
      path: walked.absPath,
      contentHash: hash,
      sizeBytes: stats.size,
      versionLabel: result.versionLabel,
      mtimeMs: Math.trunc(stats.mtimeMs),
    });

    for (const created of result.newlyCreated) {
      await emitItemAdded(trx, now, created);
    }
    if (!result.leafIsNew) {
      // Multi-version/editions or a track added to an existing
      // artist/album: the leaf item already existed, so this is an
      // item.updated (new file on existing item), not item.added.
      await emitItemUpdated(trx, now, result.leafItem, ["mediaFiles"]);
    }

    return { ...result, fileId: createdFile.id };
  });

  if (!resolution) return false; // unparseable — skipped, not an error

  counters.itemsAdded += resolution.newlyCreated.length;
  if (!resolution.leafIsNew) counters.itemsUpdated += 1;

  await deps.queue.enqueue("probe", { mediaFileId: resolution.fileId });
  await enqueueArtworkJobs(deps, resolution.leafItem.id, dirname(walked.absPath));

  // Provider enrichment (deliverable D): one metadata job per newly-created
  // enrichable item (movie/series/artist/album). Only newly-created items
  // are enqueued — a new file on an existing item (another edition, another
  // track) doesn't re-run enrichment. This is the sole scan→metadata wiring
  // point; without it the whole provider pipeline never runs.
  for (const created of resolution.newlyCreated) {
    if (!METADATA_ENRICHABLE_TYPES.has(created.item_type)) continue;
    await deps.queue.enqueue("metadata", {
      itemId: created.id,
      mediaKind: mediaKindForLibrary(library.media_kind),
      contentClass: created.content_class,
    });
  }

  return true;
}
