// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/plugins.ts
//
// LPP v1 (packages/plugin-protocol/spec/lpp-v1.md) registry reads/writes —
// migrations/0014_plugins.sql. Lives in the PUBLIC barrel (src/index.ts),
// not @loombre/db/internal, for the SAME reason src/query/settings.ts does
// (that file's header): apps/server (the only caller — Lane W2's
// apps/server/src/plugins/*.service.ts) is fenced off from the internal
// subpath by dependency-cruiser's "no-internal-db-outside-worker" rule, and
// `plugins`/`plugin_event_grants` are instance-administration facts, not
// viewer-scoped catalog_items reads — no ViewerContext guard applies here,
// same P1.14 precedent identity.ts/libraries.ts's admin-surface functions
// already establish.
//
// Outbox pattern (docs/PLAN.md §4.3), replicated from
// upsertServerSettingAndEmit (src/query/settings.ts) verbatim: every
// mutating function below writes its row change AND its matching
// packages/contract/event-schemas/plugin.*.schema.json event in ONE
// transaction, so an event can never desync from what was actually
// persisted. This is also what keeps depcruise's internal-writeEvent rule
// intact (LD4) — apps/server/plugin-host never import @loombre/db/internal
// directly, they call through these exported helpers instead.
//
// JSONB write note (manifest/config columns): written via
// `sql\`${json}::jsonb\`` rather than handed to Kysely as a plain JS value,
// for the exact reason src/query/settings.ts's header documents at length
// (node-postgres's default parameter serialization mangles a bare JS
// array/string against a jsonb column). `lan_allowlist`/
// `granted_capability_types` are native TEXT[] columns, not JSONB — plain
// JS string arrays round-trip correctly there (see src/query/libraries.ts's
// `paths` column for the existing precedent).
//
// Payload shapes below match packages/contract/event-schemas/plugin.*
// exactly and NEVER carry a secret or a full manifest snapshot (LD1/LD4/
// LD9) — only pluginId/name + the specific old/new fields each event type's
// schema declares. plugin.disabled(reason:'breaker') and
// plugin.health-changed are the two SYSTEM-originated cases (no human
// actor): both pass `actorUserId: null` to writeEvent, matching
// events.actor_user_id's existing nullable "system-originated" convention
// (envelope.schema.json's own actorUserId doc comment).

import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  ContentClass,
  DB,
  PluginDisabledReason,
  PluginEventGrantsTable,
  PluginHealthState,
  PluginsTable,
} from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';

export type PluginRow = Selectable<PluginsTable>;
export type PluginEventGrantRow = Selectable<PluginEventGrantsTable>;

// ============================================================================
// reads
// ============================================================================

export async function listPlugins(db: Kysely<DB>): Promise<PluginRow[]> {
  return db.selectFrom('plugins').selectAll().orderBy('created_at_ms', 'asc').execute();
}

export async function getPluginById(db: Kysely<DB>, id: string): Promise<PluginRow | undefined> {
  return db.selectFrom('plugins').selectAll().where('id', '=', id).executeTakeFirst();
}

/** UNIQUE column — at most one row. Used by the registration service to
 *  detect "this endpoint is already registered" before deciding between a
 *  fresh insert and a re-approval flow. */
export async function getPluginByBaseUrl(db: Kysely<DB>, baseUrl: string): Promise<PluginRow | undefined> {
  return db.selectFrom('plugins').selectAll().where('base_url', '=', baseUrl).executeTakeFirst();
}

export async function getPluginEventGrants(db: Kysely<DB>, pluginId: string): Promise<PluginEventGrantRow[]> {
  return db
    .selectFrom('plugin_event_grants')
    .selectAll()
    .where('plugin_id', '=', pluginId)
    .orderBy('event_type', 'asc')
    .execute();
}

// ============================================================================
// registration (LD6) — insertPluginAndEmit
// ============================================================================

