// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/library-provider-chains.spec.ts
//
// Live-DB tests for src/query/library-provider-chains.ts (LPP v1, Lane W3,
// migrations/0015_library_provider_chains.sql) — mirrors test/plugins.spec.ts's
// exact convention (own reset+reseed). This is layer 1 of LPP v1's
// three-layer C5 STRICT defense-in-depth (write time / chain-resolution
// time / adapter-construction time — the other two layers are covered by
// apps/worker/test/metadata/chain-resolution.spec.ts and
// plugin-provider.spec.ts): replaceLibraryProviderChain must reject a
// `plugin` entry outright whenever that plugin's content_class does not
// EQUAL the target library's content_class, in BOTH mismatch directions.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { ContentClass, DB } from '../src/types.js';
import { getUserByUsername } from '../src/query/identity.js';
import { insertPluginAndEmit } from '../src/query/plugins.js';
import {
  InvalidLibraryProviderEntryError,
  LibraryNotFoundError,
  LibraryProviderChainScopeError,
  PluginNotFoundError,
  getLibraryProviderChain,
  replaceLibraryProviderChain,
} from '../src/query/library-provider-chains.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

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
let adminUserId: string;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  const admin = await getUserByUsername(db, 'admin');
  if (!admin) throw new Error('seed did not create the expected admin user');
  adminUserId = admin.id;
});

afterAll(async () => {
  await db?.destroy();
});

