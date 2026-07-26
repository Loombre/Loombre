// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/match-search-consumer.spec.ts
//
// Integration test for metadataSearchConsumerHandler (Phosphor retheme
// Wave 2, Lane L2 — Fix Match's POST /admin/items/{id}/match-search) with
// FakeProvider end-to-end against a live DB. SELF-SUFFICIENT: resets
// @loombre/db's schema.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '@loombre/db';
import { metadataSearchConsumerHandler, type MatchCandidate } from '../../src/metadata/match-search-consumer.js';
import { ProviderRegistry } from '../../src/metadata/registry.js';
import { makeFakeProvider } from '../../src/metadata/test-support.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

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
let libraryId: string; // media_kind: 'movie' -> PROVIDER_CHAIN resolves ['tmdb'] only
let tvLibraryId: string; // media_kind: 'tv' -> PROVIDER_CHAIN resolves ['tmdb', 'tvdb']

async function insertItem(
  title: string,
  year: number | null,
  itemType: 'movie' | 'series' | 'artist' | 'album' | 'season' = 'movie',
  parentId: string | null = null,
  targetLibraryId: string = libraryId
): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('catalog_items')
    .values({ library_id: targetLibraryId, item_type: itemType, parent_id: parentId, title, sort_title: title, year, added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

async function latestMatchCandidatesEvent(itemId: string): Promise<{ candidates: MatchCandidate[]; jobId: string } | undefined> {
  const rows = await db
    .selectFrom('events')
    .select(['payload'])
    .where('type', '=', 'metadata.match-candidates')
    .orderBy('id', 'desc')
    .execute();
  const match = rows.find((r) => (r.payload as { itemId: string }).itemId === itemId);
  return match ? (match.payload as unknown as { candidates: MatchCandidate[]; jobId: string }) : undefined;
}

beforeAll(async () => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({ name: 'Match Search Test Library', media_kind: 'movie', paths: [], content_class: 'general', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  libraryId = lib.id;

  // PROVIDER_CHAIN['tv'] = ['tmdb', 'tvdb'] (provider-chain-defaults.ts) —
  // tests that need MULTIPLE providers actually queried use this library,
  // since PROVIDER_CHAIN['movie'] is 'tmdb' only.
  const tvLib = await db
    .insertInto('libraries')
    .values({ name: 'Match Search TV Test Library', media_kind: 'tv', paths: [], content_class: 'general', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  tvLibraryId = tvLib.id;
});

afterAll(async () => {
  await db?.destroy();
});

describe('metadataSearchConsumerHandler (Phosphor retheme Wave 2, Lane L2 — Fix Match)', () => {
  it('ranks candidates across EVERY provider in the chain, best-first, exactly one isBest', async () => {
    // PROVIDER_CHAIN['tv'] = ['tmdb', 'tvdb'] — the tv library so BOTH
    // providers are actually queried (PROVIDER_CHAIN['movie'] is 'tmdb' only).
    const itemId = await insertItem('The Great Heist', 2014, 'series', null, tvLibraryId);

    const tmdb = makeFakeProvider({
      name: 'tmdb',
      contentClass: 'general',
      kinds: ['tv'],
      searchResults: [
        { ref: { provider: 'tmdb', externalId: 'exact', mediaKind: 'tv' }, title: 'The Great Heist', year: 2014 },
        { ref: { provider: 'tmdb', externalId: 'off-by-years', mediaKind: 'tv' }, title: 'The Great Heist', year: 1990 },
      ],
    });
    const tvdb = makeFakeProvider({
      name: 'tvdb',
      contentClass: 'general',
      kinds: ['tv'],
      searchResults: [{ ref: { provider: 'tvdb', externalId: 'weak', mediaKind: 'tv' }, title: 'Totally Different Title', year: 2014 }],
    });
    const registry = new ProviderRegistry();
    registry.register(tmdb);
    registry.register(tvdb);

    const handler = metadataSearchConsumerHandler({ db, registry, log: () => {} });
    await handler({ itemId }, { jobId: 'search-job-1' });

    const result = await latestMatchCandidatesEvent(itemId);
    expect(result).toBeDefined();
    expect(result!.candidates.length).toBeGreaterThanOrEqual(3);
    expect(result!.candidates.filter((c) => c.isBest)).toHaveLength(1);
    expect(result!.candidates[0]!.externalId).toBe('exact');
    expect(result!.candidates[0]!.isBest).toBe(true);
    expect(result!.candidates[0]!.confidence).toBeGreaterThan(result!.candidates[1]!.confidence);
    // Never touches the catalog — this job only searches and reports.
    const item = await db.selectFrom('catalog_items').select(['title']).where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('The Great Heist');
    const providerIds = await db.selectFrom('provider_ids').select(['id']).where('item_id', '=', itemId).execute();
    expect(providerIds).toHaveLength(0);
  });

  it('one provider throwing does not block the rest of the chain', async () => {
    const itemId = await insertItem('Resilient Title', 2020, 'series', null, tvLibraryId);

    const brokenProvider = makeFakeProvider({ name: 'tmdb', kinds: ['tv'], failSearch: true });
    const workingProvider = makeFakeProvider({
      name: 'tvdb',
      kinds: ['tv'],
      searchResults: [{ ref: { provider: 'tvdb', externalId: 'ok', mediaKind: 'tv' }, title: 'Resilient Title', year: 2020 }],
    });
    const registry = new ProviderRegistry();
    registry.register(brokenProvider);
    registry.register(workingProvider);

    const handler = metadataSearchConsumerHandler({ db, registry, log: () => {} });
    await expect(handler({ itemId }, { jobId: 'search-job-2' })).resolves.toBeUndefined();

    const result = await latestMatchCandidatesEvent(itemId);
    expect(result).toBeDefined();
    expect(result!.candidates).toHaveLength(1);
    expect(result!.candidates[0]!.provider).toBe('tvdb');
    expect(result!.candidates[0]!.isBest).toBe(true);
  });

  it('an item that no longer exists delivers an empty candidate list, never throws', async () => {
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'tmdb', kinds: ['movie'] }));
    const handler = metadataSearchConsumerHandler({ db, registry, log: () => {} });

    const missingItemId = '018f6f1e-0000-7000-8000-00000000dead';
    await expect(handler({ itemId: missingItemId }, { jobId: 'search-job-3' })).resolves.toBeUndefined();

    const result = await latestMatchCandidatesEvent(missingItemId);
    expect(result).toBeDefined();
    expect(result!.candidates).toEqual([]);
  });

  it('a non-enrichable item type (season) delivers an empty candidate list', async () => {
    const seriesId = await insertItem('Some Series', 2021, 'series');
    const seasonId = await insertItem('Season 1', 2021, 'season', seriesId);
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'tmdb', kinds: ['tv'] }));
    const handler = metadataSearchConsumerHandler({ db, registry, log: () => {} });

    await handler({ itemId: seasonId }, { jobId: 'search-job-4' });
    const result = await latestMatchCandidatesEvent(seasonId);
    expect(result).toBeDefined();
    expect(result!.candidates).toEqual([]);
  });
});