export interface RegisterPluginInput {
  /** Caller-generated UUIDv7 (packages/shared's uuidv7()) — supplied
   *  explicitly rather than left to the column's DEFAULT loombre_uuidv7()
   *  because the calling service (apps/server/src/plugins/
   *  plugin-registration.service.ts) needs the id BEFORE this row exists,
   *  to name this plugin's keyring entries (LD1: `plugin-hmac-<pluginId>`,
   *  `plugin-<pluginId>-<fieldName>`) and mint the HMAC secret prior to
   *  committing the row — mirrors src/internal/import-users.ts's
   *  insertUserWithId / src/internal/libraries.ts's insertLibraryWithId
   *  id-preserving-insert precedent. */
  id: string;
  name: string;
  baseUrl: string;
  version: string;
  protocolVersion: number;
  contentClass: ContentClass;
  /** LD6 "capability set <= declared" — the manifest-declared capability
   *  `type` values the admin actually approved. */
  grantedCapabilityTypes: string[];
  /** LD6 "event grants <= requested" — empty when no event-subscriber
   *  capability was granted. */
  eventTypes: string[];
  lanAllowlist: string[];
  manifest: Record<string, unknown>;
  /** Non-secret configSchema field values only (LD1) — the caller has
   *  already split secret fields out to the keyring before calling this. */
  config: Record<string, unknown>;
  actorUserId: string;
  nowMs: number;
}

export interface PluginWithGrants {
  plugin: PluginRow;
  eventGrants: PluginEventGrantRow[];
}

