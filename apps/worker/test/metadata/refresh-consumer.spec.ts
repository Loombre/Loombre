// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/refresh-consumer.spec.ts
//
// Live-DB test for the 'metadata-refresh' fan-out and the worker's boot-time
// "provider newly enabled" check. Self-sufficient: resets @loombre/db's
// schema and seeds two libraries (movie: default chain [tmdb]; music:
// default chain [musicbrainz]) with a matched and an unmatched item.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, ensureTestDatabase, resolveTestDatabaseUrl } from '@loombre/db';
import { getMetadataProviderState, upsertMetadataProviderState, upsertProviderId } from '@loombre/db/internal';
import { ProviderRegistry } from '../../src/metadata/registry.js';
import { makeFakeProvider } from '../../src/metadata/test-support.js';
import { enqueueRefreshForNewlyEnabledProviders, runMetadataRefresh } from '../../src/metadata/refresh-consumer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), 'worker_metadata_refresh_test');

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: DB_PKG_ROOT, env: { ...process.env, DATABASE_URL }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
}

let db: ReturnType<typeof createDb>;
let movieLibId: string;
let musicLibId: string;
let matchedMovieId: string;
let unmatchedMovieId: string;
let episodeId: string;
let unmatchedAlbumId: string;

async function insertLibrary(name: string, mediaKind: 'movie' | 'music'): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('libraries')
    .values({ name, media_kind: mediaKind, paths: [], content_class: 'general', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertItem(libraryId: string, itemType: 'movie' | 'episode' | 'album', title: string): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('catalog_items')
    .values({ library_id: libraryId, item_type: itemType, title, sort_title: title, added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
  movieLibId = await insertLibrary('Refresh Movies', 'movie');
  musicLibId = await insertLibrary('Refresh Music', 'music');
  matchedMovieId = await insertItem(movieLibId, 'movie', 'Matched Movie');
  unmatchedMovieId = await insertItem(movieLibId, 'movie', 'Unmatched Movie');
  episodeId = await insertItem(movieLibId, 'episode', 'Not Enrichable Episode');
  unmatchedAlbumId = await insertItem(musicLibId, 'album', 'Unmatched Album');
  await upsertProviderId(db, { itemId: matchedMovieId, provider: 'tmdb', externalId: '603' });
});

afterAll(async () => {
  await db?.destroy();
});

function registryWith(opts: { tmdbEnabled: boolean }): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(makeFakeProvider({ name: 'tmdb', kinds: ['movie', 'tv'], enabled: opts.tmdbEnabled, disabledReason: 'no key' }));
  registry.register(makeFakeProvider({ name: 'musicbrainz', kinds: ['music'] }));
  return registry;
}

describe('runMetadataRefresh', () => {
  it('provider-scoped, unmatched: only libraries whose chain includes the provider, only enrichable items with no provider_ids row', async () => {
    const enqueue = vi.fn(async () => 'job');
    const summary = await runMetadataRefresh(
      { db, registry: registryWith({ tmdbEnabled: true }), enqueueMetadataJob: enqueue, log: () => {}, pageSize: 1 },
      { libraryId: null, provider: 'tmdb', scope: 'unmatched' }
    );
    expect(summary).toEqual({ librariesVisited: 1, librariesSkipped: 1, itemsEnqueued: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ itemId: unmatchedMovieId, mediaKind: 'movie', contentClass: 'general' }, { subjectItemId: unmatchedMovieId });
    // The run records the provider as enabled so the next boot does not fan out again.
    expect((await getMetadataProviderState(db, 'tmdb'))?.enabled).toBe(true);
  });

  it('provider-scoped with the provider disabled: enqueues nothing and records nothing', async () => {
    await db.deleteFrom('metadata_provider_state').where('provider', '=', 'tmdb').execute();
    const enqueue = vi.fn(async () => 'job');
    const log = vi.fn();
    const summary = await runMetadataRefresh(
      { db, registry: registryWith({ tmdbEnabled: false }), enqueueMetadataJob: enqueue, log },
      { libraryId: null, provider: 'tmdb', scope: 'unmatched' }
    );
    expect(summary.itemsEnqueued).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not enabled'));
    expect(await getMetadataProviderState(db, 'tmdb')).toBeUndefined();
  });

  it("library-scoped 'all': every enrichable item; an existing match rides along as forceRef, the episode never appears", async () => {
    const enqueue = vi.fn(async () => 'job');
    const summary = await runMetadataRefresh(
      { db, registry: registryWith({ tmdbEnabled: true }), enqueueMetadataJob: enqueue, log: () => {} },
      { libraryId: movieLibId, provider: null, scope: 'all' }
    );
    expect(summary).toEqual({ librariesVisited: 1, librariesSkipped: 0, itemsEnqueued: 2 });
    expect(enqueue).toHaveBeenCalledWith(
      { itemId: matchedMovieId, mediaKind: 'movie', contentClass: 'general', forceRef: { provider: 'tmdb', externalId: '603' } },
      { subjectItemId: matchedMovieId }
    );
    expect(enqueue).toHaveBeenCalledWith({ itemId: unmatchedMovieId, mediaKind: 'movie', contentClass: 'general' }, { subjectItemId: unmatchedMovieId });
    const ids = enqueue.mock.calls.map((c) => (c as unknown as [{ itemId: string }])[0].itemId);
    expect(ids).not.toContain(episodeId);
  });

  it("library-scoped 'unmatched' on the music library reaches the album", async () => {
    const enqueue = vi.fn(async () => 'job');
    await runMetadataRefresh(
      { db, registry: registryWith({ tmdbEnabled: true }), enqueueMetadataJob: enqueue, log: () => {} },
      { libraryId: musicLibId, provider: null, scope: 'unmatched' }
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ itemId: unmatchedAlbumId, mediaKind: 'music', contentClass: 'general' }, { subjectItemId: unmatchedAlbumId });
  });
});

describe('enqueueRefreshForNewlyEnabledProviders (worker boot)', () => {
  it('fans out once when a provider is enabled and the last recorded state is absent or disabled; not when already recorded enabled', async () => {
    await db.deleteFrom('metadata_provider_state').execute();
    const enqueue = vi.fn(async () => 'job');
    const registry = registryWith({ tmdbEnabled: true });

    // First boot: no row -> enqueue for tmdb; musicbrainz is not a keyed provider here.
    expect(await enqueueRefreshForNewlyEnabledProviders(db, registry, ['tmdb', 'tvdb'], enqueue, getMetadataProviderState)).toEqual(['tmdb']);
    expect(enqueue).toHaveBeenCalledWith({ libraryId: null, provider: 'tmdb', scope: 'unmatched' });
    expect((await getMetadataProviderState(db, 'tmdb'))?.enabled).toBe(true);
    expect((await getMetadataProviderState(db, 'tvdb'))?.enabled).toBe(false);

    // Second boot, nothing changed: silent.
    enqueue.mockClear();
    expect(await enqueueRefreshForNewlyEnabledProviders(db, registry, ['tmdb', 'tvdb'], enqueue, getMetadataProviderState)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();

    // Key removed, then re-added between boots: disabled is recorded, then the flip fans out again.
    await upsertMetadataProviderState(db, { provider: 'tmdb', enabled: false, observedAtMs: 1 });
    expect(await enqueueRefreshForNewlyEnabledProviders(db, registry, ['tmdb'], enqueue, getMetadataProviderState)).toEqual(['tmdb']);
  });
});
