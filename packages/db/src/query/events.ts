// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/events.ts
//
// readEventsForViewer — the QUERY-LAYER half of leak todo 7 ("events/
// outbox payloads about restricted items are not delivered to sessions
// failing gate 5"). The websocket delivery layer (subscribing a live
// session to /v1/events and pushing envelopes as they're written) is a
// NEXT-WAVE deliverable outside packages/db's surface (apps/server); what
// belongs here, and what this function is, is the filter that layer will
// need: given a ViewerContext and a cursor, which rows of the events
// outbox table is this viewer currently allowed to know about at all.
// Socket-delivery tests (subscription lifecycle, backpressure, at-least-
// once delivery) are explicitly out of scope for this wave — only the
// visibility predicate is tested here (packages/db/test/leak.spec.ts).
//
// Per-event-type visibility, driven by what each payload schema
// (packages/contract/event-schemas/*.schema.json) actually carries. EVERY
// gated branch resolves against LIVE state (a join to the current
// catalog_items/libraries row), never a value snapshotted into the payload
// at emission time — an item or library could have been reclassified since
// the event was written, and delivering a stale-'general' snapshot to an
// uncleared viewer after a general→restricted reclassification would be an
// existence leak (flagged by two independent Wave-4 adversarial reviews;
// latent today because no path reclassifies content_class, closed here so
// it stays closed when a reclassify path lands in Phase 2+):
//
//   - item.added / item.updated / file.relocated / playback.started /
//     playback.ended / playback.progress / progress.updated: payload
//     carries itemId — applyGuardToJoined against the CURRENT catalog_items
//     guard (library membership + live content_class + missing-file, all
//     compiled in).
//   - scan.started / scan.completed / library.created: payload carries
//     libraryId only — a live join to `libraries` for its CURRENT
//     content_class, via applyLibraryIdFilter + applyContentClassFilter
//     (the library-table analogue of the item guard).
//   - restricted.locked / restricted.unlocked (STATE.md P2.8): payload
//     carries userId only, no item/library association at all — these are
//     PRIVATE to the subject user, gated on `payload->>'userId' = ctx.userId`
//     rather than any content-visibility rule. A user's own lock/unlock
//     transitions are never broadcast to anyone else, cleared or not.
//   - everything else (user.created, and any future type not in the three
//     lists below): passes through unfiltered — it carries no item/library/
//     user association to gate on (task spec: "non-item events pass
//     through"). notice.published / notice.cancelled (STATE.md "Admin
//     broadcast notifications — system notices", N2/NG1) are deliberately
//     LEFT UNBUCKETED here, same as user.created — they are all-user
//     broadcast by definition (every notice is meant for every
//     authenticated viewer, not scoped to any item/library/user), so the
//     fallthrough is correct, not an oversight.
//
// Cursor: `afterId` is a raw events.id (UUIDv7) — `WHERE id > afterId`,
// ordered by id ascending. UUIDv7's layout (48-bit big-endian unix_ts_ms in
// the leading bytes, migrations/0001_init.sql's loombre_uuidv7()) gives a
// STABLE, UNIQUE total order, but NOT insertion order: only the leading
// 48 timestamp bits are ordered by clock; every remaining bit is plain
// `random()` with no monotonic-counter fallback, so two ids stamped in the
// same Postgres clock millisecond sort by those random tail bits, not by
// which INSERT actually ran first (migrations/0039_events_seq.sql's header
// has the full analysis — this exact claim, stated here as fact in an
// earlier version of this file, is what that migration disproves). The
// practical effect on this keyset cursor: a same-millisecond sibling can
// sort BEFORE `afterId` despite being inserted after it, so a client
// polling with this cursor can skip that sibling forever. That hazard is
// real, but fixing it here is deliberately deferred (STATE.md open item,
// task #9) — migration 0039 added `events.seq` as the column that carries
// the actual guaranteed insertion order, and switching readEventsForViewer
// / readUnprocessedEvents to cursor on `seq` instead of `id` is the fix,
// but it changes the cursor token's semantics for every already-connected
// client (a `seq`-based cursor is not interchangeable with an `id`-based
// one), so it is being done as its own reviewed change rather than folded
// in here. The queries below still `ORDER BY id` unchanged.

import { sql, type Expression, type ExpressionBuilder, type Kysely, type Selectable, type SqlBool } from 'kysely';
import type { DB, EventsTable } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyGuardToJoined, applyLibraryIdFilter } from './guard.js';

export type EventRow = Selectable<EventsTable>;