export async function insertPluginAndEmit(db: Kysely<DB>, input: RegisterPluginInput): Promise<PluginWithGrants> {
  return withTransaction(db, async (trx) => {
    const manifestJson = JSON.stringify(input.manifest);
    const configJson = JSON.stringify(input.config);

    const plugin = await trx
      .insertInto('plugins')
      .values({
        id: input.id,
        name: input.name,
        base_url: input.baseUrl,
        version: input.version,
        protocol_version: input.protocolVersion,
        content_class: input.contentClass,
        granted_capability_types: input.grantedCapabilityTypes,
        lan_allowlist: input.lanAllowlist,
        manifest: sql`${manifestJson}::jsonb`,
        config: sql`${configJson}::jsonb`,
        created_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
        approved_at_ms: input.nowMs,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const eventGrants: PluginEventGrantRow[] = [];
    for (const eventType of input.eventTypes) {
      eventGrants.push(
        await trx
          .insertInto('plugin_event_grants')
          .values({ plugin_id: plugin.id, event_type: eventType, granted_at_ms: input.nowMs })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    }

    // Payload matches packages/contract/event-schemas/plugin.registered.schema.json.
    await writeEvent(trx, {
      type: 'plugin.registered',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        pluginId: plugin.id,
        name: plugin.name,
        baseUrl: plugin.base_url,
        contentClass: plugin.content_class,
        grantedCapabilityTypes: plugin.granted_capability_types,
        eventTypes: input.eventTypes,
        registeredAtMs: input.nowMs,
      },
    });

    return { plugin, eventGrants };
  });
}

// ============================================================================
// non-expanding re-fetch snapshot update (LD6) — updatePluginManifestAndEmit
// ============================================================================

export interface UpdatePluginManifestInput {
  pluginId: string;
  manifest: Record<string, unknown>;
  version: string;
  protocolVersion: number;
  /** Recomputed by the caller (apps/server/src/plugins/
   *  plugin-registration.service.ts's refresh flow) against the NEW
   *  manifest — for a genuinely non-expanding refresh this is either
   *  unchanged or NARROWED (e.g. a capability type the plugin dropped
   *  entirely is removed from the granted set too) — an EXPANSION never
   *  reaches this function, see reapprovePluginAndEmit instead. */
  contentClass: ContentClass;
  grantedCapabilityTypes: string[];
  /** Full REPLACEMENT set (existing plugin_event_grants rows are deleted
   *  and re-inserted), same convention as reapprovePluginAndEmit. */
  eventTypes: string[];
  /** null for a system-triggered refresh (e.g. a scheduled re-check with no
   *  admin in the loop); a human actor when an admin explicitly asked for
   *  a re-fetch. */
  actorUserId: string | null;
  nowMs: number;
}

export async function updatePluginManifestAndEmit(db: Kysely<DB>, input: UpdatePluginManifestInput): Promise<PluginWithGrants> {
  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('plugins')
      .select(['name', 'version'])
      .where('id', '=', input.pluginId)
      .executeTakeFirstOrThrow();

    const manifestJson = JSON.stringify(input.manifest);
    const row = await trx
      .updateTable('plugins')
      .set({
        manifest: sql`${manifestJson}::jsonb`,
        version: input.version,
        protocol_version: input.protocolVersion,
        content_class: input.contentClass,
        granted_capability_types: input.grantedCapabilityTypes,
        updated_at_ms: input.nowMs,
      })
      .where('id', '=', input.pluginId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx.deleteFrom('plugin_event_grants').where('plugin_id', '=', input.pluginId).execute();
    const eventGrants: PluginEventGrantRow[] = [];
    for (const eventType of input.eventTypes) {
      eventGrants.push(
        await trx
          .insertInto('plugin_event_grants')
          .values({ plugin_id: row.id, event_type: eventType, granted_at_ms: input.nowMs })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    }

    // Payload matches packages/contract/event-schemas/plugin.updated.schema.json.
    // oldValue/newValue here are the plugin's own manifest `version` string
    // (NEVER the manifest itself, per LD4).
    await writeEvent(trx, {
      type: 'plugin.updated',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        pluginId: row.id,
        name: row.name,
        change: 'manifest',
        oldValue: existing.version,
        newValue: row.version,
        updatedAtMs: input.nowMs,
      },
    });

    return { plugin: row, eventGrants };
  });
}

// ============================================================================
// non-secret config update — updatePluginConfigAndEmit
// ============================================================================

export interface UpdatePluginConfigInput {
  pluginId: string;
  /** Non-secret configSchema field values only — already validated/split by
   *  the caller (secret fields never reach this function, LD1). */
  config: Record<string, unknown>;
  actorUserId: string;
  nowMs: number;
}

/**
 * H-1 fix wave: the KEY NAMES that were added, removed, or whose value
 * changed between two config objects — sorted ascending (a stable,
 * diffable shape, matching updatePluginEventGrantsAndEmit's own
 * SORTED-not-insertion-order convention). Values are compared by their
 * JSON serialization (structural equality), which is sufficient for a
 * JSONB-sourced object (no functions/undefined/Date to worry about).
 */
function diffConfigKeys(oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>): string[] {
  const keys = new Set<string>([...Object.keys(oldConfig), ...Object.keys(newConfig)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
      changed.push(key);
    }
  }
  return changed.sort();
}

export async function updatePluginConfigAndEmit(db: Kysely<DB>, input: UpdatePluginConfigInput): Promise<PluginRow> {
  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('plugins')
      .select(['name', 'config'])
      .where('id', '=', input.pluginId)
      .executeTakeFirstOrThrow();

    const configJson = JSON.stringify(input.config);
    const row = await trx
      .updateTable('plugins')
      .set({ config: sql`${configJson}::jsonb`, updated_at_ms: input.nowMs })
      .where('id', '=', input.pluginId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // H-1 fix wave: the payload used to carry the WHOLE non-secret config
    // object, old and new, verbatim (`existing.config`/`row.config`) — into
    // an ADMIN_ONLY outbox event that, before H-4's fix, was requestable by
    // ANY event-subscriber plugin. Even restricted to admin-only delivery,
    // "every value of every OTHER field a plugin's config carries" is far
    // more than an audit trail needs, and (H-1's real finding) a nested
    // `secret: true` marker that a plugin's configSchema declared —
    // schema-legal but silently non-secret before the parser-level
    // rejection landed — would have ridden along inside this object
    // verbatim. Carrying only the CHANGED KEY NAMES gives the same "what
    // changed" audit signal without ever re-serializing a config value into
    // an event payload.
    const changedKeys = diffConfigKeys(existing.config as Record<string, unknown>, row.config as Record<string, unknown>);

    await writeEvent(trx, {
      type: 'plugin.updated',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        pluginId: row.id,
        name: row.name,
        change: 'config',
        // No prior state is disclosed (this event no longer carries ANY
        // config value, per this function's own doc comment above) —
        // `newValue` is the sorted list of field NAMES that changed.
        oldValue: null,
        newValue: changedKeys,
        updatedAtMs: input.nowMs,
      },
    });

    return row;
  });
}

// ============================================================================
// enable / disable (admin toggle, breaker auto-disable) — setPluginEnabledAndEmit
// ============================================================================

export interface SetPluginEnabledInput {
  pluginId: string;
  enabled: boolean;
  /** Required when `enabled: false` (LD4: plugin.disabled payload always
   *  carries a reason). Ignored (forced to NULL) when `enabled: true`. */
  reason?: PluginDisabledReason;
  /** null for the breaker auto-disable path (system-originated, no human
   *  actor) — every other call site (admin toggle, re-approval) supplies a
   *  real user id. */
  actorUserId: string | null;
  nowMs: number;
}

