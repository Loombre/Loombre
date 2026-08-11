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
// Cursor / ordering (Task #9 resolution — see migrations/0039_events_seq.sql
// for the underlying defect this fixes): every read below orders by
// `events.seq`, NOT `events.id`. UUIDv7's layout (48-bit big-endian
// unix_ts_ms in the leading bytes, migrations/0001_init.sql's
// loombre_uuidv7()) gives a STABLE, UNIQUE total order, but NOT insertion
// order: only the leading 48 timestamp bits are ordered by clock; every
// remaining bit is plain `random()` with no monotonic-counter fallback, so
// two ids stamped in the same Postgres clock millisecond sort by those
// random tail bits, not by which INSERT actually ran first. `seq`
// (migrations/0039_events_seq.sql) is a Postgres identity-sequence column
// instead — assigned synchronously in call order, never tied, with no
// dependence on any clock — so `ORDER BY seq` is a real guaranteed
// insertion-order total order for rows written after that migration ran.
//
// This was previously deferred (an earlier version of this file's header
// stated the `id -> seq` switch was withheld because "it changes the
// cursor token's semantics for every already-connected client"). Evidence
// gathered resolving that deferral (STATE.md task #9):
//   - readEventsForViewer's `afterId` cursor (now `afterSeq`, see below)
//     has NO production caller anywhere in the codebase — no HTTP-polling
//     endpoint exists (no `/v1/events`-shaped path in
//     packages/contract/openapi.yaml), the websocket layer does not call
//     this function, and the web client (apps/web/src/lib/events-socket.ts)
//     holds no cursor state at all, sends nothing back to the server on
//     reconnect, and simply resumes live-tail from connection time. The
//     ONLY callers found were two tests (packages/db/test/leak.spec.ts)
//     passing a hardcoded epoch-zero boundary constant. There is therefore
//     no external contract for an `id`-shaped cursor token to preserve —
//     changing its shape/semantics breaks nothing live.
//   - readUnprocessedEvents has no cursor at all (stateless `WHERE
//     processed_at_ms IS NULL` poll every tick, apps/server/src/gateway/
//     ws-broadcaster.service.ts's poll()) — its `ORDER BY` only decides (a)
//     which N rows a tick picks when more than POLL_BATCH_SIZE are
//     pending, and (b) indirectly, the order the SAME tick's
//     filterEventsForViewer(db, ctx, ids) re-selects and the broadcaster
//     iterates for `ws.send()` — i.e. same-millisecond sibling events (e.g.
//     playback.started/playback.ended landing in one 500ms poll window)
//     could reach a live socket in an order that does not match true
//     insertion order. filterEventsForViewer runs its own fresh SELECT
//     with its own ORDER BY (it does not preserve readUnprocessedEvents'
//     row order), so BOTH functions' orderings must move together for the
//     fix to actually reach the observable websocket delivery sequence —
//     switching only one would leave the hazard live in production.
// Given both, switching all three (readEventsForViewer, filterEventsForViewer,
// readUnprocessedEvents) to `seq` is safe (nothing external depends on the
// prior `id` ordering or the `afterId` token shape) and fixes the real
// same-millisecond skip/misorder hazard for what, AT THE TIME this migration
// landed, was the ONE path with an actual production caller (the websocket
// broadcaster). That is no longer the full picture: opus-review LD wave
// Finding 1 identified a SECOND production caller carrying the identical
// hazard in a materially worse form — packages/db/src/query/
// plugins-delivery.ts's listCandidateEventsForDelivery, whose `afterId`
// cursor is PERSISTED (plugin_delivery_cursors.cursor_event_id) rather than
// re-derived every tick, so a same-millisecond sibling sorting before an
// already-advanced cursor was not a same-tick reordering nuisance but a
// silent, PERMANENT skip. Migration 0040 (migrations/
// 0040_plugin_delivery_cursor_seq.sql) gave that table its own `seq`
// tie-break and switched that read the same way this migration switched
// the three functions below — see that migration's header and
// apps/worker/src/plugin-delivery/delivery-loop.ts's for the full fix.
//
// One-time upgrade artifact this migration itself creates, independent of
// the plugin-delivery fix above: any `events` row still unprocessed
// (processed_at_ms IS NULL) at the moment 0039 runs gets its `seq`
// assigned in physical heap-scan backfill order (this migration's own
// header), not true insertion order — so the very first post-upgrade
// readUnprocessedEvents tick can drain that specific backlog in an order
// that does not match when those rows were originally written. Bounded (at
// most however many rows were mid-flight through the broadcaster's
// `WHERE processed_at_ms IS NULL` poll at upgrade time — normally zero,
// since the broadcaster drains continuously) and strictly no worse than
// pre-migration behavior (`ORDER BY id`, which had this exact same
// same-millisecond-tie weakness unconditionally, forever, not just for one
// upgrade tick) — not a regression, just not yet the FULL guarantee this
// migration establishes going forward.
//
// `id` remains every function's opaque row identifier (selectAll() below
// still returns it, and it's still what the client sees in the envelope)
// — only the ORDER BY / cursor-comparison column changed, per
// packages/db/src/query/cursor.ts's header ("UUIDv7 secondary keys give
// stable pagination but not causal order on same-ms ties; events.seq is
// the pattern when causal order matters").

