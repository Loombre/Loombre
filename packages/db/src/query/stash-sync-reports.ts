// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/stash-sync-reports.ts
//
// Writers/readers for migrations/0020_stash_sync_reports.sql's
// stash_sync_reports table (STATE.md S8/K14, Lane C sync engine), plus the
// K14 "live unmatched/stale list" keyset queries over Lane A's
// stash_scene_links table (migrations/0018_stash_provider_core.sql).
//
// Lives in the PUBLIC barrel (src/index.ts), not src/internal/ — same
// justification stash-connections.ts/stash-inventory.ts give for
// themselves: apps/worker (Lane C's sync-consumer.ts, writing report rows
// at run start/finish) and apps/server's admin surface (Lane C's own
// GET /admin/libraries/{id}/stash-sync-report, K14) are BOTH fenced off
// from @loombre/db/internal by dependency-cruiser's "no-internal-db-
// outside-worker" rule — this file is the door through that fence for
// this one surface. No ViewerContext anywhere here: every function is
// admin-only instance operational bookkeeping, never a viewer-scoped
// catalog browse surface (same posture as stash-connections.ts).

import type { Kysely, Selectable } from 'kysely';
import type { DB, StashSyncReportStatus } from '../types.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';

export type StashSyncReportRow = Selectable<DB['stash_sync_reports']>;

// ============================================================================
// stash_sync_reports writer (apps/worker/src/stash/sync-consumer.ts)
// ============================================================================

export interface CreateStashSyncReportInput {
  libraryId: string;
  jobId: string;
  mode: 'full' | 'incremental';
  startedAtMs: number;
}

/** Opens a report row at status='running' — one call at the very start of
 *  a stash-sync job run (before any scene is touched), in the SAME
 *  transaction as the paired `stash.sync.started` event (K12). A pg-boss
 *  retry of the SAME job (same jobId) calling this again would insert a
 *  SECOND running row rather than resuming the first — sync-consumer.ts
 *  is responsible for checking stash_sync_checkpoints first and treating
 *  a resume as "do not open a new report row", see that module's header. */