export async function setPluginEnabledAndEmit(db: Kysely<DB>, input: SetPluginEnabledInput): Promise<PluginRow> {
  if (!input.enabled && !input.reason) {
    throw new Error('setPluginEnabledAndEmit: reason is required when disabling a plugin');
  }
  return withTransaction(db, async (trx) => {
    const row = await trx
      .updateTable('plugins')
      .set({
        enabled: input.enabled,
        disabled_reason: input.enabled ? null : (input.reason as PluginDisabledReason),
        updated_at_ms: input.nowMs,
      })
      .where('id', '=', input.pluginId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeEvent(trx, {
      type: input.enabled ? 'plugin.enabled' : 'plugin.disabled',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: input.enabled
        ? { pluginId: row.id, name: row.name, enabledAtMs: input.nowMs }
        : { pluginId: row.id, name: row.name, reason: input.reason, disabledAtMs: input.nowMs },
    });

    return row;
  });
}

// ============================================================================
// re-approval after a scope-change auto-disable (LD6) — reapprovePluginAndEmit
// ============================================================================

export interface ReapprovePluginInput {
  pluginId: string;
  manifest: Record<string, unknown>;
  version: string;
  protocolVersion: number;
  contentClass: ContentClass;
  grantedCapabilityTypes: string[];
  eventTypes: string[];
  actorUserId: string;
  nowMs: number;
}

/** Re-approves a plugin an expanding re-fetch previously auto-disabled with
 *  `disabled_reason = 'scope-change'`: replaces the manifest snapshot, the
 *  granted capability/event-type sets (event grants are DELETEd and
 *  re-inserted wholesale — the new grant set is authoritative, never
 *  merged with the stale one), and re-enables the row. Emits ONE
 *  plugin.enabled event (not plugin.updated) — from the admin's point of
 *  view this is fundamentally "I re-approved this plugin", the same
 *  observable transition a manual re-enable produces. */
export async function reapprovePluginAndEmit(db: Kysely<DB>, input: ReapprovePluginInput): Promise<PluginWithGrants> {
  return withTransaction(db, async (trx) => {
    const manifestJson = JSON.stringify(input.manifest);
    const row = await trx
      .updateTable('plugins')
      .set({
        manifest: sql`${manifestJson}::jsonb`,
        version: input.version,
        protocol_version: input.protocolVersion,
        content_class: input.contentClass,
        granted_capability_types: input.grantedCapabilityTypes,
        enabled: true,
        disabled_reason: null,
        approved_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
      })
      .where('id', '=', input.pluginId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx.deleteFrom('plugin_event_grants').where('plugin_id', '=', input.pluginId).execute();
    const eventGrants: PluginEventGrantRow[] = [];
    for (const eventType of input.eventTypes) {
      eventGrants.push(
        await trx
          .insertInto('plugin_event_grants')
          .values({ plugin_id: row.id, event_type: eventType, granted_at_ms: input.nowMs })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    }

    await writeEvent(trx, {
      type: 'plugin.enabled',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { pluginId: row.id, name: row.name, enabledAtMs: input.nowMs },
    });

    return { plugin: row, eventGrants };
  });
}

// ============================================================================
// health transitions (LD7) — setPluginHealthAndEmit
// ============================================================================

export interface SetPluginHealthInput {
  pluginId: string;
  healthState: PluginHealthState;
  consecutiveFailures: number;
  /** Whether THIS check itself succeeded — drives whether `last_ok_ms` is
   *  bumped. Distinct from `healthState`, which is the service's overall
   *  envelope+capability verdict (see apps/server/src/plugins/
   *  plugin-health.service.ts). */
  ok: boolean;
  checkedAtMs: number;
}

/** Always updates the row; emits plugin.health-changed ONLY when
 *  `health_state` actually changed (LD7: "exactly on CHANGE, not on every
 *  check") — the old value is read inside the SAME transaction so the
 *  comparison can never race a concurrent health check. */
export async function setPluginHealthAndEmit(db: Kysely<DB>, input: SetPluginHealthInput): Promise<PluginRow> {
  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('plugins')
      .select(['name', 'health_state'])
      .where('id', '=', input.pluginId)
      .executeTakeFirstOrThrow();

    const row = await trx
      .updateTable('plugins')
      .set({
        health_state: input.healthState,
        consecutive_failures: input.consecutiveFailures,
        last_health_check_ms: input.checkedAtMs,
        ...(input.ok ? { last_ok_ms: input.checkedAtMs } : {}),
      })
      .where('id', '=', input.pluginId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (existing.health_state !== row.health_state) {
      await writeEvent(trx, {
        type: 'plugin.health-changed',
        tsMs: input.checkedAtMs,
        actorUserId: null,
        payload: {
          pluginId: row.id,
          name: row.name,
          previousState: existing.health_state,
          newState: row.health_state,
          changedAtMs: input.checkedAtMs,
        },
      });
    }

    return row;
  });
}

// ============================================================================
// HMAC rotation touch (LD1) — touchPluginHmacRotatedAndEmit
// ============================================================================

export interface TouchPluginHmacRotatedInput {
  pluginId: string;
  actorUserId: string;
  nowMs: number;
}

/** The delivery-signing HMAC itself lives ONLY in the keyring (LD1) — this
 *  function never touches it. Called by the lifecycle service AFTER a
 *  successful keyring re-mint, purely to bump `updated_at_ms` and emit the
 *  audit trail (payload NEVER carries the secret, old or new — both
 *  `oldValue`/`newValue` are null, matching emitRedactedSettingsUpdated's
 *  "never place the value in the event" discipline). */
export async function touchPluginHmacRotatedAndEmit(db: Kysely<DB>, input: TouchPluginHmacRotatedInput): Promise<PluginRow> {
  return withTransaction(db, async (trx) => {
    const row = await trx
      .updateTable('plugins')
      .set({ updated_at_ms: input.nowMs })
      .where('id', '=', input.pluginId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeEvent(trx, {
      type: 'plugin.updated',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        pluginId: row.id,
        name: row.name,
        change: 'hmac-rotated',
        oldValue: null,
        newValue: null,
        updatedAtMs: input.nowMs,
      },
    });

    return row;
  });
}

// ============================================================================
// pseudonymization posture toggle (Lane W5b) — setPluginPseudonymizationAndEmit
// ============================================================================

export interface SetPluginPseudonymizationInput {
  pluginId: string;
  /** The new plugins.pseudonymize_actor_ids value (migrations/
   *  0016_plugin_delivery_cursors.sql's column comment — default TRUE,
   *  "pseudonymous actor ids by DEFAULT, per-plugin toggle for real
   *  identity", LPP v1 mission §3.2). Read only by the delivery loop
   *  (apps/worker/src/plugin-delivery/**), never written by it. */
  enabled: boolean;
  actorUserId: string;
  nowMs: number;
}

/** Admin toggle for a plugin's pseudonymization posture — mirrors
 *  setPluginEnabledAndEmit's shape exactly (read old value inside the SAME
 *  transaction, update, emit). Does NOT touch pseudonym_salt (that is
 *  minted lazily by src/query/plugins-delivery.ts's ensurePseudonymSalt on
 *  first delivery, independent of this toggle's current value — a plugin
 *  can be flipped ON then OFF then ON again without ever re-minting a new
 *  salt, since the salt's only job is making a real user id unlinkable
 *  across plugins, not gating whether pseudonymization is currently
 *  active). */
export async function setPluginPseudonymizationAndEmit(db: Kysely<DB>, input: SetPluginPseudonymizationInput): Promise<PluginRow> {
  return withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('plugins')
      .select(['name', 'pseudonymize_actor_ids'])
      .where('id', '=', input.pluginId)
      .executeTakeFirstOrThrow();

    const row = await trx
      .updateTable('plugins')
      .set({ pseudonymize_actor_ids: input.enabled, updated_at_ms: input.nowMs })
      .where('id', '=', input.pluginId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Payload matches packages/contract/event-schemas/plugin.updated.schema.json's
    // change='pseudonymization' shape: oldValue/newValue are the boolean
    // posture before/after, never a secret (this column is not one).
    await writeEvent(trx, {
      type: 'plugin.updated',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        pluginId: row.id,
        name: row.name,
        change: 'pseudonymization',
        oldValue: existing.pseudonymize_actor_ids,
        newValue: row.pseudonymize_actor_ids,
        updatedAtMs: input.nowMs,
      },
    });

    return row;
  });
}

