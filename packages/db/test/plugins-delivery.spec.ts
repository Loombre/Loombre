// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/plugins-delivery.spec.ts
//
// LPP v1, Lane W4. Live-DB tests for src/query/plugins-delivery.ts AND,
// critically, for migrations/0016_plugin_delivery_cursors.sql itself (the
// full REAL migration chain 0001..0016 is replayed via the real
// scripts/migrate.mjs, proving this lane's migration applies cleanly on
// top of Lane W2's real migrations/0014_plugins.sql — no shim needed,
// unlike an earlier draft of this suite written against a stale worktree
// base; see this lane's final report's "incident" note).
//
// TEST-HARNESS CHOICE (deliberately different from every other
// packages/db/test/*.spec.ts file's convention, e.g. test/plugins.spec.ts's
// own `run(migrate.mjs, ['reset'])` against the SHARED default
// DATABASE_URL): this lane's environment rules explicitly forbid
// resetting the shared dev DB ("sibling lanes share the dev Postgres...
// do NOT run... anything reseeding the shared dev DB") — sibling lanes
// run in parallel worktrees against the SAME shared Postgres server, so a
// `DROP SCHEMA public CASCADE` here would destroy their in-progress work.
// Instead this suite provisions its OWN separate, disposable database on
// the same server (ensureFreshIsolatedDatabase below) and only ever
// touches that isolated database, then runs the REAL `scripts/migrate.mjs
// migrate` (not `reset` — the isolated database starts genuinely empty,
// so `migrate` alone applies every migration cleanly).
//
// Plugin/grant fixtures are inserted directly via Kysely rather than
// through src/query/plugins.ts's insertPluginAndEmit (which requires a
// real `users` row for its FK'd actorUserId and emits a plugin.registered
// event neither this suite nor the delivery loop cares about) — this
// keeps the suite self-contained with no dependency on identity.ts/seed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import {
  advanceCursorPastFilteredEvents,
  ensurePseudonymSalt,
  findOldestUnconsumedBeforeMs,
  getDeliveryCursor,
  listCandidateEventsForDelivery,
  listEventSubscriberPlugins,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from '../src/query/plugins-delivery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

async function ensureFreshIsolatedDatabase(baseConnectionString: string, suffix: string): Promise<string> {
  const url = new URL(baseConnectionString);
  const baseDbName = url.pathname.replace(/^\//, '');
  const isolatedDbName = `${baseDbName}_${suffix}`;
  const isolatedUrl = new URL(baseConnectionString);
  isolatedUrl.pathname = `/${isolatedDbName}`;

  const admin = new pg.Client({ connectionString: baseConnectionString });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedDbName.replace(/"/g, '""')}"`);
    await admin.query(`CREATE DATABASE "${isolatedDbName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
  return isolatedUrl.toString();
}

function runMigrate(url: string): void {
  const result = spawnSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), 'migrate'], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`migrate.mjs migrate failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

let DATABASE_URL: string;
let db: Kysely<DB>;
let rawClient: pg.Client;

function fixtureManifest(overrides: { capabilities?: unknown[] } = {}) {
  return {
    name: 'fixture-subscriber',
    version: '0.1.0',
    protocolVersion: 1,
    capabilities: overrides.capabilities ?? [
      {
        type: 'event-subscriber',
        eventTypes: ['item.added', 'user.created'],
        delivery: { endpoint: '/lpp/events' },
        contentClass: 'general',
      },
    ],
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    description: 'fixture',
    publisher: 'Loombre',
  };
}

let pluginCounter = 0;

async function insertPlugin(input: {
  contentClass?: 'general' | 'restricted';
  grantedCapabilityTypes?: string[];
  manifest?: Record<string, unknown>;
  enabled?: boolean;
  pseudonymizeActorIds?: boolean;
  config?: Record<string, unknown>;
}): Promise<string> {
  pluginCounter += 1;
  const row = await db
    .insertInto('plugins')
    .values({
      name: `fixture-plugin-${pluginCounter}`,
      base_url: `http://127.0.0.1:${9000 + pluginCounter}`,
      version: '0.1.0',
      protocol_version: 1,
      enabled: input.enabled ?? true,
      content_class: input.contentClass ?? 'general',
      granted_capability_types: input.grantedCapabilityTypes ?? ['event-subscriber'],
      // node-postgres's default parameter serialization mangles a bare JS
      // object against a jsonb column — see packages/db/src/query/
      // settings.ts's header for the full explanation; the explicit
      // JSON.stringify + `::jsonb` cast is what src/query/plugins.ts's
      // insertPluginAndEmit itself does for this exact column.
      manifest: sql`${JSON.stringify(input.manifest ?? fixtureManifest())}::jsonb`,
      ...(input.config !== undefined ? { config: sql`${JSON.stringify(input.config)}::jsonb` } : {}),
      pseudonymize_actor_ids: input.pseudonymizeActorIds ?? true,
      created_at_ms: 1_700_000_000_000,
      updated_at_ms: 1_700_000_000_000,
      approved_at_ms: 1_700_000_000_000,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function grant(pluginId: string, eventType: string, grantedAtMs = 1_700_000_000_000): Promise<void> {
  await db
    .insertInto('plugin_event_grants')
    .values({ plugin_id: pluginId, event_type: eventType, granted_at_ms: grantedAtMs })
    .execute();
}

/**
 * loombre_uuidv7()'s DEFAULT mints `events.id` from the DATABASE SERVER's
 * real clock at insert time — NOT from the caller-supplied `tsMs` column
 * value. A tiny real sleep between inserts (2ms, comfortably more than
 * one INSERT's local round-trip cost) makes every test in this file that
 * asserts relative id ORDER deterministic, matching how events are
 * actually spaced in production (distinct actions, never sub-millisecond
 * bursts of writes to the SAME outbox row stream this suite is proving
 * cursor semantics over).
 */
async function insertEvent(type: string, tsMs: number, payload: Record<string, unknown> = {}): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 2));
  const row = await rawClient.query<{ id: string }>(
    `INSERT INTO events (type, ts_ms, actor_user_id, payload) VALUES ($1, $2, NULL, $3::jsonb) RETURNING id`,
    [type, tsMs, JSON.stringify(payload)],
  );
  return row.rows[0]!.id;
}