import { sql, type Expression, type ExpressionBuilder, type Kysely, type Selectable, type SqlBool } from 'kysely';
import type { DB, EventsTable } from '../types.js';
import type { ViewerContext } from '../context.js';
import { applyContentClassFilter, applyGuardToJoined, applyLibraryIdFilter } from './guard.js';
import { MalformedCursorError } from './cursor.js';

export type EventRow = Selectable<EventsTable>;

export interface ReadEventsForViewerParams {
  /** Cursor: rows with `events.seq` strictly greater than this value
   *  (migrations/0039_events_seq.sql) — NOT an events.id. Omit for "from
   *  the beginning". See this module's header for why `seq`, not `id`. */
  afterSeq?: number;
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
  if (params.afterSeq !== undefined) {
    // AUD-W4-001 (audit fafa47f): the ORIGINAL finding was a raw `afterId`
    // string bound into a `uuid` column comparison (Postgres 22P02 -> an
    // unhandled 500 for a client input mistake). Task #9's afterId->afterSeq
    // switch moved the comparison to the `seq` bigint column, but carried
    // NO validation of its own — a non-finite/non-integer/negative value
    // hits the exact same defect class one type down (bigint cast error,
    // not uuid). Same house fix as every other cursor validator in this
    // package: malformed input is MalformedCursorError (apps/server maps
    // it to an RFC 9457 400), never a raw 500 or a silent full scan.
    if (!Number.isInteger(params.afterSeq) || params.afterSeq < 0) {
      throw new MalformedCursorError('malformed cursor: afterSeq must be a non-negative integer');
    }
    query = query.where('events.seq', '>', params.afterSeq);
  }

  query = query.where(eventVisibilityWhere(ctx));

  return query.selectAll().orderBy('events.seq', 'asc').limit(limit).execute();
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
 * visibility rules a second time anywhere. Ordered by `seq`, not `id` (this
 * module's header): apps/server/src/gateway/ws-broadcaster.service.ts
 * iterates this function's return value directly to decide the SEQUENCE it
 * `ws.send()`s survivors in, so this is the ordering that actually reaches
 * a live client — same-millisecond siblings (e.g. playback.started/
 * playback.ended from one transition) must reach the socket in true
 * insertion order, which `id` cannot guarantee and `seq` can.
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
    .orderBy('events.seq', 'asc')
    .execute();
}

/**
 * Outbox drain read (docs/PLAN.md §4.3) — UNGUARDED by design: this is
 * system-wide broadcaster bookkeeping ("which rows has nobody looked at
 * yet"), not a viewer-facing catalog read; every row it returns is later
 * filtered per-socket by filterEventsForViewer above before ever reaching
 * a client. Single-process v1 (mission spec): one poller drains the whole
 * outbox — see markEventsProcessed's doc comment for what "drained" means
 * across multiple server processes (out of scope this wave). Ordered by
 * `seq`, not `id` (this module's header): when more than `limit` rows are
 * pending, `seq` picks the truly-oldest N by insertion order rather than a
 * same-millisecond coin flip.
 */
export async function readUnprocessedEvents(db: Kysely<DB>, limit = 100): Promise<EventRow[]> {
  return db
    .selectFrom('events')
    .where('processed_at_ms', 'is', null)
    .selectAll()
    .orderBy('seq', 'asc')
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
