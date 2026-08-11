// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/plugins-delivery.ts
//
// Loombre Plugin Protocol (LPP) v1, Lane W4 (event-subscriber capability;
// LD13, locked at W1 landing — see STATE.md). Everything the outbox-fanout
// delivery loop (apps/worker/src/plugin-delivery/**) needs from Postgres
// beyond what packages/db/src/query/plugins.ts (Lane W2's capability-
// agnostic registry module) already provides: which enabled plugins hold
// the event-subscriber capability and what event types they're granted,
// where each plugin's delivery cursor currently sits, and the
// transactional writers that advance it. Lives in the PUBLIC barrel
// (src/index.ts), not @loombre/db/internal — same instance-administration-
// facts precedent src/query/plugins.ts's own header documents.
//
// Deliberately does NOT depend on @loombre/plugin-protocol (packages/db
// stays protocol-agnostic, matching LD2's "capability-agnostic core"
// design and packages/db's existing zero dependency on
// packages/contract's event schemas): `manifest` is returned verbatim
// (JSONB, opaque here) and the WORKER extracts the event-subscriber
// capability's `delivery.endpoint` from it — the SAME split
// apps/worker/src/metadata/plugin-provider.ts already uses for the
// metadata-provider capability (that file's `extractMetadataProviderCapability`
// runs worker-side, never here).
//
// Breaker-trip persistence (plugins.enabled/health_state/
// consecutive_failures) is NOT this module's job either — the delivery
// loop calls packages/db/src/query/plugins.ts's REAL setPluginEnabledAndEmit
// / setPluginHealthAndEmit directly, mirroring plugin-provider.ts's
// maybeDisableOnBreakerTrip pattern exactly (LD8: one shared, durable,
// cross-capability breaker signal). This module owns ONLY the W4-specific
// plugin_delivery_cursors table, which is a materially different
// (per-capability, backoff-pacing) counter — see migrations/
// 0016_plugin_delivery_cursors.sql's header for the full split rationale.
//
// Outbox pattern (docs/PLAN.md §4.3): every writer below that changes
// pseudonymization state writes transactionally, matching
// upsertServerSettingAndEmit / insertPluginAndEmit's discipline. Cursor
// advances themselves are NOT outbox-event-worthy (they are host-internal
// bookkeeping a subscriber never observes) — no event is emitted here.

import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { ContentClass, DB, PluginDeliveryCursorsTable } from '../types.js';
import { withTransaction } from '../internal/index.js';

export type PluginDeliveryCursorRow = Selectable<PluginDeliveryCursorsTable>;

export interface EventSubscriberPlugin {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  /** plugins.content_class — the plugin's AGGREGATE scope. Still surfaced
   *  here (admin-facing display, and the H-2 defense-in-depth aggregate
   *  comparison in apps/server/src/plugins/manifest-diff.ts), but H-2 FIX
   *  WAVE: the delivery loop's clearance gate (apps/worker/src/
   *  plugin-delivery/clearance.ts's pluginMayReceiveRestricted) no longer
   *  reads this column — it reads the event-subscriber CAPABILITY entry's
   *  OWN `contentClass` field, parsed straight off `manifest` below, so a
   *  sibling capability's scope can never widen this one's effective
   *  clearance. */
  contentClass: ContentClass;
  grantedCapabilityTypes: readonly string[];
  lanAllowlist: readonly string[];
  /** Verbatim GET /lpp/manifest snapshot (plugins.manifest) — the caller
   *  (apps/worker/src/plugin-delivery/delivery-loop.ts) extracts the
   *  event-subscriber capability's `delivery.endpoint` from this using
   *  @loombre/plugin-protocol's own schema, never parsed here. */
  manifest: Record<string, unknown>;
  /** Non-secret configSchema field values (plugins.config) — M-1 fix wave:
   *  the delivery loop injects this (plus resolved keyring secrets) as
   *  `X-LPP-Config`/`X-LPP-Secret-<NAME>` on every delivery, exactly like
   *  every other plugin call (metadata-provider search/details/images).
   *  Before this fix, event deliveries carried neither header at all —
   *  a break with the frozen W1 contract ("whenever the host calls a
   *  plugin, it resolves that plugin's current config values and injects
   *  them per request"). */
  config: Record<string, unknown>;
  pseudonymizeActorIds: boolean;
  pseudonymSalt: string | null;
  /** Closed set of event `type` strings this plugin currently holds a
   *  plugin_event_grants row for. Never empty — see
   *  listEventSubscriberPlugins's own doc comment. */
  grantedTypes: string[];
}

