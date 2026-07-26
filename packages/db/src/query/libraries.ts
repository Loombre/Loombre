// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/libraries.ts
//
// createLibrary — admin identity-plumbing, not viewer-scoped catalog reads
// (mission spec explicit call-out): a library row is created out-of-band of
// any ViewerContext (the caller is authorized by isAdmin, checked at the
// apps/server controller layer, not by allowedLibraryIds/restrictedCleared —
// there IS no viewer-scoped "can I create a library" question). It lives in
// the PUBLIC barrel rather than @loombre/db/internal because apps/server (the
// only caller) is fenced off from the internal subpath by dependency-cruiser
// (P1.13's "no-internal-db-outside-worker" rule) — this is the one narrow,
// deliberately-named door through that fence, not a general-purpose bypass.
//
// Writes the row AND its `library.created` event in ONE transaction (outbox
// pattern, docs/PLAN.md §4.3 — matches src/internal/events.ts's writeEvent
// contract, which only accepts a live Transaction handle so "write an event
// outside a transaction" is a compile error). Reuses the internal module's
// withTransaction/writeEvent helpers directly — packages/db importing its
// own src/internal is exempt from the dependency-cruiser fence (the rule
// scopes to callers OUTSIDE packages/db; see .dependency-cruiser.cjs).

// ADDENDUM (P1.17, same wave): this file also grew the rest of the
// /libraries surface — viewer-guarded list/get (listLibrariesForViewer/
// getLibraryForViewer, using the SAME applyLibraryIdFilter/
// applyContentClassFilter primitives export.ts already builds its guarded
// library listing from) and admin CRUD/permissions writes
// (updateLibraryAdmin/deleteLibraryAdmin/getLibraryPermissionsAdmin/
// putLibraryPermissionsAdmin). The admin functions are existence-scoped by
// id, not ViewerContext-guarded — library ADMINISTRATION is authorized by
// isAdmin (checked at the apps/server controller layer from the access
// token claim) and is deliberately a different question from "can this
// viewer see this library's content" (an admin managing a restricted
// library's paths/permissions does not need to hold that library's own
// gate-5 live unlock — same reasoning as images.ts's "library" entity
// branch note about gate-4-without-gate-5, but for a DIFFERENT operation
// class: administration, not content access).

// ADDENDUM 2 (STATE.md Phosphor retheme, W1c "contract enablers" lane):
// getLibraryItemCountsForViewer (Sidebar Movies/TV Shows counts,
// design/phosphor README Shell spec) and listLibraryPathsAdmin (storage-
// pool meter's filesystem-path source — see apps/server/src/catalog/
// admin-storage-pool.ts for the syscall side). The former is
// ViewerContext-guarded (routes through applyGuard exactly like every
// other catalog_items read, so a general viewer's counts never include
// zone titles, and a restricted-profile viewer's counts exclude the zone
// BY CONSTRUCTION — their allowedLibraryIds never contains a restricted
// library id at all); the latter is existence-scoped/admin-authorized like
// this file's other *Admin functions (disk CAPACITY across every library's
// root paths is not catalog content — there is no restricted-content leak
// class over a `paths` string column any admin can already read one
// library at a time via GET /libraries/{id}).

import type { Kysely, Selectable } from 'kysely';
import type { ContentClass, DB, ItemType, LibrariesTable, MediaKind } from '../types.js';
import { getLibraryById, withTransaction, writeEvent } from '../internal/index.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyGuard, applyLibraryIdFilter } from './guard.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export type LibraryRow = Selectable<LibrariesTable>;

export interface CreateLibraryInput {
  name: string;
  mediaKind: MediaKind;
  paths: string[];
  /** Omitted -> DB DEFAULT 'general' (0001_init.sql). */
  contentClass?: ContentClass;
  /** Event envelope's actorUserId (nullable at the schema level, but a
   *  library-create request always has an authenticated admin actor). */
  actorUserId: string;
  nowMs: number;
}