beforeAll(async () => {
  DATABASE_URL = await ensureFreshIsolatedDatabase(BASE_DATABASE_URL, 'lpp_w4_plugins_delivery');
  runMigrate(DATABASE_URL);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();
}, 60_000);

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

describe('migrations/0016_plugin_delivery_cursors.sql (applied for real via scripts/migrate.mjs above, on top of the REAL 0014_plugins.sql)', () => {
  it('created plugin_delivery_cursors with the documented columns', async () => {
    const { rows } = await rawClient.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'plugin_delivery_cursors' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [
        'plugin_id',
        'cursor_event_id',
        'last_attempt_ms',
        'last_success_ms',
        'consecutive_failures',
        'delivered_batches',
        'delivered_events',
        'gap_reported_through_ms',
      ].sort(),
    );
  });

  it('added pseudonymize_actor_ids (default true) and pseudonym_salt to the REAL plugins table', async () => {
    const { rows } = await rawClient.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'plugins' AND column_name IN ('pseudonymize_actor_ids', 'pseudonym_salt')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.column_default]));
    expect(byName['pseudonymize_actor_ids']).toContain('true');
    expect(byName['pseudonym_salt']).toBeNull();
  });
});

describe('listEventSubscriberPlugins', () => {
  it('includes an enabled plugin holding the event-subscriber capability with >=1 grant', async () => {
    const id = await insertPlugin({});
    await grant(id, 'item.added');
    await grant(id, 'user.created');
    const subs = await listEventSubscriberPlugins(db);
    const found = subs.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.grantedTypes.sort()).toEqual(['item.added', 'user.created']);
    expect(found?.manifest).toMatchObject({ name: 'fixture-subscriber' });
  });

  it('excludes a disabled plugin', async () => {
    const id = await insertPlugin({ enabled: false });
    await grant(id, 'item.added');
    const subs = await listEventSubscriberPlugins(db);
    expect(subs.find((s) => s.id === id)).toBeUndefined();
  });

  it('excludes an enabled plugin with zero event grants', async () => {
    const id = await insertPlugin({});
    const subs = await listEventSubscriberPlugins(db);
    expect(subs.find((s) => s.id === id)).toBeUndefined();
  });

  it("excludes a plugin that does NOT hold the 'event-subscriber' granted capability (metadata-provider only)", async () => {
    const id = await insertPlugin({ grantedCapabilityTypes: ['metadata-provider'] });
    await grant(id, 'item.added'); // a stray grant row, ignored since the capability isn't granted
    const subs = await listEventSubscriberPlugins(db);
    expect(subs.find((s) => s.id === id)).toBeUndefined();
  });

  it('carries contentClass/pseudonymizeActorIds/pseudonymSalt through', async () => {
    const id = await insertPlugin({ contentClass: 'restricted', pseudonymizeActorIds: false });
    await grant(id, 'user.created');
    const subs = await listEventSubscriberPlugins(db);
    const found = subs.find((s) => s.id === id);
    expect(found?.contentClass).toBe('restricted');
    expect(found?.pseudonymizeActorIds).toBe(false);
    expect(found?.pseudonymSalt).toBeNull();
  });

  it('M-1 fix wave: carries non-secret config through, so the delivery loop can inject X-LPP-Config on deliveries', async () => {
    const id = await insertPlugin({ config: { webhookLabel: 'ops-channel' } });
    await grant(id, 'item.added');
    const subs = await listEventSubscriberPlugins(db);
    const found = subs.find((s) => s.id === id);
    expect(found?.config).toEqual({ webhookLabel: 'ops-channel' });
  });
});