/**
 * Subscriber listing: every ENABLED plugin that (a) holds the
 * 'event-subscriber' entry in its GRANTED capability types
 * (plugins.granted_capability_types — LD6 "capability set <= declared")
 * and (b) has at least one plugin_event_grants row. A plugin failing
 * either condition is entirely absent from the result — the delivery loop
 * iterates this list and nothing else, so a disabled plugin (including
 * one this loop itself just caused to be disabled via
 * setPluginEnabledAndEmit on a breaker trip) drops out on the very next
 * poll tick with no separate "is it still enabled" re-check needed.
 *
 * Deliberately does NOT validate that `manifest` actually contains a
 * well-formed event-subscriber capability entry (delivery.endpoint) —
 * that is a wire-schema concern the caller validates with
 * @loombre/plugin-protocol (this module has no dependency on that
 * package). A plugin whose granted-but-malformed manifest entry fails
 * that validation is the caller's problem to skip/log, same as
 * createLppMetadataProvider returning null for the analogous
 * metadata-provider case.
 */
export async function listEventSubscriberPlugins(db: Kysely<DB>): Promise<EventSubscriberPlugin[]> {
  const plugins = await db
    .selectFrom('plugins')
    .select([
      'id',
      'name',
      'base_url',
      'enabled',
      'content_class',
      'granted_capability_types',
      'lan_allowlist',
      'manifest',
      'config',
      'pseudonymize_actor_ids',
      'pseudonym_salt',
    ])
    .where('enabled', '=', true)
    // `@>` array-contains via Kysely's typed comparison operator produced
    // a malformed-array-literal error under node-postgres's parameter
    // serialization for this text[] column (verified empirically); the
    // ANY() form below round-trips correctly, same "explicit SQL sidesteps
    // node-postgres's array/jsonb parameter mangling" lesson src/query/
    // settings.ts's header documents for JSONB writes.
    .where(sql<boolean>`'event-subscriber' = ANY(${sql.ref('granted_capability_types')})`)
    .execute();
  if (plugins.length === 0) return [];

  const pluginIds = plugins.map((p) => p.id);
  const grants = await db
    .selectFrom('plugin_event_grants')
    .select(['plugin_id', 'event_type'])
    .where('plugin_id', 'in', pluginIds)
    .execute();

  const grantsByPlugin = new Map<string, string[]>();
  for (const grant of grants) {
    const existing = grantsByPlugin.get(grant.plugin_id);
    if (existing) existing.push(grant.event_type);
    else grantsByPlugin.set(grant.plugin_id, [grant.event_type]);
  }

  const result: EventSubscriberPlugin[] = [];
  for (const p of plugins) {
    const grantedTypes = grantsByPlugin.get(p.id);
    if (!grantedTypes || grantedTypes.length === 0) continue; // no event grants => not a subscriber
    result.push({
      id: p.id,
      name: p.name,
      baseUrl: p.base_url,
      enabled: p.enabled,
      contentClass: p.content_class,
      grantedCapabilityTypes: p.granted_capability_types,
      lanAllowlist: p.lan_allowlist,
      manifest: p.manifest,
      config: p.config,
      pseudonymizeActorIds: p.pseudonymize_actor_ids,
      pseudonymSalt: p.pseudonym_salt,
      grantedTypes,
    });
  }
  return result;
}

export interface PluginCandidateEventRow {
  id: string;
  /** events.seq (migrations/0039_events_seq.sql) — the value the CALLER
   *  must persist as the next cursor_event_seq (see
   *  migrations/0040_plugin_delivery_cursor_seq.sql). `id` remains this
   *  row's opaque identifier (still what a delivered batch carries), but
   *  is no longer what advances the delivery cursor. */
  seq: number;
  type: string;
  tsMs: number;
  payload: Record<string, unknown>;
}