export async function createLibrary(db: Kysely<DB>, input: CreateLibraryInput): Promise<LibraryRow> {
  return withTransaction(db, async (trx) => {
    const row = await trx
      .insertInto('libraries')
      .values({
        name: input.name,
        media_kind: input.mediaKind,
        paths: input.paths,
        ...(input.contentClass !== undefined ? { content_class: input.contentClass } : {}),
        created_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Payload shape matches packages/contract/event-schemas/library.created.schema.json
    // exactly (libraryId, name, mediaKind, contentClass, createdAtMs) — the
    // event reads the row's OWN content_class (never the caller's requested
    // value) so a future DB-level default/override can never desync the
    // event from what was actually persisted.
    await writeEvent(trx, {
      type: 'library.created',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        libraryId: row.id,
        name: row.name,
        mediaKind: row.media_kind,
        contentClass: row.content_class,
        createdAtMs: row.created_at_ms,
      },
    });

    // Gap fix (gap-closure lane, Wave-2 finding): without this, a freshly
    // created library is invisible to EVERYONE — including the creating
    // admin — until a separate PUT /libraries/{id}/permissions call grants
    // it, because listLibrariesForViewer/getLibraryForViewer both apply
    // applyLibraryIdFilter(ctx.allowedLibraryIds), and allowedLibraryIds is
    // sourced entirely from library_permissions rows (see
    // getLibraryPermissionSummary in ./identity.ts) — there is no implicit
    // "admins see everything" carve-out in the guard, by design (D7/§6.4:
    // "default-deny, including for admins").
    //
    // The §6.4 call (read gate 4 closely — it's about RESTRICTED libraries
    // specifically: "explicit library_permissions grant on the restricted
    // library (default-deny, including for admins)"): gate 4 is deliberate
    // friction for the restricted class, not a blanket rule that ALL
    // library visibility must always be a separate manual step. A general
    // library has no gates 1-5 to pass at all — content_class='general'
    // rows are visible to any user whose allowedLibraryIds includes the
    // library, with no additional restricted-content ceremony. So:
    //   - general library: auto-grant the creating admin permission in
    //     this same transaction. The admin explicitly asked for this
    //     library to exist; requiring a SECOND API call to see their own
    //     creation is friction with no gate-4 rationale behind it (gate 4
    //     never mentions non-restricted libraries).
    //   - restricted library: do NOT auto-grant. Auto-granting here would
    //     let a bare "create a restricted library" call silently satisfy
    //     gate 4 for its own creator, defeating the "including for
    //     admins" clause — an admin who wants to see the restricted
    //     library they just made must still call PUT .../permissions
    //     explicitly, same as granting any other user. Tested both ways:
    //     packages/db/test/libraries.spec.ts.
    if (row.content_class !== 'restricted') {
      await trx
        .insertInto('library_permissions')
        .values({ user_id: input.actorUserId, library_id: row.id, granted_at_ms: input.nowMs })
        .onConflict((oc) => oc.columns(['user_id', 'library_id']).doNothing())
        .execute();
    }

    return row;
  });
}

// ============================================================================
// Viewer-guarded reads
// ============================================================================

export interface ListLibrariesForViewerParams {
  cursor?: string;
  limit?: number;
}

export interface ListLibrariesForViewerResult {
  rows: LibraryRow[];
  nextCursor: string | null;
}

interface LibraryCursorPayload {
  createdAtMs: number;
  id: string;
}

function isLibraryCursorPayload(value: unknown): value is LibraryCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).createdAtMs === 'number' &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

const DEFAULT_LIMIT = 50;

export async function listLibrariesForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ListLibrariesForViewerParams = {}
): Promise<ListLibrariesForViewerResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = applyContentClassFilter(
    applyLibraryIdFilter(db.selectFrom('libraries'), ctx, 'libraries.id'),
    ctx,
    'libraries.content_class'
  ).selectAll();

  if (params.cursor) {
    const { createdAtMs, id } = decodeCursor(params.cursor, isLibraryCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('created_at_ms', '<', createdAtMs),
        eb.and([eb('created_at_ms', '=', createdAtMs), eb('id', '<', id)]),
      ])
    );
  }

  const rows = await query.orderBy('created_at_ms', 'desc').orderBy('id', 'desc').limit(limit).execute();

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? encodeCursor({ createdAtMs: last.created_at_ms, id: last.id }) : null;

  return { rows, nextCursor };
}

export async function getLibraryForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string
): Promise<LibraryRow | undefined> {
  return applyContentClassFilter(
    applyLibraryIdFilter(db.selectFrom('libraries'), ctx, 'libraries.id'),
    ctx,
    'libraries.content_class'
  )
    .selectAll()
    .where('libraries.id', '=', id)
    .executeTakeFirst();
}

// ============================================================================
// Admin CRUD / permissions (existence-scoped, not viewer-guarded — see
// module header addendum).
// ============================================================================

export async function getLibraryByIdAdmin(db: Kysely<DB>, id: string): Promise<LibraryRow | undefined> {
  return getLibraryById(db, id);
}

export interface UpdateLibraryAdminInput {
  name?: string;
  paths?: string[];
  nowMs: number;
}