export interface ReadEventsForViewerParams {
  afterId?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;

// Live-join gated by libraryId (payload carries no itemId).
const LIBRARY_ONLY_TYPES = ['scan.started', 'scan.completed', 'library.created'] as const;
// Live-join gated by the item guard (payload carries itemId).
const ITEM_ONLY_TYPES = [
  'item.added',
  'item.updated',
  'file.relocated',
  'playback.started',
  'playback.ended',
  'playback.progress',
  'progress.updated',
] as const;
// Private to the subject user (payload carries userId, no item/library
// association) — STATE.md P2.8. Gated on payload->>'userId' = ctx.userId,
// never delivered to any other viewer regardless of clearance.
//
// watchlist.added/watchlist.removed (Phosphor Wave 2 lane L3): the SAME
// USER_ONLY_TYPES delivery restricted.locked/unlocked already established —
// payload carries {userId, itemId}, gated on payload->>'userId' =
// ctx.userId. This is deliberately NOT itemId-guarded the way item.added/
// item.updated are (ITEM_ONLY_TYPES below): a watchlist change is private to
// the owning user regardless of who else can see the underlying item — two
// different users who both have a general movie in their respective
// watchlists must each learn only about their OWN add/remove, never each
// other's, which an item-visibility guard alone would not enforce (both
// users' contexts clear the same general item). This is also the
// mechanism design/phosphor README.md's "Shared client state: watchlist ...
// must sync across devices via the events socket" requires — every one of
// the SAME user's own connected sockets (every signed-in device/tab)
// receives it, ws-broadcaster.service.ts's per-socket userId match.
const USER_ONLY_TYPES = [
  'restricted.locked',
  'restricted.unlocked',
  'watchlist.added',
  'watchlist.removed',
] as const;

const GATED_TYPES: readonly string[] = [...LIBRARY_ONLY_TYPES, ...ITEM_ONLY_TYPES, ...USER_ONLY_TYPES];

// Extracted so readEventsForViewer (cursor-paginated) and
// filterEventsForViewer (id-set-scoped, added for the websocket
// broadcaster — see below) apply IDENTICAL visibility rules and can never
// drift apart; `eb` is the expression builder from whichever query calls
// this (both callers build over the same `events` table).
function eventVisibilityWhere(ctx: ViewerContext) {
  return (eb: ExpressionBuilder<DB, 'events'>): Expression<SqlBool> =>
    eb.or([
      eb('events.type', 'not in', GATED_TYPES),

      eb.and([
        eb('events.type', 'in', [...LIBRARY_ONLY_TYPES]),
        eb.exists(
          applyContentClassFilter(
            applyLibraryIdFilter(
              eb.selectFrom('libraries').select('libraries.id'),
              ctx,
              'libraries.id'
            ),
            ctx,
            'libraries.content_class'
          ).whereRef(
            'libraries.id',
            '=',
            sql<string>`(${sql.ref('events.payload')}->>'libraryId')::uuid`
          )
        ),
      ]),

      eb.and([
        eb('events.type', 'in', [...ITEM_ONLY_TYPES]),
        applyGuardToJoined(ctx, sql<string>`(${sql.ref('events.payload')}->>'itemId')::uuid`),
      ]),

      eb.and([
        eb('events.type', 'in', [...USER_ONLY_TYPES]),
        eb(
          sql<string>`(${sql.ref('events.payload')}->>'userId')`,
          '=',
          ctx.userId
        ),
      ]),
    ]);
}

export async function readEventsForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext,
  params: ReadEventsForViewerParams = {}
): Promise<EventRow[]> {
  const limit = params.limit ?? DEFAULT_LIMIT;

  let query = db.selectFrom('events');
  if (params.afterId) {
    query = query.where('events.id', '>', params.afterId);
  }

  query = query.where(eventVisibilityWhere(ctx));

  return query.selectAll().orderBy('events.id', 'asc').limit(limit).execute();
}

// ============================================================================
// Websocket broadcaster support (P1.17 deliverable H — the DELIVERY half of
// leak todo 7; readEventsForViewer above was always documented as "the
// query-layer half", this is the rest of it, still query-layer: the socket
// lifecycle/polling loop itself lives in apps/server/src/gateway, which
// cannot import pg/kysely per CLAUDE.md invariant 4).
// ============================================================================

/**
 * `id IN (...)`-scoped analogue of readEventsForViewer, built from the
 * IDENTICAL eventVisibilityWhere() predicate — used by the broadcaster to
 * ask "of THIS already-polled outbox batch, which rows may THIS socket's
 * (freshly re-resolved) ViewerContext see" without re-deriving the
 * visibility rules a second time anywhere.
 */
export async function filterEventsForViewer(
  db: Kysely<DB>,
  ctx: ViewerContext,
  ids: readonly string[]
): Promise<EventRow[]> {
  if (ids.length === 0) return [];
  return db
    .selectFrom('events')
    .where('events.id', 'in', ids as string[])
    .where(eventVisibilityWhere(ctx))
    .selectAll()
    .orderBy('events.id', 'asc')
    .execute();
}

/**
 * Outbox drain read (docs/PLAN.md §4.3) — UNGUARDED by design: this is
 * system-wide broadcaster bookkeeping ("which rows has nobody looked at
 * yet"), not a viewer-facing catalog read; every row it returns is later
 * filtered per-socket by filterEventsForViewer above before ever reaching
 * a client. Single-process v1 (mission spec): one poller drains the whole
 * outbox — see markEventsProcessed's doc comment for what "drained" means
 * across multiple server processes (out of scope this wave).
 */
export async function readUnprocessedEvents(db: Kysely<DB>, limit = 100): Promise<EventRow[]> {
  return db
    .selectFrom('events')
    .where('processed_at_ms', 'is', null)
    .selectAll()
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
}

/**
 * Marks a batch of outbox rows processed. Single-process v1 (mission
 * spec): the broadcaster calls this once per poll tick, after every
 * currently-connected socket has had a chance to receive whatever it's
 * cleared to see from that batch — NOT per-consumer, so a socket that
 * connects AFTER a batch is marked processed will never see it (documented
 * limitation of the v1 model: this is a live-tail broadcast, not a durable
 * per-client offset log; a client that was disconnected during a window
 * misses events from that window, same as any at-least-once-to-currently-
 * connected-sockets-only broadcaster).
 */
export async function markEventsProcessed(
  db: Kysely<DB>,
  ids: readonly string[],
  processedAtMs: number
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable('events')
    .set({ processed_at_ms: processedAtMs })
    .where('id', 'in', ids as string[])
    .execute();
}