/**
 * Raw (unguarded-by-design) outbox read for the delivery loop: events
 * after `afterSeq` (events.seq — migrations/0039_events_seq.sql) whose
 * `type` is one of `grantedTypes`, ordered by `seq` ascending, capped at
 * `limit`.
 *
 * Keyset on `seq`, NOT `id` (opus-review LD wave, Finding 1 — the real
 * persisted-cursor skip hazard; see migrations/
 * 0040_plugin_delivery_cursor_seq.sql's header for the full mechanism):
 * `id` (UUIDv7) ties on any two events written in the same Postgres clock
 * millisecond and resolves the tie on RANDOM tail bits, uncorrelated with
 * insertion order (migrations/0039_events_seq.sql's header). That is only
 * a same-tick reordering hazard for a STATELESS reader, but this cursor is
 * PERSISTED between poll ticks: a same-millisecond sibling event whose id
 * happens to sort BEFORE the plugin's just-advanced cursor id would never
 * again satisfy `id > afterId` — a silent, PERMANENT skip, not a
 * transient reordering. `seq` is a Postgres identity-sequence value
 * assigned synchronously, in call order, at INSERT time, with no
 * dependence on clock resolution — same-millisecond siblings can never tie
 * on it, so a `seq`-keyed keyset read can never skip one.
 *
 * `minTsMs`, when given, ADDS a `ts_ms >= minTsMs` floor on top of the
 * `seq` keyset — used ONLY by the caller (apps/worker/src/plugin-delivery/
 * delivery-loop.ts) after it has already detected a retention-window gap
 * (findOldestUnconsumedBeforeMs, below) and wants this read to skip
 * straight past the gapped region to the window edge, without discarding
 * or replacing the real `afterSeq` cursor value itself — the gap is
 * reported (delivery-loop.ts's gapReport), never silently absorbed into an
 * advanced cursor.
 *
 * Deliberately NOT clearance-filtered — this is the SAME "system-wide
 * bookkeeping read, filtered per-consumer afterward" shape as
 * readUnprocessedEvents (src/query/events.ts), generalized to a type
 * allowlist + a caller-supplied cursor instead of "unprocessed". The
 * delivery loop (apps/worker/src/plugin-delivery/delivery-loop.ts) is
 * responsible for passing the returned ids through the EXISTING
 * guard-compiled `filterEventsForViewer` before ever delivering to a
 * general-scoped subscriber (C5) — this function does not and must not
 * apply that filter itself, so there is exactly one place
 * (filterEventsForViewer) that ever decides content visibility, per
 * CLAUDE.md invariant 4.
 */
export async function listCandidateEventsForDelivery(
  db: Kysely<DB>,
  input: { afterSeq: number; grantedTypes: readonly string[]; limit: number; minTsMs?: number }
): Promise<PluginCandidateEventRow[]> {
  if (input.grantedTypes.length === 0) return [];
  let query = db
    .selectFrom('events')
    .select(['id', 'seq', 'type', 'ts_ms', 'payload'])
    .where('seq', '>', input.afterSeq)
    .where('type', 'in', input.grantedTypes as string[]);
  if (input.minTsMs !== undefined) {
    query = query.where('ts_ms', '>=', input.minTsMs);
  }
  const rows = await query.orderBy('seq', 'asc').limit(input.limit).execute();
  return rows.map((r) => ({ id: r.id, seq: r.seq, type: r.type, tsMs: r.ts_ms, payload: r.payload }));
}

/**
 * Gap detection (LPP v1 mission §3.2 "retention window; gaps reported
 * never skipped"): the earliest ts_ms, among events of a granted type
 * after `afterId`, that falls strictly before `beforeMs` (the retention-
 * window edge) — i.e. "the oldest event this plugin's grants would have
 * matched that is now further back than the retention window guarantees".
 * `null` means no such event exists (no gap to report), which is
 * deliberately NOT the same thing as "nothing new at all" — see
 * apps/worker/src/plugin-delivery/delivery-loop.ts's header for why this
 * distinction is what keeps an idle-but-caught-up plugin from ever seeing
 * a false-positive gap report.
 */
export async function findOldestUnconsumedBeforeMs(
  db: Kysely<DB>,
  input: { afterId: string; grantedTypes: readonly string[]; beforeMs: number }
): Promise<number | null> {
  if (input.grantedTypes.length === 0) return null;
  const row = await db
    .selectFrom('events')
    .select('ts_ms')
    .where('id', '>', input.afterId)
    .where('type', 'in', input.grantedTypes as string[])
    .where('ts_ms', '<', input.beforeMs)
    // `id` tiebreak on `ts_ms` ties (routine under concurrent load, same
    // "random tail bits, no monotonic fallback" hazard migrations/
    // 0039_events_seq.sql's header documents for events.id): without it,
    // which of several same-ts_ms rows this limit-1 read returns is
    // whatever order Postgres happens to produce, not a deterministic
    // choice. `ts_ms` remains the value actually returned/compared against
    // `beforeMs` — this only makes ROW SELECTION on a tie repeatable.
    .orderBy('ts_ms', 'asc')
    .orderBy('id', 'asc')
    .limit(1)
    .executeTakeFirst();
  return row ? row.ts_ms : null;
}

