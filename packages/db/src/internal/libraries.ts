// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/libraries.ts
//
// Scanner-internal library reads. Not viewer-scoped (P1.13 carve-out, same
// as the rest of this module): the scan job handler needs a library's
// paths/media_kind regardless of which user (if any) triggered it, and the
// watcher needs the full library list at worker boot to know what to watch
// — neither is a catalog browse surface, so neither goes through
// packages/db/src/query's ViewerContext guard.

import { sql, type Selectable } from 'kysely';
import type { ContentClass, LibrariesTable, MediaKind } from '../types.js';
import type { DbOrTx } from './tx.js';

export type LibraryRow = Selectable<LibrariesTable>;

export async function getLibraryById(db: DbOrTx, id: string): Promise<LibraryRow | undefined> {
  return db.selectFrom('libraries').selectAll().where('id', '=', id).executeTakeFirst();
}

/** Every library, unfiltered — the watcher's boot-time enumeration
 *  (apps/worker/src/scan/watcher.ts) and any future admin tooling that
 *  needs the full set rather than one viewer's slice of it. */
export async function listLibraries(db: DbOrTx): Promise<LibraryRow[]> {
  return db.selectFrom('libraries').selectAll().execute();
}

// ============================================================================
// Data-freedom import additions (apps/worker/src/import — deliverable E).
//
// The three functions below are ADDITIVE, minimal writers the import
// consumer needs and nothing pre-existing covers: src/query/libraries.ts's
// public createLibrary() (a) always mints a fresh id (no id-preservation
// path — the wizard-restore exit bar needs the archive's OWN library id
// preserved on an empty target) and (b) unconditionally writes a
// `library.created` event + opens its own transaction, neither of which fit
// import's "one scan.completed-style summary event per touched library,
// inside the caller's single whole-archive transaction" design (see
// apps/worker/src/import/consumer.ts's module header for the event-reuse
// rationale). Guard-free by the same P1.13 carve-out as every other writer
// in this module: a bulk restore write is not a viewer-scoped action.
// ============================================================================

export interface InsertLibraryWithIdInput {
  /** Omit to let the DB DEFAULT loombre_uuidv7() mint a fresh id (import's
   *  merge-mode "create new" branch); supply the archive's own library id
   *  for the empty-target ID-preservation restore path — see the import
   *  consumer's module header. */
  id?: string;
  name: string;
  mediaKind: MediaKind;
  paths: string[];
  contentClass: ContentClass;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Id-preserving library insert for the import empty-target restore path
 *  (docs/PLAN.md §8.4). Never an upsert — the caller has already decided
 *  (via findLibraryByNameAndKind, or the overall empty-target check) that
 *  no row with this id/natural-key exists yet. */
export async function insertLibraryWithId(db: DbOrTx, input: InsertLibraryWithIdInput): Promise<LibraryRow> {
  return db
    .insertInto('libraries')
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      media_kind: input.mediaKind,
      paths: input.paths,
      content_class: input.contentClass,
      created_at_ms: input.createdAtMs,
      updated_at_ms: input.updatedAtMs,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Import's merge-skip-existing natural key for libraries (case-insensitive
 * name + media_kind — the archive carries no other stable library
 * identifier: no path-set uniqueness guarantee, and paths are the one thing
 * most likely to legitimately differ between the machine that exported and
 * the machine importing). Matches src/internal/catalog.ts's
 * findMovieByTitleYear-family precedent: a plain natural-key SELECT, not a
 * guarded read (bulk-restore bookkeeping, not a browse surface).
 */
export async function findLibraryByNameAndKind(
  db: DbOrTx,
  name: string,
  mediaKind: MediaKind
): Promise<LibraryRow | undefined> {
  return db
    .selectFrom('libraries')
    .selectAll()
    .where((eb) => eb(sql`lower(name)`, '=', name.toLowerCase()))
    .where('media_kind', '=', mediaKind)
    .executeTakeFirst();
}

/**
 * Grants `userId` visibility onto `libraryId` (library_permissions gate 4)
 * — idempotent (ON CONFLICT DO NOTHING). Import calls this exactly once,
 * immediately after INSERTing a brand-new GENERAL library (never for a
 * merge-matched pre-existing library, and never for a restricted library),
 * mirroring src/query/libraries.ts's createLibrary() auto-grant precedent
 * and rationale verbatim: a general library has no gates 1-5 to pass, so
 * requiring the importing admin to make a SECOND call just to see the
 * library they just restored is friction with no gate-4 rationale behind
 * it; a restricted library's gate 4 stays "default-deny, including for
 * admins" exactly as it does for createLibrary().
 */
export async function grantLibraryPermission(
  db: DbOrTx,
  input: { userId: string; libraryId: string; grantedAtMs: number }
): Promise<void> {
  await db
    .insertInto('library_permissions')
    .values({ user_id: input.userId, library_id: input.libraryId, granted_at_ms: input.grantedAtMs })
    .onConflict((oc) => oc.columns(['user_id', 'library_id']).doNothing())
    .execute();
}
