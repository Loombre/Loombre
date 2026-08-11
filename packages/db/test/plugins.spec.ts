// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/plugins.spec.ts
//
// Live-DB tests for src/query/plugins.ts (LPP v1, Lane W2,
// migrations/0014_plugins.sql) — mirrors test/settings.spec.ts's exact
// convention (own reset+reseed, a raw pg.Client for direct outbox-row
// reads). Proves the emit-helpers write the row AND their matching
// plugin.* event in one transaction, and — LD7's specific invariant —
// that setPluginHealthAndEmit emits plugin.health-changed EXACTLY on a
// state transition, never on a check that reconfirms the same state.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { getUserByUsername } from '../src/query/identity.js';
import {
  getPluginById,
  getPluginByBaseUrl,
  getPluginEventGrants,
  insertPluginAndEmit,
  listPlugins,
  reapprovePluginAndEmit,
  removePluginAndEmit,
  setPluginEnabledAndEmit,
  setPluginHealthAndEmit,
  setPluginPseudonymizationAndEmit,
  touchPluginHmacRotatedAndEmit,
  updatePluginConfigAndEmit,
  updatePluginEventGrantsAndEmit,
  updatePluginManifestAndEmit,
} from '../src/query/plugins.js';
import { resolveTestDatabaseUrl } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = resolveTestDatabaseUrl();

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;
let rawClient: pg.Client;
let adminUserId: string;