export async function getDeliveryCursor(
  db: Kysely<DB>,
  pluginId: string
): Promise<PluginDeliveryCursorRow | undefined> {
  return db
    .selectFrom('plugin_delivery_cursors')
    .selectAll()
    .where('plugin_id', '=', pluginId)
    .executeTakeFirst();
}

/**
 * Read-or-mint the plugin's pseudonymization salt (migrations/
 * 0016_plugin_delivery_cursors.sql's plugins.pseudonym_salt column doc
 * comment): random 32-byte value, hex-encoded, minted lazily on first use.
 * `SELECT ... FOR UPDATE` inside the transaction is what makes two racing
 * delivery ticks for the same plugin (should that ever happen — the
 * delivery loop today only ever runs one tick per plugin at a time, but
 * this makes the guarantee true by construction rather than by scheduling
 * discipline) converge on ONE salt rather than each minting and writing
 * their own, the second silently overwriting the first mid-flight.
 */
export async function ensurePseudonymSalt(db: Kysely<DB>, pluginId: string): Promise<string> {
  return withTransaction(db, async (trx) => {
    const row = await trx
      .selectFrom('plugins')
      .select('pseudonym_salt')
      .where('id', '=', pluginId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.pseudonym_salt) return row.pseudonym_salt;

    const salt = randomBytes(32).toString('hex');
    await trx.updateTable('plugins').set({ pseudonym_salt: salt }).where('id', '=', pluginId).execute();
    return salt;
  });
}

/**
 * Cursor-only advance, no delivery stats touched: used when a raw
 * candidate page (listCandidateEventsForDelivery) was non-empty but the
 * EXISTING guard-compiled clearance filter (filterEventsForViewer)
 * dropped every candidate for a general-scoped subscriber (C5 — the whole
 * page happened to be about restricted content). Without this, such a
 * plugin's cursor would never move past that page and the delivery loop
 * would re-fetch and re-filter the identical all-restricted page forever.
 * Deliberately does NOT touch delivered_batches/delivered_events/
 * last_success_ms/consecutive_failures — nothing was delivered and no
 * delivery attempt (HTTP call) was made, so none of the delivery-stats
 * columns describe what happened here.
 */
export async function advanceCursorPastFilteredEvents(
  db: Kysely<DB>,
  input: { pluginId: string; cursorEventId: string; cursorEventSeq: number; nowMs: number }
): Promise<void> {
  await db
    .insertInto('plugin_delivery_cursors')
    .values({
      plugin_id: input.pluginId,
      cursor_event_id: input.cursorEventId,
      cursor_event_seq: input.cursorEventSeq,
      last_attempt_ms: input.nowMs,
      last_success_ms: null,
      consecutive_failures: 0,
      delivered_batches: 0,
      delivered_events: 0,
      gap_reported_through_ms: null,
    })
    .onConflict((oc) =>
      oc.column('plugin_id').doUpdateSet({
        cursor_event_id: input.cursorEventId,
        cursor_event_seq: input.cursorEventSeq,
        last_attempt_ms: input.nowMs,
      })
    )
    .execute();
}

export interface RecordDeliverySuccessInput {
  pluginId: string;
  /** The last (highest, since events are read in ascending SEQ order —
   *  see listCandidateEventsForDelivery) events.id included in the batch
   *  that was just 2xx-acknowledged. Kept for observability/back-compat
   *  (migrations/0040_plugin_delivery_cursor_seq.sql's header) — no longer
   *  what the next read's keyset comparison uses. */
  cursorEventId: string;
  /** The SAME event's events.seq (migrations/0039_events_seq.sql) — this
   *  is what listCandidateEventsForDelivery's `afterSeq` keyset actually
   *  compares against on the next tick. Always written together with
   *  cursorEventId, in the same statement, so the two columns can never
   *  observably disagree about how far this plugin's cursor has advanced. */
  cursorEventSeq: number;
  /** events.length of the acknowledged batch — added to the lifetime
   *  delivered_events counter. */
  deliveredEventCount: number;
  nowMs: number;
  /** Present only when this batch carried a gapReport — advances
   *  gap_reported_through_ms to this value in the SAME transaction as the
   *  cursor advance, so a crash between "batch acknowledged" and "gap
   *  watermark recorded" cannot happen (both or neither commit). Omitted
   *  (or undefined) leaves gap_reported_through_ms unchanged. */
  gapReportedThroughMs?: number;
}

