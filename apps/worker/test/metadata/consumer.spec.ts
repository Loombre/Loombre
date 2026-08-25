// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/consumer.spec.ts
//
// Integration test for metadataConsumerHandler (P1.6/P1.7) with
// FakeProvider end-to-end against a live DB. SELF-SUFFICIENT: resets
// @loombre/db's schema and seeds a minimal fixture of its own.
//
// Deliberately does NOT import the `pg` package directly (apps/worker has
// no dependency on it, and dependency-cruiser reserves raw pg/kysely
// access for packages/db) — every setup/assertion query goes through the
// `db` handle from @loombre/db's createDb(), using Kysely's query builder
// structurally (same trick src/metadata/item-read.ts uses).
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, ensureTestDatabase, resolveTestDatabaseUrl } from '@loombre/db';
import { upsertMetadataProvenance } from '@loombre/db/internal';
import { ForcedMatchUnresolvableError, metadataConsumerHandler } from '../../src/metadata/consumer.js';
import { ProviderFetchError } from '../../src/metadata/cache.js';
import { ProviderRegistry } from '../../src/metadata/registry.js';
import { makeFakeProvider } from '../../src/metadata/test-support.js';
import type { ProviderDetails } from '../../src/metadata/provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');

// PER-SUITE DATABASE (Wave A / A1's recommendation, swept at pre-D
// consolidation). This suite RESETS the schema in its own hook; on the
// shared `<base>_test` database a sibling package's reset landing mid-run
// wipes it out from under whatever is executing and presents as a product
// bug. `ensureTestDatabase` gives it one of its own — resolved at module
// load (top-level await) so every describe-scope handle below is built
// against the right connection string.
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), 'worker_metadata_consumer_test');

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
let libraryId: string;

