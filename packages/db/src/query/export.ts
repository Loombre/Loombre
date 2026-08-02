// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/export.ts
//
// exportData — docs/PLAN.md §8.4 "Data freedom": libraries, items (incl.
// provider ids + the CALLER's own progress), and — admin-only — the user
// list sans secrets. Leak todo 8: "data export / scrobble surfaces exclude
// restricted items for uncleared viewers" — EVERY collection here is
// guarded the same way every other read surface in this wave is:
//   - libraries: applyLibraryIdFilter + applyContentClassFilter directly
//     on the `libraries` table (a restricted library a viewer merely holds
//     gate-4 permission on, but hasn't live-unlocked, must not appear in
//     an export any more than it appears in library.created events or
//     images.entity_type='library' access — see src/query/images.ts's
//     "DECISION BEYOND SPEC" note for the same reasoning applied there).
//   - items: listItems() itself (applyGuard, unmodified) — the export's
//     item collection cannot drift from every other item listing's
//     visibility rules because it IS that same function, paged internally.
//   - progress: scoped to `ctx.userId` only, same as listProgress — this
//     function does not (and structurally cannot, since libraries/items
//     are guard-filtered before progress is even looked up) export another
//     user's progress or any progress row for an item the export has
//     already excluded.
//
// Admin check: ViewerContext carries no isAdmin flag (it is scoped to
// what the query-guard needs: userId, allowedLibraryIds, restrictedCleared
// — see src/context.ts). Users.is_admin is looked up via the identity
// layer's getUserById() for this one purpose.
//
// Shape: an async generator (`AsyncGenerator<ExportChunk>`), not a single
// assembled object — the task spec calls for a "stream-friendly shape" and
// items are paged internally (EXPORT_PAGE_SIZE-row pages via listItems's
// own cursor) rather than loaded all at once, so a caller (the future
// export endpoint / streaming response writer) can start emitting output
// before the whole catalog has been read into memory, and large catalogs
// never require an unbounded in-process array.

import type { Kysely } from 'kysely';
import type { ContentClass, DB, ItemType, MediaKind, WatchState } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyLibraryIdFilter } from './guard.js';
import { listItems } from './items.js';
import { getUserById } from './identity.js';

export interface ExportLibraryRow {
  id: string;
  name: string;
  mediaKind: MediaKind;
  contentClass: ContentClass;
  paths: string[];
  createdAtMs: number;
}

export interface ExportProviderId {
  provider: string;
  externalId: string;
}

export interface ExportProgress {
  positionMs: number;
  state: WatchState;
  playCount: number;
  updatedAtMs: number;
}

export interface ExportItemRow {
  id: string;
  libraryId: string;
  itemType: ItemType;
  title: string;
  sortTitle: string;
  year: number | null;
  contentClass: ContentClass;
  addedAtMs: number;
  providerIds: ExportProviderId[];
  /** This viewer's own progress on the item, or null. Never another
   *  user's — see module header. */
  progress: ExportProgress | null;
}

export interface ExportUserRow {
  id: string;
  username: string;
  /** M1: nullable — an email-less user exports/imports with `email: null`. */
  email: string | null;
  /** M2: nullable — carried through the archive round trip like every
   *  other user field (E4 archive check). */
  displayName: string | null;
  isAdmin: boolean;
  createdAtMs: number;
}

export type ExportChunk =
  | { kind: 'library'; library: ExportLibraryRow }
  | { kind: 'item'; item: ExportItemRow }
  | { kind: 'user'; user: ExportUserRow };

const EXPORT_ITEM_PAGE_SIZE = 200;

export async function* exportData(
  db: Kysely<DB>,
  ctx: ViewerContext
): AsyncGenerator<ExportChunk, void, unknown> {
  const libraries = await applyContentClassFilter(
    applyLibraryIdFilter(db.selectFrom('libraries'), ctx, 'libraries.id'),
    ctx,
    'libraries.content_class'
  )
    .selectAll()
    .execute();

  for (const lib of libraries) {
    yield {
      kind: 'library',
      library: {
        id: lib.id,
        name: lib.name,
        mediaKind: lib.media_kind,
        contentClass: lib.content_class,
        paths: lib.paths,
        createdAtMs: lib.created_at_ms,
      },
    };
  }

  let cursor: string | undefined;
  do {
    // exactOptionalPropertyTypes (tsconfig.base.json) forbids explicitly
    // assigning a `string | undefined` value into an optional `cursor?:
    // string` property — the object literal must either omit the key
    // entirely or supply a definite string, hence the conditional spread
    // rather than `{ cursor, limit: ... }`.
    const page = await listItems(db, ctx, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: EXPORT_ITEM_PAGE_SIZE,
    });

    for (const row of page.rows) {
      const providerIdRows = await db
        .selectFrom('provider_ids')
        .select(['provider', 'external_id'])
        .where('item_id', '=', row.id)
        .execute();

      const progressRow = await db
        .selectFrom('progress')
        .select(['position_ms', 'state', 'play_count', 'updated_at_ms'])
        .where('user_id', '=', ctx.userId)
        .where('item_id', '=', row.id)
        .executeTakeFirst();

      yield {
        kind: 'item',
        item: {
          id: row.id,
          libraryId: row.library_id,
          itemType: row.item_type,
          title: row.title,
          sortTitle: row.sort_title,
          year: row.year,
          contentClass: row.content_class,
          addedAtMs: row.added_at_ms,
          providerIds: providerIdRows.map((p) => ({ provider: p.provider, externalId: p.external_id })),
          progress: progressRow
            ? {
                positionMs: progressRow.position_ms,
                state: progressRow.state,
                playCount: progressRow.play_count,
                updatedAtMs: progressRow.updated_at_ms,
              }
            : null,
        },
      };
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const viewer = await getUserById(db, ctx.userId);
  if (viewer?.is_admin) {
    const users = await db
      .selectFrom('users')
      .select(['id', 'username', 'email', 'display_name', 'is_admin', 'created_at_ms'])
      .execute();

    for (const u of users) {
      yield {
        kind: 'user',
        user: {
          id: u.id,
          username: u.username,
          email: u.email,
          displayName: u.display_name,
          isAdmin: u.is_admin,
          createdAtMs: u.created_at_ms,
        },
      };
    }
  }
}