/**
 * Advances a plugin's delivery cursor ONLY with a delivered batch's last
 * event id+seq (never speculatively) and updates the lifetime stats in the
 * SAME transaction/statement — cursor_event_id/cursor_event_seq and
 * delivered_batches/delivered_events can never observably disagree about
 * "how far did this plugin get". Upserts the row (plugin_delivery_cursors
 * has no row until a plugin's first delivery attempt — see that table's
 * COMMENT ON TABLE).
 */
export async function recordDeliverySuccess(
  db: Kysely<DB>,
  input: RecordDeliverySuccessInput
): Promise<PluginDeliveryCursorRow> {
  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('plugin_delivery_cursors')
      .select(['delivered_batches', 'delivered_events', 'gap_reported_through_ms'])
      .where('plugin_id', '=', input.pluginId)
      .forUpdate()
      .executeTakeFirst();

    const nextGapReportedThroughMs =
      input.gapReportedThroughMs !== undefined ? input.gapReportedThroughMs : (existing?.gap_reported_through_ms ?? null);

    return trx
      .insertInto('plugin_delivery_cursors')
      .values({
        plugin_id: input.pluginId,
        cursor_event_id: input.cursorEventId,
        cursor_event_seq: input.cursorEventSeq,
        last_attempt_ms: input.nowMs,
        last_success_ms: input.nowMs,
        consecutive_failures: 0,
        delivered_batches: 1,
        delivered_events: input.deliveredEventCount,
        gap_reported_through_ms: nextGapReportedThroughMs,
      })
      .onConflict((oc) =>
        oc.column('plugin_id').doUpdateSet({
          cursor_event_id: input.cursorEventId,
          cursor_event_seq: input.cursorEventSeq,
          last_attempt_ms: input.nowMs,
          last_success_ms: input.nowMs,
          consecutive_failures: 0,
          delivered_batches: (existing?.delivered_batches ?? 0) + 1,
          delivered_events: (existing?.delivered_events ?? 0) + input.deliveredEventCount,
          gap_reported_through_ms: nextGapReportedThroughMs,
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

export interface RecordDeliveryFailureInput {
  pluginId: string;
  nowMs: number;
}

/**
 * Records a failed delivery attempt (any non-2xx outcome — network,
 * timeout, or an ordinary HTTP error status a misbehaving plugin
 * returned): bumps consecutive_failures and last_attempt_ms, leaves
 * cursor_event_id/last_success_ms untouched. Returns the NEW
 * consecutive_failures count so the caller (the delivery loop) can compute
 * backoff pacing without a second read. Deliberately separate from
 * plugins.consecutive_failures — see this module's header.
 */
export async function recordDeliveryFailure(
  db: Kysely<DB>,
  input: RecordDeliveryFailureInput
): Promise<{ consecutiveFailures: number }> {
  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('plugin_delivery_cursors')
      .select('consecutive_failures')
      .where('plugin_id', '=', input.pluginId)
      .forUpdate()
      .executeTakeFirst();
    const consecutiveFailures = (existing?.consecutive_failures ?? 0) + 1;

    await trx
      .insertInto('plugin_delivery_cursors')
      .values({
        plugin_id: input.pluginId,
        cursor_event_id: null,
        cursor_event_seq: null,
        last_attempt_ms: input.nowMs,
        last_success_ms: null,
        consecutive_failures: consecutiveFailures,
        delivered_batches: 0,
        delivered_events: 0,
        gap_reported_through_ms: null,
      })
      .onConflict((oc) =>
        oc.column('plugin_id').doUpdateSet({
          last_attempt_ms: input.nowMs,
          consecutive_failures: consecutiveFailures,
        })
      )
      .execute();

    return { consecutiveFailures };
  });
}
