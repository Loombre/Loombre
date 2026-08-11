// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/stash-connections.ts
//
// Config + connection-outcome writers for migrations/0018_stash_provider_core.sql's
// library_stash_connections and library_path_mappings tables (STATE.md
// mission "Stash SQLite metadata sync", S1-S4, K8, K10). Lives in the
// PUBLIC barrel (src/index.ts), not src/internal/ — same reasoning
// library-provider-chains.ts's header gives for itself: apps/worker (Lane
// A's apps/worker/src/stash/connect.ts, writing connection outcomes at
// every connect attempt) and a future apps/server admin surface (Lane D,
// writing sqlite_path/enabled/path-mapping config from an admin form) are
// BOTH fenced off from the @loombre/db/internal subpath by
// dependency-cruiser's "no-internal-db-outside-worker" rule — this file is
// the door through that fence for this one surface.
//
// No ViewerContext anywhere in this module: every function here is
// admin-only instance configuration / connection-health bookkeeping, never
// a viewer-scoped catalog browse surface — same posture src/internal/jobs.ts's
// header documents for the `jobs` ledger ("writes are not viewer-scoped").
// The one read that touches catalog-adjacent data at scale
// (stash-inventory.ts's computePathMappingMatchPreview) carries its own,
// more detailed justification for the same choice. Content-visibility
// gating for this admin surface is the HTTP layer's job (an admin-only
// route guard), not this module's — mirrors library-provider-chains.ts and
// plugins.ts, neither of which take a ViewerContext either.

import type { Kysely, Selectable } from 'kysely';
import type { DB, LibraryPathMappingsTable, LibraryStashConnectionsTable, StashConnectionStatus } from '../types.js';
import { getLibraryById, withTransaction, writeEvent } from '../internal/index.js';

export type LibraryStashConnectionRow = Selectable<LibraryStashConnectionsTable>;
export type LibraryPathMappingRow = Selectable<LibraryPathMappingsTable>;

export class LibraryNotFoundForStashError extends Error {
  constructor(libraryId: string) {
    super(`library "${libraryId}" does not exist`);
    this.name = 'LibraryNotFoundForStashError';
  }
}

export class StashConnectionNotConfiguredError extends Error {
  constructor(libraryId: string) {
    super(`library "${libraryId}" has no library_stash_connections row — configure sqlite_path first`);
    this.name = 'StashConnectionNotConfiguredError';
  }
}

// ============================================================================
// library_stash_connections
// ============================================================================

/** Ordered by nothing in particular — at most one row per library
 *  (UNIQUE(library_id), migration comment). */
export async function getLibraryStashConnection(db: Kysely<DB>, libraryId: string): Promise<LibraryStashConnectionRow | undefined> {
  return db.selectFrom('library_stash_connections').selectAll().where('library_id', '=', libraryId).executeTakeFirst();
}

export interface UpsertLibraryStashConnectionConfigInput {
  libraryId: string;
  sqlitePath: string;
  enabled?: boolean;
  /** K15/S6: which Stash tag names map to genre. `undefined` (the key
   *  simply absent from the caller's input) means "leave the saved value
   *  untouched" — the SAME omit-to-preserve convention `enabled` already
   *  uses. `null` is a REAL, distinct value (explicitly reset to the
   *  default heuristic), not a stand-in for "unspecified" — callers must
   *  only pass this key at all when the admin actually sent one (see
   *  apps/server/src/plugins/admin-stash.service.ts's putConnection). */
  genreTagNames?: string[] | null;
  /** Filesystem blob-store path (owner-approved cover ingest). Same
   *  omit-to-preserve / null-is-a-real-clear convention as genreTagNames:
   *  `undefined` leaves the saved value untouched; `null` clears it (back
   *  to DB-only art); a string sets the on-disk blob directory. */
  blobsPath?: string | null;
  nowMs: number;
}

/**
 * Admin config write (Lane D's future HTTP surface): creates the
 * library_stash_connections row on first configure, or updates
 * sqlite_path/enabled/genre_tag_names on an existing one. Deliberately
 * leaves every status/last_seen_* column untouched on an UPDATE — those
 * are owned exclusively by recordStashConnectionOutcome below (the
 * worker's connect-time writer), so an admin editing the sqlite_path never
 * fabricates a fresh "ok" status without an actual connect attempt.
 * Rejects a nonexistent library outright (mirrors
 * replaceLibraryProviderChain's "reject the whole call" precedent).
 */