describe('getDeliveryCursor', () => {
  it('is undefined for a plugin with no cursor row yet', async () => {
    const id = await insertPlugin({});
    expect(await getDeliveryCursor(db, id)).toBeUndefined();
  });
});

describe('ensurePseudonymSalt', () => {
  it('mints a random 64-hex-char (32-byte) salt on first call', async () => {
    const id = await insertPlugin({});
    const salt = await ensurePseudonymSalt(db, id);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the SAME salt on a second call (no re-mint)', async () => {
    const id = await insertPlugin({});
    const first = await ensurePseudonymSalt(db, id);
    const second = await ensurePseudonymSalt(db, id);
    expect(second).toBe(first);
  });

  it('two different plugins get two different (independently random) salts', async () => {
    const idA = await insertPlugin({});
    const idB = await insertPlugin({});
    const saltA = await ensurePseudonymSalt(db, idA);
    const saltB = await ensurePseudonymSalt(db, idB);
    expect(saltA).not.toBe(saltB);
  });
});

describe('recordDeliverySuccess / recordDeliveryFailure', () => {
  it('recordDeliverySuccess creates the cursor row on first call and advances cursor_event_id', async () => {
    const id = await insertPlugin({});
    const eventId = await insertEvent('item.added', 1_700_000_001_000);
    const row = await recordDeliverySuccess(db, { pluginId: id, cursorEventId: eventId, deliveredEventCount: 3, nowMs: 1_700_000_002_000 });
    expect(row.cursor_event_id).toBe(eventId);
    expect(row.delivered_batches).toBe(1);
    expect(row.delivered_events).toBe(3);
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_success_ms).toBe(1_700_000_002_000);
  });

  it('a second success accumulates delivered_batches/delivered_events and advances the cursor again', async () => {
    const id = await insertPlugin({});
    const firstEventId = await insertEvent('item.added', 1_700_000_001_000);
    await recordDeliverySuccess(db, { pluginId: id, cursorEventId: firstEventId, deliveredEventCount: 2, nowMs: 1_700_000_002_000 });
    const secondEventId = await insertEvent('item.added', 1_700_000_003_000);
    const row = await recordDeliverySuccess(db, { pluginId: id, cursorEventId: secondEventId, deliveredEventCount: 5, nowMs: 1_700_000_004_000 });
    expect(row.cursor_event_id).toBe(secondEventId);
    expect(row.delivered_batches).toBe(2);
    expect(row.delivered_events).toBe(7);
  });

  it('a success resets consecutive_failures to 0 after prior failures', async () => {
    const id = await insertPlugin({});
    await recordDeliveryFailure(db, { pluginId: id, nowMs: 1 });
    await recordDeliveryFailure(db, { pluginId: id, nowMs: 2 });
    const eventId = await insertEvent('item.added', 3);
    const row = await recordDeliverySuccess(db, { pluginId: id, cursorEventId: eventId, deliveredEventCount: 1, nowMs: 4 });
    expect(row.consecutive_failures).toBe(0);
  });

  it('recordDeliveryFailure creates the row and increments consecutive_failures, leaving cursor_event_id null', async () => {
    const id = await insertPlugin({});
    const first = await recordDeliveryFailure(db, { pluginId: id, nowMs: 100 });
    expect(first.consecutiveFailures).toBe(1);
    const second = await recordDeliveryFailure(db, { pluginId: id, nowMs: 200 });
    expect(second.consecutiveFailures).toBe(2);
    const row = await getDeliveryCursor(db, id);
    expect(row?.cursor_event_id).toBeNull();
    expect(row?.last_success_ms).toBeNull();
  });

  it('recordDeliveryFailure never touches the REAL plugins.consecutive_failures column (deliberate separation, see migration header)', async () => {
    const id = await insertPlugin({});
    await recordDeliveryFailure(db, { pluginId: id, nowMs: 1 });
    await recordDeliveryFailure(db, { pluginId: id, nowMs: 2 });
    const plugin = await db.selectFrom('plugins').select('consecutive_failures').where('id', '=', id).executeTakeFirstOrThrow();
    expect(plugin.consecutive_failures).toBe(0); // untouched — that column is Lane W2's shared breaker counter
  });

  it('gapReportedThroughMs is left unchanged when omitted, and set when provided', async () => {
    const id = await insertPlugin({});
    const e1 = await insertEvent('item.added', 10);
    await recordDeliverySuccess(db, { pluginId: id, cursorEventId: e1, deliveredEventCount: 1, nowMs: 20 });
    let row = await getDeliveryCursor(db, id);
    expect(row?.gap_reported_through_ms).toBeNull();

    const e2 = await insertEvent('item.added', 30);
    await recordDeliverySuccess(db, { pluginId: id, cursorEventId: e2, deliveredEventCount: 1, nowMs: 40, gapReportedThroughMs: 25 });
    row = await getDeliveryCursor(db, id);
    expect(row?.gap_reported_through_ms).toBe(25);

    const e3 = await insertEvent('item.added', 50);
    await recordDeliverySuccess(db, { pluginId: id, cursorEventId: e3, deliveredEventCount: 1, nowMs: 60 });
    row = await getDeliveryCursor(db, id);
    expect(row?.gap_reported_through_ms).toBe(25); // untouched by the omitted-field call
  });
});