export async function updateLibraryAdmin(
  db: Kysely<DB>,
  id: string,
  input: UpdateLibraryAdminInput
): Promise<LibraryRow | undefined> {
  return db
    .updateTable('libraries')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.paths !== undefined ? { paths: input.paths } : {}),
      updated_at_ms: input.nowMs,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteLibraryAdmin(db: Kysely<DB>, id: string): Promise<boolean> {
  const result = await db.deleteFrom('libraries').where('id', '=', id).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

export interface LibraryPermissionEntry {
  userId: string;
  granted: boolean;
}

/** Only currently-granted users are returned (default-deny: absence of a
 *  library_permissions row IS "not granted", there is no separate boolean
 *  column to read a `false` off of — docs/PLAN.md §6.4 gate 4). */
export async function getLibraryPermissionsAdmin(
  db: Kysely<DB>,
  libraryId: string
): Promise<LibraryPermissionEntry[]> {
  const rows = await db
    .selectFrom('library_permissions')
    .select('user_id')
    .where('library_id', '=', libraryId)
    .execute();
  return rows.map((r) => ({ userId: r.user_id, granted: true }));
}

/**
 * Replaces the grant set wholesale: entries with `granted: true` are
 * upserted, entries with `granted: false` (or simply omitted from a future
 * call) are deleted. Returns the resulting current-grants list (same shape
 * as getLibraryPermissionsAdmin).
 */
export async function putLibraryPermissionsAdmin(
  db: Kysely<DB>,
  libraryId: string,
  entries: LibraryPermissionEntry[],
  nowMs: number
): Promise<LibraryPermissionEntry[]> {
  await withTransaction(db, async (trx) => {
    const toGrant = entries.filter((e) => e.granted).map((e) => e.userId);
    const toRevoke = entries.filter((e) => !e.granted).map((e) => e.userId);

    if (toRevoke.length > 0) {
      await trx
        .deleteFrom('library_permissions')
        .where('library_id', '=', libraryId)
        .where('user_id', 'in', toRevoke)
        .execute();
    }

    for (const userId of toGrant) {
      await trx
        .insertInto('library_permissions')
        .values({ user_id: userId, library_id: libraryId, granted_at_ms: nowMs })
        .onConflict((oc) => oc.columns(['user_id', 'library_id']).doNothing())
        .execute();
    }
  });

  return getLibraryPermissionsAdmin(db, libraryId);
}

// ============================================================================
// Wave 1c additions (STATE.md Phosphor retheme, "contract enablers" lane).
// ============================================================================

export interface LibraryItemCountRow {
  libraryId: string;
  itemType: ItemType;
  count: number;
}

/**
 * Guarded per-(library, item_type) item counts — routed through
 * applyGuard() exactly like every other catalog_items read in this
 * package, so:
 *   - a general viewer's counts NEVER include zone titles (the guard's
 *     content_class clause strips them, same as any other guarded list);
 *   - a restricted-profile viewer's counts exclude the zone BY
 *     CONSTRUCTION, before content_class even enters into it — their
 *     ctx.allowedLibraryIds never contains a restricted library id in the
 *     first place (see src/query/restricted-zone.ts's header for the
 *     ground-truthed entitlement model), so applyGuard's library-
 *     membership clause alone already excludes every zone row.
 *
 * Grouped by item_type (not just library_id) because a single library's
 * catalog_items can span more than one hierarchy depth — a "tv" library
 * holds series + season + episode rows, not just series — and "which
 * item_type is this library's headline count" (movie->'movie',
 * tv->'series', music->'album') is a display decision the CALLER makes
 * (apps/server's libraries.controller.ts), not something this data-layer
 * function should guess by inspecting media_kind itself.
 *
 * `libraryIds` narrows which libraries to bother counting (the caller
 * already has a page of Library rows and only wants counts for those);
 * applyGuard's OWN ctx.allowedLibraryIds check is the actual security
 * boundary regardless of what's passed here — asking for a library id the
 * viewer cannot see yields zero rows for it, never a leaked count.
 */
export async function getLibraryItemCountsForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext,
  libraryIds: string[]
): Promise<LibraryItemCountRow[]> {
  if (libraryIds.length === 0) {
    return [];
  }

  const rows = await applyGuard(
    db.selectFrom('catalog_items').where('library_id', 'in', libraryIds),
    ctx
  )
    .select(['library_id', 'item_type'])
    .select((eb) => eb.fn.countAll().as('count'))
    .groupBy(['library_id', 'item_type'])
    .execute();

  return rows.map((row) => ({
    libraryId: row.library_id,
    itemType: row.item_type,
    count: Number(row.count),
  }));
}

/**
 * Every library's id + root paths, unfiltered by ViewerContext — the
 * storage-pool meter (design/phosphor README Shell spec) needs every
 * library's filesystem footprint regardless of content_class or who's
 * asking, because disk CAPACITY is not catalog content (see this file's
 * top-of-file addendum for why this has no restricted-content leak class
 * to guard against). isAdmin-authorized at the apps/server controller
 * layer, same as this file's other *Admin functions — never called with a
 * ViewerContext because there is no viewer-scoped "how much disk am I
 * allowed to know about" question, mirroring createLibrary's own framing.
 */
export async function listLibraryPathsAdmin(
  db: Kysely<DB>
): Promise<Array<{ id: string; paths: string[] }>> {
  return db.selectFrom('libraries').select(['id', 'paths']).execute();
}