export async function upsertLibraryStashConnectionConfig(
  db: Kysely<DB>,
  input: UpsertLibraryStashConnectionConfigInput
): Promise<LibraryStashConnectionRow> {
  const library = await getLibraryById(db, input.libraryId);
  if (!library) {
    throw new LibraryNotFoundForStashError(input.libraryId);
  }

  return db
    .insertInto('library_stash_connections')
    .values({
      library_id: input.libraryId,
      sqlite_path: input.sqlitePath,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.genreTagNames !== undefined ? { genre_tag_names: input.genreTagNames } : {}),
      ...(input.blobsPath !== undefined ? { stash_blobs_path: input.blobsPath } : {}),
      created_at_ms: input.nowMs,
      updated_at_ms: input.nowMs,
    })
    .onConflict((oc) =>
      oc.column('library_id').doUpdateSet({
        sqlite_path: (eb) => eb.ref('excluded.sqlite_path'),
        ...(input.enabled !== undefined ? { enabled: (eb) => eb.ref('excluded.enabled') } : {}),
        ...(input.genreTagNames !== undefined ? { genre_tag_names: (eb) => eb.ref('excluded.genre_tag_names') } : {}),
        ...(input.blobsPath !== undefined ? { stash_blobs_path: (eb) => eb.ref('excluded.stash_blobs_path') } : {}),
        updated_at_ms: (eb) => eb.ref('excluded.updated_at_ms'),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface RecordStashConnectionOutcomeInput {
  libraryId: string;
  status: StashConnectionStatus;
  statusDetail?: string | null;
  lastSeenSchemaVersion?: number | null;
  nowMs: number;
}

/**
 * The worker-side connect-time writer (apps/worker/src/stash/connect.ts,
 * S2/S3) — records the outcome of the MOST RECENT open attempt. Requires
 * an existing row (a connection must be configured, via
 * upsertLibraryStashConnectionConfig, before an outcome can be recorded
 * against it) — throws StashConnectionNotConfiguredError rather than
 * silently creating a placeholder row with no sqlite_path.
 * last_connected_at_ms only advances on `status = 'ok'`; last_checked_at_ms
 * advances on every call regardless of outcome (S2/S3's "last observed
 * outcome", not "last success").
 */
export async function recordStashConnectionOutcome(
  db: Kysely<DB>,
  input: RecordStashConnectionOutcomeInput
): Promise<LibraryStashConnectionRow> {
  const existing = await getLibraryStashConnection(db, input.libraryId);
  if (!existing) {
    throw new StashConnectionNotConfiguredError(input.libraryId);
  }

  return db
    .updateTable('library_stash_connections')
    .set({
      status: input.status,
      status_detail: input.statusDetail ?? null,
      ...(input.lastSeenSchemaVersion !== undefined ? { last_seen_schema_version: input.lastSeenSchemaVersion } : {}),
      ...(input.status === 'ok' ? { last_connected_at_ms: input.nowMs } : {}),
      last_checked_at_ms: input.nowMs,
      updated_at_ms: input.nowMs,
    })
    .where('library_id', '=', input.libraryId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface DeleteLibraryStashConnectionInput {
  libraryId: string;
  actorUserId: string;
  nowMs: number;
}

/**
 * Admin "forget this connection entirely" (Stash OPEN ledger item 6, DELETE
 * /admin/libraries/{id}/stash-connection): drops the library_stash_connections
 * row ONLY — every config/status/timestamp column on it. There is no
 * keyring-held secret to clear alongside it (S1: Stash is a first-party
 * read-only SQLite-FILE provider, never an HTTP API with a credential —
 * unlike removePluginAndEmit's keyring cleanup, which this function's
 * transactional-delete-then-emit shape otherwise mirrors exactly).
 *
 * Deliberately NEVER touches (S8 "synced facts are KEPT, never deleted,
 * even when their source connection is forgotten" — the same law that
 * marks vanished Stash scenes `stale` instead of removing them):
 *   - library_path_mappings (separate table keyed by library_id, not FK'd
 *     to this row's id) — preserved for a future re-attach, same as this
 *     function's prior "detach" behavior.
 *   - stash_scene_links / any already-synced catalog item metadata — has
 *     no FK relationship to this row at all, so nothing to preserve
 *     defensively; it was never reachable from here.
 *   - stash_sync_reports / stash_sync_checkpoints — historical run records,
 *     keyed by library_id, independent of this row's lifecycle.
 *
 * No zombie schedule/job to clean up either: apps/worker/src/stash/
 * schedule-loop.ts's runStashScheduleTick re-reads getLibraryStashConnection
 * fresh every tick and skips a library with no row, and an already-enqueued
 * or in-flight `stash-sync` job's connectToStashLibrary (apps/worker/src/
 * stash/connect.ts) treats a missing row as an ordinary 'unreachable'
 * outcome — the job fails cleanly (a 'failed' stash_sync_reports row via
 * pg-boss's normal retry/terminal-failure path) rather than crashing or
 * silently spinning. Neither needs code here to reach into the job queue.
 *
 * Throws StashConnectionNotConfiguredError (checked INSIDE the same
 * transaction as the delete, closing the TOCTOU window) when the library
 * has no connection configured — the admin service maps this to 404,
 * "nothing to forget", rather than a silent no-op 204 (unlike
 * clearAdminMailCredentials' idempotent-clear posture: that surface owns a
 * single optional scalar credential pair where "already cleared" is a
 * natural resting state; a Stash connection is a substantial configured
 * resource whose absence really is "not found").
 */
export async function deleteLibraryStashConnectionAndEmit(db: Kysely<DB>, input: DeleteLibraryStashConnectionInput): Promise<void> {
  await withTransaction(db, async (trx) => {
    const existing = await trx.selectFrom('library_stash_connections').select(['id']).where('library_id', '=', input.libraryId).executeTakeFirst();
    if (!existing) {
      throw new StashConnectionNotConfiguredError(input.libraryId);
    }

    await trx.deleteFrom('library_stash_connections').where('library_id', '=', input.libraryId).execute();

    await writeEvent(trx, {
      type: 'stash.provider.disconnected',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { libraryId: input.libraryId, disconnectedAtMs: input.nowMs },
    });
  });
}

// ============================================================================
// library_path_mappings
// ============================================================================

/** Ordered read — `position ASC` is admin DISPLAY order (matching itself
 *  is longest-prefix-wins, independent of this order — see
 *  packages/shared/src/stash-path-mapping.ts's header). */
export async function getLibraryPathMappings(db: Kysely<DB>, libraryId: string): Promise<LibraryPathMappingRow[]> {
  return db.selectFrom('library_path_mappings').selectAll().where('library_id', '=', libraryId).orderBy('position', 'asc').execute();
}

export interface LibraryPathMappingInput {
  stashPrefix: string;
  loombrePrefix: string;
}

/**
 * Replaces a library's ENTIRE path-mapping set wholesale (delete +
 * re-insert with `position` = array index) — same convention
 * replaceLibraryProviderChain uses for library_provider_entries, INCLUDING
 * that function's transactional wrap (V1-011: a bare delete+insert loop
 * left a failure partway through with neither the old nor the new set —
 * this must be all-or-nothing, exactly like the sibling). An empty
 * `mappings` array is legal (clears all mappings; every Stash path then
 * simply fails to path-match, falling through to S4's oshash tier).
 */
export async function replaceLibraryPathMappings(
  db: Kysely<DB>,
  libraryId: string,
  mappings: LibraryPathMappingInput[]
): Promise<LibraryPathMappingRow[]> {
  return withTransaction(db, async (trx) => {
    const library = await getLibraryById(trx, libraryId);
    if (!library) {
      throw new LibraryNotFoundForStashError(libraryId);
    }

    await trx.deleteFrom('library_path_mappings').where('library_id', '=', libraryId).execute();

    const inserted: LibraryPathMappingRow[] = [];
    for (let position = 0; position < mappings.length; position += 1) {
      const mapping = mappings[position]!;
      inserted.push(
        await trx
          .insertInto('library_path_mappings')
          .values({
            library_id: libraryId,
            stash_prefix: mapping.stashPrefix,
            loombre_prefix: mapping.loombrePrefix,
            position,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
      );
    }

    return inserted;
  });
}