describe('advanceCursorPastFilteredEvents', () => {
  it('advances the cursor without touching delivery-stats columns', async () => {
    const id = await insertPlugin({});
    const eventId = await insertEvent('restricted.locked', 1_700_000_005_000);
    await advanceCursorPastFilteredEvents(db, { pluginId: id, cursorEventId: eventId, nowMs: 1_700_000_006_000 });
    const row = await getDeliveryCursor(db, id);
    expect(row?.cursor_event_id).toBe(eventId);
    expect(row?.delivered_batches).toBe(0);
    expect(row?.delivered_events).toBe(0);
    expect(row?.last_success_ms).toBeNull();
    expect(row?.last_attempt_ms).toBe(1_700_000_006_000);
  });
});

describe('listCandidateEventsForDelivery', () => {
  it('returns only granted types, after the cursor, in ascending id order, capped at limit', async () => {
    const base = 1_700_100_000_000;
    const e1 = await insertEvent('item.added', base);
    const e2 = await insertEvent('user.created', base + 1);
    await insertEvent('scan.started', base + 2); // not granted — must be excluded
    const e4 = await insertEvent('item.added', base + 3);

    const rows = await listCandidateEventsForDelivery(db, { afterId: e1, grantedTypes: ['item.added', 'user.created'], limit: 100 });
    expect(rows.map((r) => r.id)).toEqual([e2, e4]);
  });

  it('respects the limit cap', async () => {
    const base = 1_700_200_000_000;
    const first = await insertEvent('library.created', base);
    for (let i = 1; i <= 5; i++) {
      await insertEvent('library.created', base + i);
    }
    const rows = await listCandidateEventsForDelivery(db, { afterId: first, grantedTypes: ['library.created'], limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it('returns [] for an empty grantedTypes list (no query issued)', async () => {
    const rows = await listCandidateEventsForDelivery(db, { afterId: '00000000-0000-7000-8000-000000000000', grantedTypes: [], limit: 10 });
    expect(rows).toEqual([]);
  });
});

describe('findOldestUnconsumedBeforeMs', () => {
  it('finds the oldest matching-type ts_ms strictly before the boundary', async () => {
    const base = 1_700_300_000_000;
    const start = await insertEvent('scan.completed', base - 1);
    await insertEvent('scan.completed', base + 100); // after cursor, but NOT before the boundary — must not match
    const old = await insertEvent('scan.completed', base + 50); // after cursor AND before the boundary — should match
    void old;
    const result = await findOldestUnconsumedBeforeMs(db, { afterId: start, grantedTypes: ['scan.completed'], beforeMs: base + 75 });
    expect(result).toBe(base + 50);
  });

  it('returns null when nothing matches (no gap)', async () => {
    const start = await insertEvent('scan.completed', 1_700_400_000_000);
    const result = await findOldestUnconsumedBeforeMs(db, { afterId: start, grantedTypes: ['scan.completed'], beforeMs: 1 });
    expect(result).toBeNull();
  });
});
