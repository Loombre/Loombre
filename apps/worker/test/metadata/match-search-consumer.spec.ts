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
import { createDb, ensureTestDatabase, resolveTestDatabaseUrl } from '@loombre/db';
import { metadataSearchConsumerHandler, type MatchCandidate } from '../../src/metadata/match-search-consumer.js';
import { ProviderFetchError } from '../../src/metadata/cache.js';
import { ProviderRegistry } from '../../src/metadata/registry.js';
import { makeFakeProvider } from '../../src/metadata/test-support.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');

// PER-SUITE DATABASE (Wave A / A1's recommendation, swept at pre-D
// consolidation). This suite RESETS the schema in its own hook; on the
// shared `<base>_test` database a sibling package's reset landing mid-run
// wipes it out from under whatever is executing and presents as a product
// bug. `ensureTestDatabase` gives it one of its own — resolved at module
// load (top-level await) so every describe-scope handle below is built
// against the right connection string.
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), 'worker_match_search_test');

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

async function latestMatchCandidatesEvent(
  itemId: string
): Promise<{ candidates: MatchCandidate[]; jobId: string; providersSearched?: string[] } | undefined> {
  const rows = await db
    .selectFrom('events')
    .select(['payload'])
    .where('type', '=', 'metadata.match-candidates')
    .orderBy('id', 'desc')
    .execute();
  const match = rows.find((r) => (r.payload as { itemId: string }).itemId === itemId);
  return match
    ? (match.payload as unknown as { candidates: MatchCandidate[]; jobId: string; providersSearched?: string[] })
    : undefined;
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

  // d4-e1 (M/browser-items-F13-adjacent, backlog #081): an empty
  // candidates[] meant two opposite things — "every provider was asked and
  // none matched" and "no provider was asked at all", the second being what
  // a keyless instance ALWAYS looks like. Fix Match rendered the first
  // sentence for both, so the one state an admin can act on read as the one
  // they cannot. The payload now names the providers actually searched.
  it('names the providers it actually searched, so a keyless instance is not reported as a genuine no-match', async () => {
    const itemId = await insertItem('Searched By Someone', 2019, 'series', null, tvLibraryId);
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'tmdb', kinds: ['tv'], searchResults: [] }));
    registry.register(makeFakeProvider({ name: 'tvdb', kinds: ['tv'], searchResults: [] }));

    const handler = metadataSearchConsumerHandler({ db, registry, log: () => {} });
    await handler({ itemId }, { jobId: 'search-job-providers-1' });

    const result = await latestMatchCandidatesEvent(itemId);
    expect(result!.candidates).toEqual([]);
    expect(result!.providersSearched).toEqual(['tmdb', 'tvdb']);
  });

  it('reports providersSearched: [] when every provider in the chain is disabled (no API key)', async () => {
    const itemId = await insertItem('Nothing Was Searched', 2019, 'series', null, tvLibraryId);
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'tmdb', kinds: ['tv'], enabled: false, disabledReason: 'no api key' }));
    registry.register(makeFakeProvider({ name: 'tvdb', kinds: ['tv'], enabled: false, disabledReason: 'no api key' }));

    const handler = metadataSearchConsumerHandler({ db, registry, log: () => {} });
    await handler({ itemId }, { jobId: 'search-job-providers-2' });

    const result = await latestMatchCandidatesEvent(itemId);
    expect(result!.candidates).toEqual([]);
    // The distinction the whole field exists for: an empty ARRAY, not an
    // absent field — this search ran and asked nobody.
    expect(result!.providersSearched).toEqual([]);
  });

  it('counts a provider that threw as searched — it was asked, it just failed', async () => {
    const itemId = await insertItem('Asked And Broke', 2018, 'series', null, tvLibraryId);
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'tmdb', kinds: ['tv'], failSearch: true }));
    registry.register(makeFakeProvider({ name: 'tvdb', kinds: ['tv'], searchResults: [] }));

    const handler = metadataSearchConsumerHandler({ db, registry, log: () => {} });
    await handler({ itemId }, { jobId: 'search-job-providers-3' });

    const result = await latestMatchCandidatesEvent(itemId);
    expect(result!.providersSearched).toEqual(['tmdb', 'tvdb']);
  });

  it('omits providersSearched entirely when no search stage was reached (the item vanished mid-flight)', async () => {
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'tmdb', kinds: ['movie'] }));
    const handler = metadataSearchConsumerHandler({ db, registry, log: () => {} });

    const missingItemId = '018f6f1e-0000-7000-8000-00000000beef';
    await handler({ itemId: missingItemId }, { jobId: 'search-job-providers-4' });

    const result = await latestMatchCandidatesEvent(missingItemId);
    // Absent, not []: "[]" is a claim about a chain that was resolved and
    // asked nobody. No chain was resolved here, and the client must fall
    // back to its generic copy rather than blame missing API keys.
    expect(result!.providersSearched).toBeUndefined();
  });

  // AUD-A7c-002: this handler's own per-provider catch block (line
  // ~150-153) forwards err.message straight into log(), same shape as
  // consumer.ts's resolveViaProviderChain — a TMDB ProviderFetchError's
  // .message carries the full request URL, `?api_key=<secret>` included
  // (cache.ts). Asserts on the emitted log CONTENT, not on log() merely
  // having been called.
  it('redacts a leaked TMDB api_key out of provider-failure log lines (AUD-A7c-002)', async () => {
    const itemId = await insertItem('Redaction Probe', 2020, 'series', null, tvLibraryId);
    const FAKE_KEY = 'sekrit0123456789abcdef0123456789';
    const brokenTmdb = makeFakeProvider({
      name: 'tmdb',
      kinds: ['tv'],
      failSearch: new ProviderFetchError(`https://api.themoviedb.org/3/search/tv?api_key=${FAKE_KEY}&query=redaction+probe`, 401, 'Unauthorized'),
    });
    const registry = new ProviderRegistry();
    registry.register(brokenTmdb);

    const logs: string[] = [];
    const handler = metadataSearchConsumerHandler({ db, registry, log: (message) => logs.push(message) });
    await handler({ itemId }, { jobId: 'search-job-redact-key' });

    expect(logs.length).toBeGreaterThan(0); // the failure DID get logged...
    for (const line of logs) {
      expect(line).not.toContain(FAKE_KEY); // ...but never with the key inside it.
    }
  });
});
