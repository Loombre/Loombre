// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/chain-resolution.spec.ts
//
// Live-DB integration tests for resolveProviderChainForLibrary (LPP v1,
// Lane W3, mission point 3). SELF-SUFFICIENT: resets @loombre/db's schema
// and seeds its own fixtures (mirrors apps/worker/test/metadata/
// consumer.spec.ts's own convention).
//
// Covers:
//   - Behavior-neutrality proof (mission point 5): ZERO
//     library_provider_entries rows resolves to the legacy
//     PROVIDER_CHAIN default VERBATIM, for all three media kinds.
//   - Builtin + plugin entries resolve in `position` order; a plugin
//     entry gets registered into the shared ProviderRegistry under its
//     stable `lpp:<pluginId>` name.
//   - C5 STRICT, layer 2 (chain-resolution time): a plugin entry is
//     EXCLUDED from the resolved chain when its content_class no longer
//     matches the target — proven via a direct row mutation that
//     bypasses write-time (layer 1) enforcement, demonstrating layer 2
//     catches what layer 1 cannot (a plugin re-approved with a different
//     content_class AFTER a chain already referenced it).
//   - C6 (a dead plugin must not stall a scan): 5 consecutive
//     network-error failures against a real (closed-port) plugin trip
//     this worker process's PluginCircuitBreaker and durably disable the
//     plugin row (setPluginEnabledAndEmit/setPluginHealthAndEmit) — the
//     mission's literal "on threshold trip call ... through @loombre/db"
//     pairing.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb, getUserByUsername, insertPluginAndEmit, replaceLibraryProviderChain, resolveTestDatabaseUrl } from '@loombre/db';
import type { PluginBreakerSeed } from '@loombre/plugin-host';
import { resolveProviderChainForLibrary } from '../../src/metadata/chain-resolution.js';
import { createPluginBreakerRegistry } from '../../src/metadata/plugin-breakers.js';
import { ProviderRegistry } from '../../src/metadata/registry.js';
import { PROVIDER_CHAIN } from '../../src/metadata/provider-chain-defaults.js';
import type { ContentClass, MediaKind } from '../../src/metadata/provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');
const DATABASE_URL = resolveTestDatabaseUrl();

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: ReturnType<typeof createDb>;
let rawClient: pg.Client;
let adminUserId: string;