async function insertItem(
  title: string,
  year: number | null,
  itemType: 'movie' | 'series' | 'artist' | 'album' = 'movie',
  parentId: string | null = null
): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('catalog_items')
    .values({ library_id: libraryId, item_type: itemType, parent_id: parentId, title, sort_title: title, year, added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

const MOVIE_DETAILS: ProviderDetails = {
  itemType: 'movie',
  title: 'The Great Heist',
  sortTitle: 'Great Heist, The',
  year: 2014,
  overview: 'A crew pulls one last job.',
  communityRating: 7.8,
  contentRating: 'R',
  genres: ['Action', 'Crime'],
  tags: ['heist'],
  people: [
    { name: 'Jane Doe', role: 'actor', order: 0, credit: 'Lead' },
    { name: 'John Smith', role: 'director', order: 1, credit: null },
  ],
  providerIds: { tmdb: '12345' },
  tagline: 'One last job.',
  runtimeMs: 7_260_000,
};

beforeAll(async () => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);

  const now = Date.now();
  const lib = await db
    .insertInto('libraries')
    .values({ name: 'Consumer Test Library', media_kind: 'movie', paths: [], content_class: 'general', created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  libraryId = lib.id;
});

// ---------------------------------------------------------------------------
// d4-f3 support: a REAL stub LPP plugin over an ephemeral port plus a real
// `plugins` row, so the forced-ref branch can be exercised end to end
// against the same adapter the chain would have built (pattern copied from
// apps/worker/test/metadata/plugin-provider.spec.ts's own stub server).
// ---------------------------------------------------------------------------
const lppServers: Server[] = [];

type RouteHandler = () => { status: number; body: unknown };

function startStubLppServer(routes: Record<string, RouteHandler>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {});
    req.on('end', () => {
      const handler = routes[`${req.method} ${req.url}`];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no route' }));
        return;
      }
      const { status, body } = handler();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      lppServers.push(server);
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const LPP_MOVIE_DETAILS = {
  itemType: 'movie',
  title: 'A Forced LPP Movie',
  sortTitle: 'Forced LPP Movie, A',
  year: 2019,
  overview: 'Chosen by the admin, not by the chain.',
  communityRating: 6.5,
  contentRating: 'PG',
  genres: ['Drama'],
  tags: ['fixture'],
  people: [],
  providerIds: { fixture: '42' },
  tagline: null,
  runtimeMs: null,
};

/** Inserts a registered + approved plugin row directly (this suite has no
 *  seeded admin user, and insertPluginAndEmit's outbox event needs one) —
 *  the row is all chain-resolution/plugin-provider ever read. */
async function insertLppPlugin(baseUrl: string, opts: { enabled?: boolean } = {}): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto('plugins')
    .values({
      name: `forced-ref-fixture-${randomUUID()}`,
      base_url: baseUrl,
      version: '0.1.0',
      protocol_version: 1,
      enabled: opts.enabled ?? true,
      content_class: 'general',
      granted_capability_types: ['metadata-provider'],
      lan_allowlist: ['127.0.0.1'],
      manifest: {
        name: 'forced-ref-fixture-plugin',
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
      },
      config: {},
      created_at_ms: now,
      updated_at_ms: now,
      approved_at_ms: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

afterAll(async () => {
  for (const server of lppServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db?.destroy();
});

describe('metadataConsumerHandler', () => {
  it('resolves a match, writes catalog_items/satellite/provider_ids/tags/people/provenance, emits item.updated, and enqueues poster+backdrop image jobs', async () => {
    const itemId = await insertItem('The Great Heist', 2014);

    const tmdb = makeFakeProvider({
      name: 'tmdb',
      contentClass: 'general',
      kinds: ['movie'],
      searchResults: [{ ref: { provider: 'tmdb', externalId: '12345', mediaKind: 'movie' }, title: 'The Great Heist', year: 2014 }],
      details: MOVIE_DETAILS,
      images: [
        { kind: 'poster', url: 'https://example.invalid/poster.jpg', width: 2000, height: 3000 },
        { kind: 'backdrop', url: 'https://example.invalid/backdrop.jpg', width: 3840, height: 2160 },
        { kind: 'logo', url: 'https://example.invalid/logo.png' }, // must NOT be enqueued
      ],
    });
    const registry = new ProviderRegistry();
    registry.register(tmdb);

    const enqueueImageJob = vi.fn(async () => 'job-id');
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: () => {} });

    await handler({ itemId, mediaKind: 'movie', contentClass: 'general' }, { jobId: 'test-job-1' });

    const item = await db
      .selectFrom('catalog_items')
      .select(['title', 'sort_title', 'year', 'community_rating'])
      .where('id', '=', itemId)
      .executeTakeFirstOrThrow();
    expect(item).toEqual({ title: 'The Great Heist', sort_title: 'Great Heist, The', year: 2014, community_rating: 7.8 });

    const satellite = await db
      .selectFrom('movie_details')
      .select(['overview', 'content_rating', 'tagline', 'runtime_ms'])
      .where('item_id', '=', itemId)
      .executeTakeFirstOrThrow();
    expect(satellite).toEqual({
      overview: 'A crew pulls one last job.',
      content_rating: 'R',
      tagline: 'One last job.',
      runtime_ms: 7_260_000,
    });

    const providerIds = await db.selectFrom('provider_ids').select(['provider', 'external_id']).where('item_id', '=', itemId).execute();
    expect(providerIds).toEqual([{ provider: 'tmdb', external_id: '12345' }]);

    const tags = await db
      .selectFrom('item_tags')
      .innerJoin('tags', 'tags.id', 'item_tags.tag_id')
      .select(['tags.name as name', 'item_tags.kind as kind'])
      .where('item_tags.item_id', '=', itemId)
      .execute();
    expect(tags).toEqual(
      expect.arrayContaining([
        { name: 'Action', kind: 'genre' },
        { name: 'Crime', kind: 'genre' },
        { name: 'heist', kind: 'tag' },
      ])
    );

    const people = await db
      .selectFrom('item_people')
      .innerJoin('people', 'people.id', 'item_people.person_id')
      .select(['people.name as name', 'item_people.role as role', 'item_people.credit as credit'])
      .where('item_people.item_id', '=', itemId)
      .orderBy('item_people.ord', 'asc')
      .execute();
    expect(people).toEqual([
      { name: 'Jane Doe', role: 'actor', credit: 'Lead' },
      { name: 'John Smith', role: 'director', credit: null },
    ]);

    const provenance = await db.selectFrom('metadata_provenance').select(['field', 'source']).where('item_id', '=', itemId).execute();
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance.every((r) => r.source === 'provider:tmdb')).toBe(true);

    const events = await db.selectFrom('events').select(['payload']).where('type', '=', 'item.updated').execute();
    const ourEvents = events.filter((e) => (e.payload as { itemId: string }).itemId === itemId);
    expect(ourEvents).toHaveLength(1);
    const changedFields = (ourEvents[0]!.payload as { changedFields: string[] }).changedFields;
    expect(changedFields).toEqual(expect.arrayContaining(['overview', 'contentRating', 'tagline', 'runtimeMs']));

    expect(enqueueImageJob).toHaveBeenCalledTimes(2);
    expect(enqueueImageJob).toHaveBeenCalledWith({
      entityType: 'catalog_item',
      entityId: itemId,
      kind: 'poster',
      sourcePath: 'url:https://example.invalid/poster.jpg',
    });
    expect(enqueueImageJob).toHaveBeenCalledWith({
      entityType: 'catalog_item',
      entityId: itemId,
      kind: 'backdrop',
      sourcePath: 'url:https://example.invalid/backdrop.jpg',
    });
  });

  // Regression (gap-closure lane, Wave-2 real-scan finding): the scanner's
  // find-or-create hierarchy (apps/worker/src/scan/hierarchy.ts) correctly
  // sets album.parent_id = artist.id at creation, but metadataConsumerHandler
  // enriches that same album afterwards via upsertCatalogItem WITHOUT
  // passing parentId — and upsertCatalogItem's ON CONFLICT clause always
  // overwrites parent_id with `excluded.parent_id`, which defaults to NULL
  // when the caller omits it (packages/db/src/internal/catalog.ts). Net
  // effect: any album that gets provider-matched loses its artist link.
  it('preserves an album item.parent_id (artist link) across a metadata enrichment write', async () => {
    const artistId = await insertItem('The Fake Band', null, 'artist');
    const albumId = await insertItem('Fake Album', 2020, 'album', artistId);

    const albumDetails: ProviderDetails = {
      itemType: 'album',
      title: 'Fake Album (Remastered)',
      sortTitle: 'Fake Album (Remastered)',
      year: 2020,
      overview: null,
      communityRating: null,
      contentRating: null,
      genres: ['Rock'],
      tags: [],
      people: [],
      providerIds: { musicbrainz: 'mbid-album-1' },
    };
    const musicbrainz = makeFakeProvider({
      name: 'musicbrainz',
      kinds: ['music'],
      searchResults: [{ ref: { provider: 'musicbrainz', externalId: 'mbid-album-1', mediaKind: 'music', entityKind: 'album' }, title: 'Fake Album', year: 2020 }],
      details: albumDetails,
    });
    const registry = new ProviderRegistry();
    registry.register(musicbrainz);

    const enqueueImageJob = vi.fn(async () => 'job-id');
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: () => {} });

    await handler({ itemId: albumId, mediaKind: 'music', contentClass: 'general' }, { jobId: 'test-job-album-parent' });

    const row = await db
      .selectFrom('catalog_items')
      .select(['parent_id', 'title'])
      .where('id', '=', albumId)
      .executeTakeFirstOrThrow();
    expect(row.title).toBe('Fake Album (Remastered)'); // enrichment did run
    expect(row.parent_id).toBe(artistId); // and must NOT have nulled the artist link
  });

  it('never overwrites a locked field, even with a matched provider', async () => {
    const itemId = await insertItem('The Great Heist', 2014);
    await upsertMetadataProvenance(db, { itemId, field: 'title', source: 'nfo', locked: true, updatedAtMs: Date.now() });

    const tmdb = makeFakeProvider({
      name: 'tmdb',
      kinds: ['movie'],
      searchResults: [{ ref: { provider: 'tmdb', externalId: '12345', mediaKind: 'movie' }, title: 'The Great Heist', year: 2014 }],
      details: MOVIE_DETAILS,
    });
    const registry = new ProviderRegistry();
    registry.register(tmdb);

    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob: vi.fn(async () => 'x'), log: () => {} });
    await handler({ itemId, mediaKind: 'movie', contentClass: 'general' }, { jobId: 'test-job-2' });

    const item = await db.selectFrom('catalog_items').select('title').where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('The Great Heist'); // unchanged (was already this value pre-lock)

    const prov = await db
      .selectFrom('metadata_provenance')
      .select('source')
      .where('item_id', '=', itemId)
      .where('field', '=', 'title')
      .executeTakeFirstOrThrow();
    expect(prov.source).toBe('nfo'); // not overwritten to provider:tmdb
  });

  it('falls back tmdb -> tvdb for tv when tmdb has no match', async () => {
    const itemId = await insertItem('Late Night Signal', 2019, 'series');

    const tmdb = makeFakeProvider({ name: 'tmdb', kinds: ['tv'], searchResults: [] });
    const tvdb = makeFakeProvider({
      name: 'tvdb',
      kinds: ['tv'],
      searchResults: [{ ref: { provider: 'tvdb', externalId: '79488', mediaKind: 'tv' }, title: 'Late Night Signal', year: 2019 }],
      details: {
        itemType: 'series',
        title: 'Late Night Signal',
        sortTitle: 'Late Night Signal',
        year: 2019,
        overview: 'A radio host uncovers something.',
        communityRating: 8.1,
        contentRating: null,
        genres: ['Drama'],
        tags: [],
        people: [],
        providerIds: { tvdb: '79488' },
        status: 'continuing',
        airDateMs: Date.parse('2019-10-01'),
      },
    });
    const registry = new ProviderRegistry();
    registry.register(tmdb);
    registry.register(tvdb);

    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob: vi.fn(async () => 'x'), log: () => {} });
    await handler({ itemId, mediaKind: 'tv', contentClass: 'general' }, { jobId: 'test-job-3' });

    const providerIds = await db.selectFrom('provider_ids').select(['provider', 'external_id']).where('item_id', '=', itemId).execute();
    expect(providerIds).toEqual([{ provider: 'tvdb', external_id: '79488' }]);
  });

  it('is a no-op for an item that no longer exists (race with deletion)', async () => {
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ name: 'tmdb', kinds: ['movie'] }));
    const enqueueImageJob = vi.fn(async () => 'x');
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: () => {} });

    await expect(
      handler({ itemId: '018f6f1e-0000-7000-8000-00000000dead', mediaKind: 'movie', contentClass: 'general' }, { jobId: 'test-job-4' })
    ).resolves.toBeUndefined();
    expect(enqueueImageJob).not.toHaveBeenCalled();
  });

  it('is a no-op when no provider in the chain finds a match', async () => {
    const itemId = await insertItem('Totally Unfindable Title', 2014);
    const tmdb = makeFakeProvider({ name: 'tmdb', kinds: ['movie'], searchResults: [] });
    const registry = new ProviderRegistry();
    registry.register(tmdb);

    const enqueueImageJob = vi.fn(async () => 'x');
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: () => {} });
    await handler({ itemId, mediaKind: 'movie', contentClass: 'general' }, { jobId: 'test-job-5' });

    const events = await db.selectFrom('events').select(['payload']).where('type', '=', 'item.updated').execute();
    const ourEvents = events.filter((e) => (e.payload as { itemId: string }).itemId === itemId);
    expect(ourEvents).toHaveLength(0);
    expect(enqueueImageJob).not.toHaveBeenCalled();
  });

  it('forceRef (Phosphor retheme Wave 2, Lane L2 — Fix Match apply-match) bypasses search entirely and applies EXACTLY the chosen candidate', async () => {
    const itemId = await insertItem('Ambiguous Heist Movie', 2014);

    // A search that would pick a DIFFERENT candidate than the one the admin
    // chose — proves forceRef never calls search()/pickBestMatch at all.
    const searchSpy = vi.fn(async () => [
      { ref: { provider: 'tmdb', externalId: 'wrong-id', mediaKind: 'movie' as const }, title: 'Wrong Movie', year: 1999 },
    ]);
    const tmdb = makeFakeProvider({ name: 'tmdb', contentClass: 'general', kinds: ['movie'], details: MOVIE_DETAILS });
    tmdb.search = searchSpy;
    const registry = new ProviderRegistry();
    registry.register(tmdb);

    const enqueueImageJob = vi.fn(async () => 'x');
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: () => {} });

    await handler(
      { itemId, mediaKind: 'movie', contentClass: 'general', forceRef: { provider: 'tmdb', externalId: '12345' } },
      { jobId: 'test-job-forceref' }
    );

    expect(searchSpy).not.toHaveBeenCalled();

    const item = await db.selectFrom('catalog_items').select(['title']).where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('The Great Heist'); // MOVIE_DETAILS.title, not the item's original title or the search stub's

    const providerIds = await db
      .selectFrom('provider_ids')
      .select(['provider', 'external_id'])
      .where('item_id', '=', itemId)
      .execute();
    expect(providerIds).toEqual([{ provider: 'tmdb', external_id: '12345' }]);
  });

  // d4-f3 (backlog #084) SUPERSEDES the original "forceRef against an
  // unregistered provider no-ops (never throws, never partially applies)".
  // The no-op half is what the finding is ABOUT: the admin's explicit
  // apply-match was reported back as a job that 'completed' with error
  // null having changed nothing, so the one surface that could have told
  // them (GET /admin/jobs/{id}) said everything went fine. "Never
  // partially applies" is still pinned — the throw happens BEFORE any
  // write — but the job now fails visibly instead of lying.
  it('d4-f3: forceRef against a provider this worker cannot resolve FAILS the job (never partially applies)', async () => {
    const itemId = await insertItem('Some Movie', 2014);
    const registry = new ProviderRegistry(); // nothing registered
    const enqueueImageJob = vi.fn(async () => 'x');
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: () => {} });

    await expect(
      handler(
        { itemId, mediaKind: 'movie', contentClass: 'general', forceRef: { provider: 'tmdb', externalId: '12345' } },
        { jobId: 'test-job-forceref-missing' }
      )
    ).rejects.toBeInstanceOf(ForcedMatchUnresolvableError);
    expect(enqueueImageJob).not.toHaveBeenCalled();

    const item = await db.selectFrom('catalog_items').select(['title']).where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('Some Movie'); // untouched — the failure is before any write
  });

  // d4-f3 (backlog #084), THE REPORTED SHAPE: an `lpp:<pluginId>` forced
  // ref for a registered+enabled plugin that NO library chain has attached
  // in this worker process's lifetime. resolveForcedMatch only ever did
  // registry.get(), and the registry is only ever populated by chain
  // resolution — so this used to log-and-skip and complete with error null.
  it('d4-f3: forceRef naming a registered+enabled LPP plugin constructs the adapter ON DEMAND (no chain attachment needed)', async () => {
    const itemId = await insertItem('Chain-less Plugin Movie', 2019);
    const { baseUrl } = await startStubLppServer({
      'POST /lpp/provider/details': () => ({ status: 200, body: { details: LPP_MOVIE_DETAILS } }),
      'POST /lpp/provider/images': () => ({ status: 200, body: { images: [] } }),
    });
    const pluginId = await insertLppPlugin(baseUrl);

    // Deliberately EMPTY: no chain resolution has ever run in this
    // "process", so nothing has registered an lpp:<pluginId> adapter.
    const registry = new ProviderRegistry();
    const enqueueImageJob = vi.fn(async () => 'x');
    const logs: string[] = [];
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: (m) => logs.push(m) });

    await handler(
      { itemId, mediaKind: 'movie', contentClass: 'general', forceRef: { provider: `lpp:${pluginId}`, externalId: '42' } },
      { jobId: 'test-job-forceref-lpp' }
    );

    const item = await db.selectFrom('catalog_items').select(['title']).where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('A Forced LPP Movie');

    const providerIds = await db.selectFrom('provider_ids').select(['provider', 'external_id']).where('item_id', '=', itemId).execute();
    expect(providerIds).toEqual([{ provider: 'fixture', external_id: '42' }]);

    // The adapter is registered under its STABLE name, so a second forced
    // ref in the same process reuses it via the ordinary registry lookup.
    expect(registry.get(`lpp:${pluginId}`)).toBeDefined();
    expect(logs.some((m) => m.includes('is not registered or disabled'))).toBe(false);
  });

  it('d4-f3: forceRef naming a DISABLED plugin fails the job rather than silently completing', async () => {
    const itemId = await insertItem('Disabled Plugin Movie', 2019);
    const { baseUrl } = await startStubLppServer({
      'POST /lpp/provider/details': () => ({ status: 200, body: { details: LPP_MOVIE_DETAILS } }),
    });
    const pluginId = await insertLppPlugin(baseUrl, { enabled: false });

    const registry = new ProviderRegistry();
    const enqueueImageJob = vi.fn(async () => 'x');
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: () => {} });

    await expect(
      handler(
        { itemId, mediaKind: 'movie', contentClass: 'general', forceRef: { provider: `lpp:${pluginId}`, externalId: '42' } },
        { jobId: 'test-job-forceref-lpp-disabled' }
      )
    ).rejects.toBeInstanceOf(ForcedMatchUnresolvableError);

    const item = await db.selectFrom('catalog_items').select(['title']).where('id', '=', itemId).executeTakeFirstOrThrow();
    expect(item.title).toBe('Disabled Plugin Movie');
  });

  // AUD-A7c-002: a failed TMDB request's ProviderFetchError carries the raw
  // request URL — including `?api_key=<secret>` — verbatim in its .message
  // (cache.ts:59). resolveViaProviderChain forwards err.message straight
  // into log() (consumer.ts's catch block), so the key must never survive
  // from provider failure to the emitted log line. Asserts on the actual
  // captured log CONTENT, not on whether log() was called — a mock-called
  // assertion would pass even with the key still embedded in the string.
  it('redacts a leaked TMDB api_key out of provider-failure log lines (AUD-A7c-002)', async () => {
    const itemId = await insertItem('Redaction Probe', 2014);
    const FAKE_KEY = 'sekrit0123456789abcdef0123456789';
    const failingTmdb = makeFakeProvider({
      name: 'tmdb',
      kinds: ['movie'],
      failSearch: new ProviderFetchError(`https://api.themoviedb.org/3/search/movie?api_key=${FAKE_KEY}&query=redaction+probe`, 401, 'Unauthorized'),
    });
    const registry = new ProviderRegistry();
    registry.register(failingTmdb);

    const logs: string[] = [];
    const enqueueImageJob = vi.fn(async () => 'x');
    const handler = metadataConsumerHandler({ db, registry, enqueueImageJob, log: (message) => logs.push(message) });

    await handler({ itemId, mediaKind: 'movie', contentClass: 'general' }, { jobId: 'test-job-redact-key' });

    expect(enqueueImageJob).not.toHaveBeenCalled(); // the provider failed — no-op, same as "no match found"
    expect(logs.length).toBeGreaterThan(0); // the failure DID get logged...
    for (const line of logs) {
      expect(line).not.toContain(FAKE_KEY); // ...but never with the key inside it.
    }
  });
});