// ============================================================================
// honest event-grants audit (Lane W5b) — updatePluginEventGrantsAndEmit
// ============================================================================

export interface UpdatePluginEventGrantsInput {
  pluginId: string;
  /** Full REPLACEMENT set of granted event `type` strings — existing
   *  plugin_event_grants rows are deleted and re-inserted wholesale, same
   *  convention as insertPluginAndEmit/updatePluginManifestAndEmit/
   *  reapprovePluginAndEmit. The caller (apps/server/src/plugins/
   *  admin-plugin-grants.service.ts) has already validated every value is a
   *  member of the plugin's manifest-requested eventTypes — this function
   *  does not re-validate that (packages/db has no knowledge of the
   *  manifest's requested set, same reasoning updatePluginManifestAndEmit's
   *  own eventTypes parameter never re-validates it either). */
  eventTypes: string[];
  actorUserId: string;
  nowMs: number;
}

/**
 * Replaces a plugin's event-subscriber grant set WITHOUT touching its
 * manifest/version/protocolVersion/contentClass/grantedCapabilityTypes —
 * the narrow "grants-only" primitive apps/server/src/plugins/
 * admin-plugin-grants.service.ts's header documented as a W5 "thin-
 * controller gap" (it had to reuse updatePluginManifestAndEmit instead,
 * producing a plugin.updated event whose `change` dishonestly read
 * 'manifest' for an event-grants-only edit). Emits plugin.updated with
 * change='event-grants' and oldValue/newValue = the granted event `type`
 * arrays before/after, each SORTED ascending (never insertion order — a
 * stable, diffable shape for anything reading the audit trail). Both the
 * pre-delete read and the delete+reinsert happen inside the SAME
 * transaction as the emitted event, so the audit trail can never desync
 * from what was actually persisted (docs/PLAN.md §4.3's outbox pattern,
 * this file's header).
 */