beforeAll(async () => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  // getUserByUsername needs a seeded admin — run the db package's own seed
  // once (mirrors packages/db/test/plugins.spec.ts).
  run(path.join(DB_PKG_ROOT, 'seed', 'seed.mjs'), []);
  const admin = await getUserByUsername(db, 'admin');
  if (!admin) throw new Error('seed did not create the expected admin user');
  adminUserId = admin.id;
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

async function makeLibrary(contentClass: ContentClass = 'general', mediaKind: MediaKind = 'movie'): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('libraries')
    .values({ name: `lib-${randomUUID()}`, media_kind: mediaKind, paths: [], content_class: contentClass, created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

function fixtureManifest() {
  return {
    name: 'chain-res-fixture-plugin',
    version: '0.1.0',
    protocolVersion: 1,
    capabilities: [
      {
        type: 'metadata-provider',
        mediaKinds: ['movie', 'tv'],
        contentClass: 'general',
        endpoints: { search: '/lpp/provider/search', details: '/lpp/provider/details', images: '/lpp/provider/images' },
      },
    ],
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    description: 'fixture',
    publisher: 'Loombre',
  };
}

async function makePlugin(contentClass: ContentClass, baseUrl: string): Promise<string> {
  const pluginId = randomUUID();
  await insertPluginAndEmit(db, {
    id: pluginId,
    name: `chain-res-fixture-${pluginId}`,
    baseUrl,
    version: '0.1.0',
    protocolVersion: 1,
    contentClass,
    grantedCapabilityTypes: ['metadata-provider'],
    eventTypes: [],
    lanAllowlist: ['127.0.0.1'],
    manifest: fixtureManifest(),
    config: {},
    actorUserId: adminUserId,
    nowMs: Date.now(),
  });
  return pluginId;
}

/** Binds an ephemeral port then immediately releases it, so the URL
 *  reliably refuses connections (ECONNREFUSED -> 'network-error',
 *  BREAKER_COUNTED_REASONS) without needing a real timeout wait. */
async function closedPortBaseUrl(): Promise<string> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('resolveProviderChainForLibrary', () => {
  it('behavior-neutrality (mission point 5): zero rows resolves to the legacy PROVIDER_CHAIN default verbatim, for all three media kinds', async () => {
    const libraryId = await makeLibrary('general', 'movie');
    const registry = new ProviderRegistry();
    const breakers = createPluginBreakerRegistry();
    const deps = { registry, getBreaker: (id: string) => breakers.getBreaker(id), log: () => {} };

    for (const mediaKind of ['movie', 'tv', 'music'] as const) {
      const chain = await resolveProviderChainForLibrary(db, libraryId, mediaKind, 'general', deps);
      expect(chain).toEqual(PROVIDER_CHAIN[mediaKind]);
    }
  });

  it('resolves builtin + plugin entries in position order, registering the plugin under lpp:<pluginId>', async () => {
    const libraryId = await makeLibrary('general', 'tv');
    const baseUrl = await closedPortBaseUrl();
    const pluginId = await makePlugin('general', baseUrl);
    await replaceLibraryProviderChain(db, libraryId, [
      { providerKind: 'builtin', builtinName: 'tmdb' },
      { providerKind: 'plugin', pluginId },
      { providerKind: 'builtin', builtinName: 'tvdb' },
    ]);

    const registry = new ProviderRegistry();
    const breakers = createPluginBreakerRegistry();
    const chain = await resolveProviderChainForLibrary(db, libraryId, 'tv', 'general', {
      registry,
      getBreaker: (id) => breakers.getBreaker(id),
      log: () => {},
    });

    expect(chain).toEqual(['tmdb', `lpp:${pluginId}`, 'tvdb']);
    const registered = registry.get(`lpp:${pluginId}`);
    expect(registered).toBeDefined();
    expect(registered?.contentClass).toBe('general');
    expect(registered?.kinds).toEqual(['movie', 'tv']);
  });

  it('C5 STRICT, layer 2: excludes a plugin entry whose content_class no longer matches the target — catches what layer-1 write-time enforcement cannot (a post-write divergence)', async () => {
    const libraryId = await makeLibrary('general', 'movie');
    const baseUrl = await closedPortBaseUrl();
    const pluginId = await makePlugin('general', baseUrl);
    await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId }]);

    // Simulate a plugin re-approved to 'restricted' AFTER the chain was
    // written — a direct row mutation, bypassing replaceLibraryProviderChain
    // (layer 1) entirely, to prove layer 2 is a genuinely independent check.
    await db.updateTable('plugins').set({ content_class: 'restricted' }).where('id', '=', pluginId).execute();

    const registry = new ProviderRegistry();
    const breakers = createPluginBreakerRegistry();
    const logs: string[] = [];
    const chain = await resolveProviderChainForLibrary(db, libraryId, 'movie', 'general', {
      registry,
      getBreaker: (id) => breakers.getBreaker(id),
      log: (m) => logs.push(m),
    });

    expect(chain).toEqual([]);
    expect(registry.get(`lpp:${pluginId}`)).toBeUndefined();
    expect(logs.some((m) => m.includes('C5 STRICT'))).toBe(true);
  });

  describe('C6 breaker trip disables a dead plugin durably (through @loombre/db)', () => {
    it('5 consecutive network-error failures trip this process’s breaker and disable the plugin row + emit health-changed', async () => {
      const libraryId = await makeLibrary('general', 'movie');
      const baseUrl = await closedPortBaseUrl(); // reliably ECONNREFUSED
      const pluginId = await makePlugin('general', baseUrl);
      await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId }]);

      const registry = new ProviderRegistry();
      const breakers = createPluginBreakerRegistry();
      const deps = { registry, getBreaker: (id: string) => breakers.getBreaker(id), log: () => {} };

      // Each resolution call re-reads the plugin row fresh and (re-)registers
      // a fresh adapter closed over the SAME per-process breaker instance —
      // exactly the real consumer.ts flow, one metadata job at a time.
      // chain-resolution.ts's C5/grant filters don't consult plugin.enabled
      // (that's resolveViaProviderChain's/registry's job), so all 5
      // iterations resolve the same single-entry chain regardless of the
      // breaker having tripped mid-loop.
      for (let i = 0; i < 5; i += 1) {
        const chain = await resolveProviderChainForLibrary(db, libraryId, 'movie', 'general', deps);
        expect(chain).toHaveLength(1);
        const provider = registry.get(chain[0]!);
        await expect(provider!.search({ mediaKind: 'movie', title: 'x' })).rejects.toThrow();
      }

      const row = await db.selectFrom('plugins').selectAll().where('id', '=', pluginId).executeTakeFirstOrThrow();
      expect(row.enabled).toBe(false);
      expect(row.disabled_reason).toBe('breaker');
      expect(row.consecutive_failures).toBeGreaterThanOrEqual(5);

      const { rows: events } = await rawClient.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM events WHERE payload ->> 'pluginId' = $1 ORDER BY ts_ms ASC, id ASC`,
        [pluginId]
      );
      const disabledEvent = events.find((e) => e.type === 'plugin.disabled');
      expect(disabledEvent?.payload).toMatchObject({ reason: 'breaker' });
      const healthEvent = events.find((e) => e.type === 'plugin.health-changed');
      expect(healthEvent?.payload).toMatchObject({ newState: 'unhealthy' });
    }, 30_000);
  });

  // C5.1 fix wave (closes deferred LPP L-5, worker-side — mirrors
  // apps/server/src/plugins/plugin-health.service.ts's identical fix).
  // Unlike the server's health-check path (which writes consecutive_failures
  // to the DB on EVERY check), this adapter's maybeDisableOnBreakerTrip only
  // persists the durable counter at the MOMENT a breaker trips — so a
  // worker-local restart mid-window has nothing of its OWN to lose. The
  // real risk this closes is cross-process: apps/server's periodic health
  // check writes the SAME plugins.consecutive_failures column on its own
  // cadence, so a worker process that has never called a given plugin yet
  // must not construct a fresh breaker blind to failures another process
  // already recorded there.
  describe('C5.1: a fresh breaker registry (simulated restart) seeds from plugins.consecutive_failures', () => {
    it('a durable count another process already recorded is not silently discarded by this process’s first breaker construction', async () => {
      const libraryId = await makeLibrary('general', 'movie');
      const baseUrl = await closedPortBaseUrl(); // reliably ECONNREFUSED
      const pluginId = await makePlugin('general', baseUrl);
      await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId }]);

      // Simulate: apps/server's periodic health check already recorded 3
      // consecutive failures for this plugin, durably — even though THIS
      // worker process has never attempted a call to it yet (its own
      // breaker registry is brand new, exactly like a fresh restart).
      await db.updateTable('plugins').set({ consecutive_failures: 3 }).where('id', '=', pluginId).execute();

      const registry = new ProviderRegistry();
      const breakers = createPluginBreakerRegistry();
      const deps = {
        registry,
        getBreaker: (id: string, seed?: PluginBreakerSeed) => breakers.getBreaker(id, seed),
        log: () => {},
      };

      // Exactly 2 MORE failures — not 5 — must now trip it, proving the
      // durable count seeded this process's fresh breaker instead of
      // starting at 0.
      for (let i = 0; i < 2; i += 1) {
        const chain = await resolveProviderChainForLibrary(db, libraryId, 'movie', 'general', deps);
        expect(chain).toHaveLength(1);
        const provider = registry.get(chain[0]!);
        await expect(provider!.search({ mediaKind: 'movie', title: 'x' })).rejects.toThrow();
      }

      const row = await db.selectFrom('plugins').selectAll().where('id', '=', pluginId).executeTakeFirstOrThrow();
      expect(row.enabled).toBe(false);
      expect(row.disabled_reason).toBe('breaker');
      expect(row.consecutive_failures).toBe(5);
    }, 30_000);

    it('WITHOUT seeding (documents the pre-fix bug this closes): a fresh registry that never forwards the seed needs the FULL 5 failures regardless of the durable count', async () => {
      const libraryId = await makeLibrary('general', 'movie');
      const baseUrl = await closedPortBaseUrl();
      const pluginId = await makePlugin('general', baseUrl);
      await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId }]);

      await db.updateTable('plugins').set({ consecutive_failures: 3 }).where('id', '=', pluginId).execute();

      const registry = new ProviderRegistry();
      const breakers = createPluginBreakerRegistry();
      // Deliberately does NOT forward `seed` — the OLD call shape, kept
      // working (backward-compatible) but unseeded on purpose here.
      const deps = { registry, getBreaker: (id: string) => breakers.getBreaker(id), log: () => {} };

      for (let i = 0; i < 2; i += 1) {
        const chain = await resolveProviderChainForLibrary(db, libraryId, 'movie', 'general', deps);
        const provider = registry.get(chain[0]!);
        await expect(provider!.search({ mediaKind: 'movie', title: 'x' })).rejects.toThrow();
      }

      const row = await db.selectFrom('plugins').selectAll().where('id', '=', pluginId).executeTakeFirstOrThrow();
      // Only 2 (unseeded) worker-local failures — nowhere near enough to
      // trip a 5-threshold breaker that never saw the durable 3.
      expect(row.enabled).toBe(true);
      expect(row.consecutive_failures).toBe(3); // the durable value from setup, untouched (never tripped, never written)
    }, 30_000);
  });
});