async function pluginEventsFor(pluginId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const { rows } = await rawClient.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM events WHERE type LIKE 'plugin.%' AND payload ->> 'pluginId' = $1 ORDER BY ts_ms ASC, id ASC`,
    [pluginId],
  );
  return rows;
}

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();
  const admin = await getUserByUsername(db, 'admin');
  if (!admin) throw new Error('seed did not create the expected admin user');
  adminUserId = admin.id;
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

function fixtureManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'fixture-plugin',
    version: '0.1.0',
    protocolVersion: 1,
    capabilities: [
      {
        type: 'metadata-provider',
        mediaKinds: ['movie'],
        contentClass: 'general',
        endpoints: { search: '/lpp/provider/search', details: '/lpp/provider/details', images: '/lpp/provider/images' },
      },
    ],
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    description: 'fixture',
    publisher: 'Loombre',
    ...overrides,
  };
}

describe('plugins queries', () => {
  it('listPlugins starts empty', async () => {
    expect(await listPlugins(db)).toEqual([]);
  });

  it('insertPluginAndEmit writes the row + event grants + plugin.registered event in one transaction', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    const { plugin, eventGrants } = await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'fixture-plugin',
      baseUrl: 'http://127.0.0.1:9001',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: ['item.added'],
      lanAllowlist: ['127.0.0.1'],
      manifest: fixtureManifest(),
      config: { fixturePrefix: 'x' },
      actorUserId: adminUserId,
      nowMs,
    });

    expect(plugin.id).toBe(pluginId);
    expect(plugin.enabled).toBe(true);
    expect(plugin.health_state).toBe('unknown');
    expect(plugin.consecutive_failures).toBe(0);
    expect(plugin.disabled_reason).toBeNull();
    expect(plugin.approved_at_ms).toBe(nowMs);
    expect(eventGrants).toHaveLength(1);
    expect(eventGrants[0]?.event_type).toBe('item.added');

    const grantsFromDb = await getPluginEventGrants(db, pluginId);
    expect(grantsFromDb.map((g) => g.event_type)).toEqual(['item.added']);

    const fetchedByUrl = await getPluginByBaseUrl(db, 'http://127.0.0.1:9001');
    expect(fetchedByUrl?.id).toBe(pluginId);

    const events = await pluginEventsFor(pluginId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('plugin.registered');
    expect(events[0]?.payload).toMatchObject({
      pluginId,
      name: 'fixture-plugin',
      baseUrl: 'http://127.0.0.1:9001',
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: ['item.added'],
    });
  });

  it('updatePluginManifestAndEmit replaces the manifest/version/grants and emits plugin.updated', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'refresh-fixture',
      baseUrl: 'http://127.0.0.1:9002',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: [],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });

    const { plugin: updated, eventGrants } = await updatePluginManifestAndEmit(db, {
      pluginId,
      manifest: fixtureManifest({ version: '0.2.0' }),
      version: '0.2.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: ['item.added'],
      actorUserId: adminUserId,
      nowMs: nowMs + 1000,
    });

    expect(updated.version).toBe('0.2.0');
    expect(eventGrants.map((g) => g.event_type)).toEqual(['item.added']);

    const events = await pluginEventsFor(pluginId);
    const updatedEvent = events.find((e) => e.type === 'plugin.updated');
    expect(updatedEvent?.payload).toMatchObject({ change: 'manifest', oldValue: '0.1.0', newValue: '0.2.0' });
  });

  it('setPluginEnabledAndEmit toggles enabled/disabled_reason and emits the matching event; requires a reason to disable', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'enable-fixture',
      baseUrl: 'http://127.0.0.1:9003',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: [],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });

    await expect(
      setPluginEnabledAndEmit(db, { pluginId, enabled: false, actorUserId: adminUserId, nowMs: nowMs + 1 }),
    ).rejects.toThrow(/reason is required/);

    const disabled = await setPluginEnabledAndEmit(db, {
      pluginId,
      enabled: false,
      reason: 'admin',
      actorUserId: adminUserId,
      nowMs: nowMs + 2,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabled_reason).toBe('admin');

    const reenabled = await setPluginEnabledAndEmit(db, { pluginId, enabled: true, actorUserId: adminUserId, nowMs: nowMs + 3 });
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.disabled_reason).toBeNull();

    const events = await pluginEventsFor(pluginId);
    expect(events.map((e) => e.type)).toContain('plugin.disabled');
    expect(events.map((e) => e.type)).toContain('plugin.enabled');
    const disabledEvent = events.find((e) => e.type === 'plugin.disabled');
    expect(disabledEvent?.payload).toMatchObject({ reason: 'admin' });
  });

  it('setPluginEnabledAndEmit(false) with actorUserId:null (breaker, system-originated) writes a null-actor event', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'breaker-fixture',
      baseUrl: 'http://127.0.0.1:9004',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: [],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });

    await setPluginEnabledAndEmit(db, { pluginId, enabled: false, reason: 'breaker', actorUserId: null, nowMs: nowMs + 1 });

    const { rows } = await rawClient.query<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM events WHERE type = 'plugin.disabled' AND payload ->> 'pluginId' = $1 ORDER BY ts_ms DESC LIMIT 1`,
      [pluginId],
    );
    expect(rows[0]?.actor_user_id).toBeNull();
  });

  it('reapprovePluginAndEmit replaces manifest/grants/content_class, re-enables, and emits plugin.enabled', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'reapprove-fixture',
      baseUrl: 'http://127.0.0.1:9005',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: [],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });
    await setPluginEnabledAndEmit(db, { pluginId, enabled: false, reason: 'scope-change', actorUserId: adminUserId, nowMs: nowMs + 1 });

    const { plugin, eventGrants } = await reapprovePluginAndEmit(db, {
      pluginId,
      manifest: fixtureManifest({ version: '0.3.0' }),
      version: '0.3.0',
      protocolVersion: 1,
      contentClass: 'restricted',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: ['item.added', 'playback.started'],
      actorUserId: adminUserId,
      nowMs: nowMs + 2,
    });

    expect(plugin.enabled).toBe(true);
    expect(plugin.disabled_reason).toBeNull();
    expect(plugin.content_class).toBe('restricted');
    expect(plugin.approved_at_ms).toBe(nowMs + 2);
    expect(eventGrants.map((g) => g.event_type).sort()).toEqual(['item.added', 'playback.started']);

    const events = await pluginEventsFor(pluginId);
    expect(events.at(-1)?.type).toBe('plugin.enabled');
  });

  it('H-1 fix wave: updatePluginConfigAndEmit replaces plugins.config and emits plugin.updated(change="config") with CHANGED KEY NAMES only — never any config value', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'config-fixture',
      baseUrl: 'http://127.0.0.1:9006',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: [],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      // A field name chosen to look exactly like the shape H-1 found could
      // leak a NESTED secret verbatim into this event before the fix
      // (packages/plugin-protocol's parser now rejects `secret: true` below
      // the root at manifest-parse time — this fixture only needs a
      // plausibly-sensitive-looking VALUE, not an actual schema-legal
      // secret, to prove the event payload never echoes it).
      config: { fixturePrefix: 'old', credentials: { apiKey: 'DISTINCTIVE-OLD-VALUE-MUST-NEVER-APPEAR' }, stable: 'unchanged' },
      actorUserId: adminUserId,
      nowMs,
    });

    const updated = await updatePluginConfigAndEmit(db, {
      pluginId,
      config: { fixturePrefix: 'new', credentials: { apiKey: 'DISTINCTIVE-NEW-VALUE-MUST-NEVER-APPEAR' }, stable: 'unchanged' },
      actorUserId: adminUserId,
      nowMs: nowMs + 1,
    });
    expect(updated.config).toEqual({ fixturePrefix: 'new', credentials: { apiKey: 'DISTINCTIVE-NEW-VALUE-MUST-NEVER-APPEAR' }, stable: 'unchanged' });

    const events = await pluginEventsFor(pluginId);
    const configEvent = events.find((e) => e.type === 'plugin.updated' && e.payload.change === 'config');
    // Only the two keys that actually changed are named; the unchanged
    // 'stable' key is omitted entirely, and NEITHER old nor new config
    // VALUES (nor the distinctive secret-shaped string) appear anywhere in
    // the payload.
    expect(configEvent?.payload).toMatchObject({ oldValue: null, newValue: ['credentials', 'fixturePrefix'] });
    const serialized = JSON.stringify(configEvent?.payload);
    expect(serialized).not.toContain('DISTINCTIVE-OLD-VALUE-MUST-NEVER-APPEAR');
    expect(serialized).not.toContain('DISTINCTIVE-NEW-VALUE-MUST-NEVER-APPEAR');
    expect(serialized).not.toContain('apiKey');
  });

  it('touchPluginHmacRotatedAndEmit bumps updated_at_ms and emits plugin.updated(change="hmac-rotated") with null old/new (never the secret)', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'hmac-fixture',
      baseUrl: 'http://127.0.0.1:9007',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: [],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });

    const touched = await touchPluginHmacRotatedAndEmit(db, { pluginId, actorUserId: adminUserId, nowMs: nowMs + 500 });
    expect(touched.updated_at_ms).toBe(nowMs + 500);

    const events = await pluginEventsFor(pluginId);
    const hmacEvent = events.find((e) => e.type === 'plugin.updated' && e.payload.change === 'hmac-rotated');
    expect(hmacEvent?.payload).toMatchObject({ change: 'hmac-rotated', oldValue: null, newValue: null });
  });

  it('setPluginHealthAndEmit emits plugin.health-changed EXACTLY on a state transition, never on a repeat of the same state (LD7)', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'health-fixture',
      baseUrl: 'http://127.0.0.1:9008',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: [],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });

    // unknown -> healthy: a real transition, one event.
    await setPluginHealthAndEmit(db, { pluginId, healthState: 'healthy', consecutiveFailures: 0, ok: true, checkedAtMs: nowMs + 1 });
    // healthy -> healthy: NOT a transition, no new event.
    await setPluginHealthAndEmit(db, { pluginId, healthState: 'healthy', consecutiveFailures: 0, ok: true, checkedAtMs: nowMs + 2 });
    await setPluginHealthAndEmit(db, { pluginId, healthState: 'healthy', consecutiveFailures: 0, ok: true, checkedAtMs: nowMs + 3 });
    // healthy -> unhealthy: a real transition, a second event.
    await setPluginHealthAndEmit(db, { pluginId, healthState: 'unhealthy', consecutiveFailures: 1, ok: false, checkedAtMs: nowMs + 4 });

    const events = await pluginEventsFor(pluginId);
    const healthEvents = events.filter((e) => e.type === 'plugin.health-changed');
    expect(healthEvents).toHaveLength(2);
    expect(healthEvents[0]?.payload).toMatchObject({ previousState: 'unknown', newState: 'healthy' });
    expect(healthEvents[1]?.payload).toMatchObject({ previousState: 'healthy', newState: 'unhealthy' });

    const row = await getPluginById(db, pluginId);
    expect(row?.health_state).toBe('unhealthy');
    expect(row?.consecutive_failures).toBe(1);
    // last_ok_ms tracks the MOST RECENT ok:true check (nowMs+3 — the third
    // call) and is untouched by the final ok:false check (nowMs+4).
    expect(row?.last_ok_ms).toBe(nowMs + 3);
    expect(row?.last_health_check_ms).toBe(nowMs + 4);
  });

  it('removePluginAndEmit deletes the row (event_grants CASCADE) and emits plugin.removed', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'remove-fixture',
      baseUrl: 'http://127.0.0.1:9009',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: ['item.added'],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });

    await removePluginAndEmit(db, { pluginId, actorUserId: adminUserId, nowMs: nowMs + 1 });

    expect(await getPluginById(db, pluginId)).toBeUndefined();
    expect(await getPluginEventGrants(db, pluginId)).toEqual([]);

    const events = await pluginEventsFor(pluginId);
    expect(events.at(-1)?.type).toBe('plugin.removed');
  });

  it('base_url is UNIQUE — a second insert at the same base_url violates the constraint', async () => {
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: randomUUID(),
      name: 'unique-fixture-1',
      baseUrl: 'http://127.0.0.1:9010',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['metadata-provider'],
      eventTypes: [],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });

    await expect(
      insertPluginAndEmit(db, {
        id: randomUUID(),
        name: 'unique-fixture-2',
        baseUrl: 'http://127.0.0.1:9010',
        version: '0.1.0',
        protocolVersion: 1,
        contentClass: 'general',
        grantedCapabilityTypes: ['metadata-provider'],
        eventTypes: [],
        lanAllowlist: [],
        manifest: fixtureManifest(),
        config: {},
        actorUserId: adminUserId,
        nowMs,
      }),
    ).rejects.toThrow();
  });

  // ==========================================================================
  // Lane W5b: pseudonymization toggle + honest event-grants audit
  // ==========================================================================

  it('setPluginPseudonymizationAndEmit flips plugins.pseudonymize_actor_ids and emits plugin.updated(change="pseudonymization") with the boolean old/new', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    const inserted = await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'pseudonymization-fixture',
      baseUrl: 'http://127.0.0.1:9011',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['event-subscriber'],
      eventTypes: ['item.added'],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });
    // Default ON (migrations/0016_plugin_delivery_cursors.sql: DEFAULT TRUE).
    expect(inserted.plugin.pseudonymize_actor_ids).toBe(true);

    const turnedOff = await setPluginPseudonymizationAndEmit(db, {
      pluginId,
      enabled: false,
      actorUserId: adminUserId,
      nowMs: nowMs + 1,
    });
    expect(turnedOff.pseudonymize_actor_ids).toBe(false);
    expect(turnedOff.updated_at_ms).toBe(nowMs + 1);

    const turnedOn = await setPluginPseudonymizationAndEmit(db, {
      pluginId,
      enabled: true,
      actorUserId: adminUserId,
      nowMs: nowMs + 2,
    });
    expect(turnedOn.pseudonymize_actor_ids).toBe(true);

    const events = await pluginEventsFor(pluginId);
    const pseudonymizationEvents = events.filter((e) => e.type === 'plugin.updated' && e.payload.change === 'pseudonymization');
    expect(pseudonymizationEvents).toHaveLength(2);
    expect(pseudonymizationEvents[0]?.payload).toMatchObject({ oldValue: true, newValue: false });
    expect(pseudonymizationEvents[1]?.payload).toMatchObject({ oldValue: false, newValue: true });
  });

  it('updatePluginEventGrantsAndEmit replaces plugin_event_grants wholesale WITHOUT touching manifest/version/contentClass/grantedCapabilityTypes, and emits plugin.updated(change="event-grants") with SORTED old/new type arrays', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    const inserted = await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'event-grants-audit-fixture',
      baseUrl: 'http://127.0.0.1:9012',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['event-subscriber'],
      eventTypes: ['playback.started', 'item.added'],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });
    expect(inserted.eventGrants.map((g) => g.event_type).sort()).toEqual(['item.added', 'playback.started']);

    const { plugin: updated, eventGrants } = await updatePluginEventGrantsAndEmit(db, {
      pluginId,
      eventTypes: ['item.added'], // narrows the grant set
      actorUserId: adminUserId,
      nowMs: nowMs + 1,
    });

    expect(eventGrants.map((g) => g.event_type)).toEqual(['item.added']);
    // Nothing else about the row changed except updated_at_ms.
    expect(updated.version).toBe(inserted.plugin.version);
    expect(updated.manifest).toEqual(inserted.plugin.manifest);
    expect(updated.content_class).toBe(inserted.plugin.content_class);
    expect(updated.granted_capability_types).toEqual(inserted.plugin.granted_capability_types);
    expect(updated.updated_at_ms).toBe(nowMs + 1);

    const grantsNow = await getPluginEventGrants(db, pluginId);
    expect(grantsNow.map((g) => g.event_type)).toEqual(['item.added']);

    const events = await pluginEventsFor(pluginId);
    const grantsEvent = events.find((e) => e.type === 'plugin.updated' && e.payload.change === 'event-grants');
    expect(grantsEvent?.payload).toMatchObject({
      change: 'event-grants',
      oldValue: ['item.added', 'playback.started'], // sorted, not insertion order
      newValue: ['item.added'],
    });
  });

  it('updatePluginEventGrantsAndEmit([]) clears every grant and reports an empty sorted newValue', async () => {
    const pluginId = randomUUID();
    const nowMs = Date.now();
    await insertPluginAndEmit(db, {
      id: pluginId,
      name: 'event-grants-clear-fixture',
      baseUrl: 'http://127.0.0.1:9013',
      version: '0.1.0',
      protocolVersion: 1,
      contentClass: 'general',
      grantedCapabilityTypes: ['event-subscriber'],
      eventTypes: ['item.added'],
      lanAllowlist: [],
      manifest: fixtureManifest(),
      config: {},
      actorUserId: adminUserId,
      nowMs,
    });

    const { eventGrants } = await updatePluginEventGrantsAndEmit(db, {
      pluginId,
      eventTypes: [],
      actorUserId: adminUserId,
      nowMs: nowMs + 1,
    });
    expect(eventGrants).toEqual([]);

    const events = await pluginEventsFor(pluginId);
    const grantsEvent = events.find((e) => e.type === 'plugin.updated' && e.payload.change === 'event-grants');
    expect(grantsEvent?.payload).toMatchObject({ oldValue: ['item.added'], newValue: [] });
  });
});