export async function updatePluginEventGrantsAndEmit(db: Kysely<DB>, input: UpdatePluginEventGrantsInput): Promise<PluginWithGrants> {
  return withTransaction(db, async (trx) => {
    const pluginBefore = await trx
      .selectFrom('plugins')
      .select(['id', 'name'])
      .where('id', '=', input.pluginId)
      .executeTakeFirstOrThrow();

    const existingGrants = await trx
      .selectFrom('plugin_event_grants')
      .select('event_type')
      .where('plugin_id', '=', input.pluginId)
      .execute();
    const oldValue = existingGrants.map((g) => g.event_type).sort();

    await trx.deleteFrom('plugin_event_grants').where('plugin_id', '=', input.pluginId).execute();
    const eventGrants: PluginEventGrantRow[] = [];
    for (const eventType of input.eventTypes) {
      eventGrants.push(
        await trx
          .insertInto('plugin_event_grants')
          .values({ plugin_id: pluginBefore.id, event_type: eventType, granted_at_ms: input.nowMs })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    }
    const newValue = [...input.eventTypes].sort();

    const row = await trx
      .updateTable('plugins')
      .set({ updated_at_ms: input.nowMs })
      .where('id', '=', input.pluginId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeEvent(trx, {
      type: 'plugin.updated',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: {
        pluginId: row.id,
        name: row.name,
        change: 'event-grants',
        oldValue,
        newValue,
        updatedAtMs: input.nowMs,
      },
    });

    return { plugin: row, eventGrants };
  });
}

// ============================================================================
// removal — removePluginAndEmit
// ============================================================================

export interface RemovePluginInput {
  pluginId: string;
  actorUserId: string;
  nowMs: number;
}

/** Deletes the plugin row (plugin_event_grants CASCADE with it) and emits
 *  plugin.removed. The row's name is read INSIDE the transaction, before
 *  the DELETE, so the event can still report it. Does NOT touch the
 *  keyring (the HMAC secret / any config secret keys) — that is the
 *  lifecycle service's job, performed alongside this call, since only the
 *  service has keyring access (LD2: this package never imports
 *  @loombre/secrets). */
export async function removePluginAndEmit(db: Kysely<DB>, input: RemovePluginInput): Promise<void> {
  await withTransaction(db, async (trx) => {
    const existing = await trx
      .selectFrom('plugins')
      .select(['id', 'name'])
      .where('id', '=', input.pluginId)
      .executeTakeFirstOrThrow();

    await trx.deleteFrom('plugins').where('id', '=', input.pluginId).execute();

    await writeEvent(trx, {
      type: 'plugin.removed',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { pluginId: existing.id, name: existing.name, removedAtMs: input.nowMs },
    });
  });
}