async function makeLibrary(contentClass: ContentClass = 'general'): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('libraries')
    .values({ name: `lib-${randomUUID()}`, media_kind: 'movie', paths: [], content_class: contentClass, created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

function fixtureManifest() {
  return {
    name: 'chain-fixture-plugin',
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
  };
}

async function makePlugin(contentClass: ContentClass): Promise<string> {
  const pluginId = randomUUID();
  await insertPluginAndEmit(db, {
    id: pluginId,
    name: `chain-fixture-${pluginId}`,
    baseUrl: `http://127.0.0.1:${1024 + Math.floor(Math.random() * 10_000)}`,
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

describe('library-provider-chains queries', () => {
  it('getLibraryProviderChain returns [] for a library with no chain configured', async () => {
    const libraryId = await makeLibrary();
    expect(await getLibraryProviderChain(db, libraryId)).toEqual([]);
  });

  it('replaceLibraryProviderChain writes builtin + plugin entries in the given order (position = array index)', async () => {
    const libraryId = await makeLibrary('general');
    const pluginId = await makePlugin('general');

    const rows = await replaceLibraryProviderChain(db, libraryId, [
      { providerKind: 'builtin', builtinName: 'tmdb' },
      { providerKind: 'plugin', pluginId },
      { providerKind: 'builtin', builtinName: 'tvdb' },
    ]);

    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows[0]).toMatchObject({ provider_kind: 'builtin', builtin_name: 'tmdb', plugin_id: null });
    expect(rows[1]).toMatchObject({ provider_kind: 'plugin', builtin_name: null, plugin_id: pluginId });
    expect(rows[2]).toMatchObject({ provider_kind: 'builtin', builtin_name: 'tvdb', plugin_id: null });

    const readBack = await getLibraryProviderChain(db, libraryId);
    expect(readBack.map((r) => [r.position, r.provider_kind])).toEqual([
      [0, 'builtin'],
      [1, 'plugin'],
      [2, 'builtin'],
    ]);
  });

  it('replaceLibraryProviderChain REPLACES wholesale — a second call fully overwrites the first', async () => {
    const libraryId = await makeLibrary('general');
    await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'builtin', builtinName: 'tmdb' }]);
    const second = await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'builtin', builtinName: 'musicbrainz' }]);
    expect(second).toHaveLength(1);
    expect(second[0]?.builtin_name).toBe('musicbrainz');

    const readBack = await getLibraryProviderChain(db, libraryId);
    expect(readBack).toHaveLength(1);
    expect(readBack[0]?.builtin_name).toBe('musicbrainz');
  });

  it('replaceLibraryProviderChain([]) clears the chain', async () => {
    const libraryId = await makeLibrary('general');
    await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'builtin', builtinName: 'tmdb' }]);
    const cleared = await replaceLibraryProviderChain(db, libraryId, []);
    expect(cleared).toEqual([]);
    expect(await getLibraryProviderChain(db, libraryId)).toEqual([]);
  });

  it('throws LibraryNotFoundError for a non-existent library', async () => {
    await expect(replaceLibraryProviderChain(db, randomUUID(), [{ providerKind: 'builtin', builtinName: 'tmdb' }])).rejects.toThrow(LibraryNotFoundError);
  });

  it('throws PluginNotFoundError for a plugin entry naming a non-existent plugin', async () => {
    const libraryId = await makeLibrary('general');
    await expect(replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId: randomUUID() }])).rejects.toThrow(PluginNotFoundError);
  });

  it('throws InvalidLibraryProviderEntryError for a malformed entry (builtin without builtinName) — builtinName/pluginId are TS-optional so this is only a RUNTIME shape violation', async () => {
    const libraryId = await makeLibrary('general');
    await expect(replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'builtin' }])).rejects.toThrow(InvalidLibraryProviderEntryError);
  });

  it('throws InvalidLibraryProviderEntryError for a malformed entry (plugin entry also setting builtinName)', async () => {
    const libraryId = await makeLibrary('general');
    const pluginId = await makePlugin('general');
    await expect(
      replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId, builtinName: 'tmdb' }])
    ).rejects.toThrow(InvalidLibraryProviderEntryError);
  });

  describe('L-4 fix wave: builtinName cannot smuggle a plugin-provider reference', () => {
    it('rejects a builtinName using the reserved "lpp:" prefix, at the QUERY layer, independent of any caller-side allowlist', async () => {
      const libraryId = await makeLibrary('restricted');
      const generalPluginId = await makePlugin('general');
      // The exact L-4 exploit shape: a "builtin" entry naming a GENERAL
      // plugin's adapter name on a RESTRICTED library — before this fix,
      // validateEntryShape only checked builtinName PRESENCE, never
      // content, and the C5 STRICT check below only ever ran for
      // providerKind:"plugin" entries, so this bypassed all three C5
      // layers (chain-resolution.ts's builtin branch pushes builtin_name
      // into the resolved chain with NO C5 check at all).
      await expect(
        replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'builtin', builtinName: `lpp:${generalPluginId}` }]),
      ).rejects.toThrow(InvalidLibraryProviderEntryError);
      // Rejected wholesale — nothing was written.
      expect(await getLibraryProviderChain(db, libraryId)).toEqual([]);
    });

    it('a legitimate builtin name (no reserved prefix) is unaffected', async () => {
      const libraryId = await makeLibrary('general');
      const rows = await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'builtin', builtinName: 'tmdb' }]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.builtin_name).toBe('tmdb');
    });
  });

  describe('C5 STRICT (layer 1 — write time)', () => {
    it('rejects a restricted-scoped plugin in a general library chain', async () => {
      const libraryId = await makeLibrary('general');
      const pluginId = await makePlugin('restricted');
      await expect(replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId }])).rejects.toThrow(LibraryProviderChainScopeError);
      // Rejected wholesale — nothing was written.
      expect(await getLibraryProviderChain(db, libraryId)).toEqual([]);
    });

    it('rejects a general-scoped plugin in a restricted library chain (the STRICT direction — not the old asymmetric rule)', async () => {
      const libraryId = await makeLibrary('restricted');
      const pluginId = await makePlugin('general');
      await expect(replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId }])).rejects.toThrow(LibraryProviderChainScopeError);
      expect(await getLibraryProviderChain(db, libraryId)).toEqual([]);
    });

    it('accepts a restricted-scoped plugin in a restricted library chain', async () => {
      const libraryId = await makeLibrary('restricted');
      const pluginId = await makePlugin('restricted');
      const rows = await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId }]);
      expect(rows).toHaveLength(1);
    });

    it('accepts a general-scoped plugin in a general library chain', async () => {
      const libraryId = await makeLibrary('general');
      const pluginId = await makePlugin('general');
      const rows = await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'plugin', pluginId }]);
      expect(rows).toHaveLength(1);
    });

    it('the whole call is rejected (no partial write) when ONE of several entries fails C5 — an earlier valid entry must not be committed', async () => {
      const libraryId = await makeLibrary('general');
      const goodPluginId = await makePlugin('general');
      const badPluginId = await makePlugin('restricted');
      await expect(
        replaceLibraryProviderChain(db, libraryId, [
          { providerKind: 'plugin', pluginId: goodPluginId },
          { providerKind: 'plugin', pluginId: badPluginId },
        ])
      ).rejects.toThrow(LibraryProviderChainScopeError);
      expect(await getLibraryProviderChain(db, libraryId)).toEqual([]);
    });
  });

  it('removing a plugin CASCADEs its library_provider_entries rows (migration FK)', async () => {
    const libraryId = await makeLibrary('general');
    const pluginId = await makePlugin('general');
    await replaceLibraryProviderChain(db, libraryId, [
      { providerKind: 'builtin', builtinName: 'tmdb' },
      { providerKind: 'plugin', pluginId },
    ]);
    await db.deleteFrom('plugins').where('id', '=', pluginId).execute();

    const remaining = await getLibraryProviderChain(db, libraryId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.builtin_name).toBe('tmdb');
  });

  it('removing a library CASCADEs its library_provider_entries rows (migration FK)', async () => {
    const libraryId = await makeLibrary('general');
    await replaceLibraryProviderChain(db, libraryId, [{ providerKind: 'builtin', builtinName: 'tmdb' }]);
    await db.deleteFrom('libraries').where('id', '=', libraryId).execute();

    const rows = await db.selectFrom('library_provider_entries').selectAll().where('library_id', '=', libraryId).execute();
    expect(rows).toEqual([]);
  });
});