export async function createStashSyncReport(db: Kysely<DB>, input: CreateStashSyncReportInput): Promise<StashSyncReportRow> {
  return db
    .insertInto('stash_sync_reports')
    .values({
      library_id: input.libraryId,
      job_id: input.jobId,
      mode: input.mode,
      status: 'running',
      started_at_ms: input.startedAtMs,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface FinishStashSyncReportInput {
  status: Exclude<StashSyncReportStatus, 'running'>;
  matchedCount: number;
  updatedCount: number;
  unmatchedCount: number;
  staleCount: number;
  skippedCount: number;
  finishedAtMs: number;
  /** FX4 fix wave (S2): whether this run's Stash connection fell back to a
   *  snapshot copy (adapter.ts's readingFrom === 'snapshot'). OMIT (do not
   *  pass `false`) when the caller genuinely does not know — e.g.
   *  createStashSyncTerminalFailureHook, which never obtained a connection
   *  for the failed attempt — so the column keeps whatever it already held
   *  (NULL from createStashSyncReport's insert) rather than a fabricated
   *  answer. */
  usedSnapshotFallback?: boolean;
}

/** Finalizes a report row (by its own id) — one call at run end, success
 *  or terminal failure, in the SAME transaction as the paired
 *  `stash.sync.completed` event (K12, writeEvent(trx, ...)). */
export async function finishStashSyncReport(
  db: Kysely<DB>,
  reportId: string,
  input: FinishStashSyncReportInput
): Promise<StashSyncReportRow> {
  return db
    .updateTable('stash_sync_reports')
    .set({
      status: input.status,
      matched_count: input.matchedCount,
      updated_count: input.updatedCount,
      unmatched_count: input.unmatchedCount,
      stale_count: input.staleCount,
      skipped_count: input.skippedCount,
      finished_at_ms: input.finishedAtMs,
      ...(input.usedSnapshotFallback !== undefined ? { used_snapshot_fallback: input.usedSnapshotFallback } : {}),
    })
    .where('id', '=', reportId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ============================================================================
// staleness writer (S8 — Lane C's sync engine is the sole writer of
// stash_scene_links.stale = TRUE; migrations/0018's own column comment)
// ============================================================================

export interface MarkStashScenesStaleInput {
  libraryId: string;
  /** Stash scene ids present in stash_scene_links but ABSENT from the
   *  current Stash inventory pass (a full sync) or the current
   *  incremental diff's live set (an incremental sync) — S8's
   *  "scenes present in links but absent from the current Stash read". */
  stashSceneIds: readonly string[];
  nowMs: number;
}

/**
 * Marks vanished scenes stale=TRUE — never deletes anything (S8: the
 * catalog item, its metadata, and the link row all survive). Idempotent:
 * a scene already stale is left alone (WHERE stale = false), so re-running
 * this for the same still-vanished scene never touches last_synced_at_ms
 * pointlessly. The reverse (a scene reappearing) is NOT this function's
 * job — upsertStashSceneLinksFromInventory (Lane A, stash-inventory.ts)
 * unconditionally clears stale back to FALSE for every scene an inventory
 * pass sees, which is the correct "seeing it again is proof it wasn't
 * deleted" signal.
 */
export async function markStashScenesStale(db: Kysely<DB>, input: MarkStashScenesStaleInput): Promise<number> {
  if (input.stashSceneIds.length === 0) return 0;
  const result = await db
    .updateTable('stash_scene_links')
    .set({ stale: true, last_synced_at_ms: input.nowMs })
    .where('library_id', '=', input.libraryId)
    .where('stash_scene_id', 'in', input.stashSceneIds as string[])
    .where('stale', '=', false)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

// ============================================================================
// readers
// ============================================================================

/** The single most recent report row for a library, or undefined when no
 *  sync has ever run — the admin GET endpoint's honest `{report: null}`
 *  shape (K14, mirroring GET /admin/capabilities's own "never probed yet"
 *  precedent) starts from this undefined case. */
export async function getLatestStashSyncReport(db: Kysely<DB>, libraryId: string): Promise<StashSyncReportRow | undefined> {
  return db
    .selectFrom('stash_sync_reports')
    .selectAll()
    .where('library_id', '=', libraryId)
    // `id` tiebreak: two sync runs opened within the same started_at_ms
    // millisecond (application-supplied Date.now(), not a database clock —
    // trivially reachable by two quick back-to-back manual "sync now"
    // triggers) would otherwise leave "which report is latest" to whatever
    // order Postgres happens to return on a tie. `id` breaks the tie
    // deterministically (highest id wins, same direction as started_at_ms
    // desc) rather than causally — see packages/db/src/query/cursor.ts's
    // header for why a UUIDv7 secondary key is stable but not causal order.
    .orderBy('started_at_ms', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

/** Resume support: finds the report row this exact pg-boss job (same
 *  job.id across a retry) already opened, so a resumed stash-sync run
 *  never opens a SECOND 'running' row for the same attempt. */
export async function getStashSyncReportByJobId(db: Kysely<DB>, jobId: string): Promise<StashSyncReportRow | undefined> {
  return db.selectFrom('stash_sync_reports').selectAll().where('job_id', '=', jobId).executeTakeFirst();
}

/** apps/worker/src/stash/sync-consumer.ts's onTerminalFailure hook: finds
 *  "the currently-running report for this library" from just {libraryId}
 *  (packages/jobs' onTerminalFailure hook signature carries no jobId —
 *  see packages/jobs/src/queue.ts's WorkOptions.onTerminalFailure doc
 *  comment) — same "use the payload to find the resource" pattern
 *  apps/worker/src/probe/terminal-failure-hook.ts already establishes.
 *  'stash-sync' registers at queue concurrency:1, so at most one row is
 *  ever 'running' per library in normal operation; orderBy + limit(1) is
 *  defense in depth, not a correctness requirement. */
export async function findRunningStashSyncReport(db: Kysely<DB>, libraryId: string): Promise<StashSyncReportRow | undefined> {
  return db
    .selectFrom('stash_sync_reports')
    .selectAll()
    .where('library_id', '=', libraryId)
    .where('status', '=', 'running')
    // `id` tiebreak — same rationale as getLatestStashSyncReport above (this
    // function's own doc comment already notes orderBy+limit(1) is
    // defense-in-depth, not a correctness requirement under the current
    // concurrency:1 queue registration; the tiebreak just makes that
    // defense-in-depth deterministic instead of DB-tie-order-dependent).
    .orderBy('started_at_ms', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

export interface StashSceneLinkCounts {
  matched: number;
  unmatched: number;
  stale: number;
}

/** Live COUNT(*) snapshot over stash_scene_links (Lane A's table) for a
 *  library — what apps/worker/src/stash/sync-consumer.ts reads at run
 *  completion (and its onTerminalFailure hook) to fill
 *  stash_sync_reports' matched_count/unmatched_count/stale_count columns
 *  (all three are SNAPSHOTS, not this-run tallies — see that migration's
 *  own column comments). Three indexed COUNT(*) queries rather than one
 *  FILTER-clause aggregate: each is covered by an existing partial index
 *  (stash_scene_links_item_id_idx / _unmatched_idx / stale_keyset_idx),
 *  so this stays an index-only count scan even at the owner's 33k-scene
 *  scale, not a sequential scan. */
export async function getStashSceneLinkCounts(db: Kysely<DB>, libraryId: string): Promise<StashSceneLinkCounts> {
  const [matchedRow, unmatchedRow, staleRow] = await Promise.all([
    db.selectFrom('stash_scene_links').select((eb) => eb.fn.countAll<string>().as('n')).where('library_id', '=', libraryId).where('item_id', 'is not', null).executeTakeFirstOrThrow(),
    db.selectFrom('stash_scene_links').select((eb) => eb.fn.countAll<string>().as('n')).where('library_id', '=', libraryId).where('item_id', 'is', null).executeTakeFirstOrThrow(),
    db.selectFrom('stash_scene_links').select((eb) => eb.fn.countAll<string>().as('n')).where('library_id', '=', libraryId).where('stale', '=', true).executeTakeFirstOrThrow(),
  ]);
  return { matched: Number(matchedRow.n), unmatched: Number(unmatchedRow.n), stale: Number(staleRow.n) };
}

// ============================================================================
// K14 live unmatched/stale scene lists (stash_scene_links, Lane A's table)
// ============================================================================

export interface StashSyncSceneListRow {
  stashSceneId: string;
  stashPath: string;
  stashUpdatedAtMs: number | null;
}

export interface StashSyncSceneListResult {
  rows: StashSyncSceneListRow[];
  nextCursor: string | null;
}

interface StashSceneCursorPayload {
  id: string;
}

function isStashSceneCursorPayload(value: unknown): value is StashSceneCursorPayload {
  // This cursor keys on Stash's OWN stash_scene_id (schema: TEXT NOT
  // NULL, not uuid) — isCursorRowId's uuid check would be WRONG here,
  // not a fix. The marker below must stay directly above the check.
  // grep-gates:allow-bare-cursor-row-id
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string';
}

const DEFAULT_LIST_LIMIT = 50;

function toSceneListRow(row: { stash_scene_id: string; stash_path: string; stash_updated_at_ms: number | null }): StashSyncSceneListRow {
  return { stashSceneId: row.stash_scene_id, stashPath: row.stash_path, stashUpdatedAtMs: row.stash_updated_at_ms };
}

export interface ListStashScenesParams {
  cursor?: string;
  limit?: number;
}

/** Live keyset list of stash_scene_links rows with item_id IS NULL for a
 *  library (S4 "unmatched, visible by construction") — ordered by
 *  stash_scene_id ASC, matched by migrations/0020's
 *  stash_scene_links_unmatched_keyset_idx. Never reads the report table:
 *  this is the CURRENT truth, independent of when the last sync ran. */
export async function listUnmatchedStashScenes(
  db: Kysely<DB>,
  libraryId: string,
  params: ListStashScenesParams = {}
): Promise<StashSyncSceneListResult> {
  const limit = params.limit ?? DEFAULT_LIST_LIMIT;
  let query = db
    .selectFrom('stash_scene_links')
    .select(['stash_scene_id', 'stash_path', 'stash_updated_at_ms'])
    .where('library_id', '=', libraryId)
    .where('item_id', 'is', null);

  if (params.cursor) {
    const { id } = decodeCursor(params.cursor, isStashSceneCursorPayload);
    query = query.where('stash_scene_id', '>', id);
  }

  const rows = await query.orderBy('stash_scene_id', 'asc').limit(limit + 1).execute();
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor<StashSceneCursorPayload>({ id: page[page.length - 1]!.stash_scene_id }) : null;
  return { rows: page.map(toSceneListRow), nextCursor };
}

/** Live keyset list of stash_scene_links rows with stale = TRUE for a
 *  library (S8 — kept, never deleted) — same shape as
 *  listUnmatchedStashScenes, matched by migrations/0020's
 *  stash_scene_links_stale_keyset_idx. */
export async function listStaleStashScenes(
  db: Kysely<DB>,
  libraryId: string,
  params: ListStashScenesParams = {}
): Promise<StashSyncSceneListResult> {
  const limit = params.limit ?? DEFAULT_LIST_LIMIT;
  let query = db
    .selectFrom('stash_scene_links')
    .select(['stash_scene_id', 'stash_path', 'stash_updated_at_ms'])
    .where('library_id', '=', libraryId)
    .where('stale', '=', true);

  if (params.cursor) {
    const { id } = decodeCursor(params.cursor, isStashSceneCursorPayload);
    query = query.where('stash_scene_id', '>', id);
  }

  const rows = await query.orderBy('stash_scene_id', 'asc').limit(limit + 1).execute();
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor<StashSceneCursorPayload>({ id: page[page.length - 1]!.stash_scene_id }) : null;
  return { rows: page.map(toSceneListRow), nextCursor };
}

// ============================================================================
// FX3 fix wave: the Loombre-side half of S4/S8's "both unmatched sides"
// law. listUnmatchedStashScenes/listStaleStashScenes above are the
// Stash-side lists (a stash_scene_links row unmatched or stale);
// apps/worker/src/stash/matching.ts's own header documents the Loombre
// side ("unmatched Loombre files land visibly... a plain set-difference
// the caller can compute directly from this function's output") as caller
// responsibility — nothing computed it until now. This mirrors the SAME
// candidate universe src/query/stash-inventory.ts's
// listCandidateMediaFilesForLibrary uses for matching itself (every
// media_files row belonging to the library via catalog_items, no
// item_type/missing_since_ms filter of its own — a matching candidate and
// an "unmatched, visible" candidate must stay the exact same set, or the
// admin-visible list could disagree with what the sync engine itself
// considers a candidate), just the half with no stash_scene_links row
// pointing at its item.
// ============================================================================

export interface UnmatchedLoombreFileRow {
  mediaFileId: string;
  itemId: string;
  itemTitle: string;
  path: string;
  sizeBytes: number | null;
}

export interface UnmatchedLoombreFileListResult {
  rows: UnmatchedLoombreFileRow[];
  nextCursor: string | null;
}

interface LoombreFileCursorPayload {
  id: string;
}

function isLoombreFileCursorPayload(value: unknown): value is LoombreFileCursorPayload {
  return typeof value === 'object' && value !== null && isCursorRowId((value as Record<string, unknown>).id);
}

/** Live keyset list of media_files rows in `libraryId` whose owning item has
 *  NO stash_scene_links row (any stash_scene_id, matched or not — the
 *  predicate is "does a link exist at all for this item", the mirror image
 *  of "item_id IS NULL" on the Stash-side list). Ordered by media_files.id
 *  ASC — no dedicated index added (admin-only surface, not a T0 zone-browse
 *  path per S10's scope; the EXISTS subquery is already covered by
 *  migrations/0018's partial stash_scene_links_item_id_idx and
 *  media_files_item_id_idx, matching listCandidateMediaFilesForLibrary's
 *  own unindexed-beyond-that precedent for the identical candidate join). */
export async function listUnmatchedLoombreFiles(
  db: Kysely<DB>,
  libraryId: string,
  params: ListStashScenesParams = {}
): Promise<UnmatchedLoombreFileListResult> {
  const limit = params.limit ?? DEFAULT_LIST_LIMIT;
  let query = db
    .selectFrom('media_files')
    .innerJoin('catalog_items', 'catalog_items.id', 'media_files.item_id')
    .where('catalog_items.library_id', '=', libraryId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('stash_scene_links')
            .select('stash_scene_links.id')
            .where('stash_scene_links.library_id', '=', libraryId)
            .whereRef('stash_scene_links.item_id', '=', 'catalog_items.id')
        )
      )
    );

  if (params.cursor) {
    const { id } = decodeCursor(params.cursor, isLoombreFileCursorPayload);
    query = query.where('media_files.id', '>', id);
  }

  const rows = await query
    .select([
      'media_files.id as mediaFileId',
      'catalog_items.id as itemId',
      'catalog_items.title as itemTitle',
      'media_files.path as path',
      'media_files.size_bytes as sizeBytes',
    ])
    .orderBy('media_files.id', 'asc')
    .limit(limit + 1)
    .execute();

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor<LoombreFileCursorPayload>({ id: page[page.length - 1]!.mediaFileId }) : null;
  return { rows: page, nextCursor };
}
