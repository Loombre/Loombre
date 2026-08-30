// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/catalog-detail.spec.ts
//
// Live-DB tests for src/query/catalog-detail.ts (getCatalogDetail /
// listCatalogItems) and src/query/libraries.ts (createLibrary) — the
// additive query surface documented in catalog-detail.ts's header. Runs
// against seed/seed.mjs's fixed shape (self-sufficient: resets + reseeds in
// beforeAll, same convention as test/identity.spec.ts).
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import type { ViewerContext } from '../src/context.js';
import { getCatalogDetail, listCatalogItems } from '../src/query/catalog-detail.js';
import { createLibrary, getLibraryForViewer } from '../src/query/libraries.js';
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
    throw new Error(
      `${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

let db: Kysely<DB>;
let adminId: string;
let casualId: string;
let libMoviesId: string;
let libRestrictedId: string;
let movieHarborLightsId: string;
let restrictedMovieId: string;
let seriesCoastlineId: string;
let seasonId: string;
let episodeId: string;
let artistId: string;
let albumId: string;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);

  const admin = await db.selectFrom('users').select('id').where('username', '=', 'admin').executeTakeFirstOrThrow();
  adminId = admin.id;
  const casual = await db.selectFrom('users').select('id').where('username', '=', 'casual').executeTakeFirstOrThrow();
  casualId = casual.id;

  const libMovies = await db.selectFrom('libraries').select('id').where('name', '=', 'Movies').executeTakeFirstOrThrow();
  libMoviesId = libMovies.id;
  const libRestricted = await db.selectFrom('libraries').select('id').where('name', '=', 'Restricted').executeTakeFirstOrThrow();
  libRestrictedId = libRestricted.id;

  const harborLights = await db
    .selectFrom('catalog_items')
    .select('id')
    .where('title', '=', 'Harbor Lights')
    .executeTakeFirstOrThrow();
  movieHarborLightsId = harborLights.id;

  const restrictedMovie = await db
    .selectFrom('catalog_items')
    .select('id')
    .where('title', '=', 'After Hours Redline')
    .executeTakeFirstOrThrow();
  restrictedMovieId = restrictedMovie.id;

  const series = await db
    .selectFrom('catalog_items')
    .select('id')
    .where('title', '=', 'Coastline Signals')
    .executeTakeFirstOrThrow();
  seriesCoastlineId = series.id;

  const season = await db
    .selectFrom('catalog_items')
    .select('id')
    .where('item_type', '=', 'season')
    .where('parent_id', '=', seriesCoastlineId)
    .executeTakeFirstOrThrow();
  seasonId = season.id;

  const episode = await db
    .selectFrom('catalog_items')
    .select('id')
    .where('item_type', '=', 'episode')
    .where('parent_id', '=', seasonId)
    .where('title', '=', 'Static on the Line')
    .executeTakeFirstOrThrow();
  episodeId = episode.id;

  const artist = await db
    .selectFrom('catalog_items')
    .select('id')
    .where('item_type', '=', 'artist')
    .executeTakeFirstOrThrow();
  artistId = artist.id;

  const album = await db
    .selectFrom('catalog_items')
    .select('id')
    .where('item_type', '=', 'album')
    .where('parent_id', '=', artistId)
    .where('title', '=', 'Low Water')
    .executeTakeFirstOrThrow();
  albumId = album.id;
});

afterAll(async () => {
  await db.destroy();
});

function ctxFor(userId: string, opts: { allowedLibraryIds: string[]; restrictedCleared: boolean, surface: 'restricted' }): ViewerContext {
  return { userId, allowedLibraryIds: opts.allowedLibraryIds, restrictedCleared: opts.restrictedCleared, surface: 'restricted' };
}

describe('getCatalogDetail', () => {
  it('attaches satellite fields, genres, and images for a movie', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const detail = await getCatalogDetail(db, ctx, movieHarborLightsId);
    expect(detail).toBeDefined();
    expect(detail!.title).toBe('Harbor Lights');
    expect(detail!.contentRating).toBe('PG-13');
    expect(detail!.runtimeMs).toBe(108 * 60_000);
    expect(detail!.genres).toEqual(['Drama']);
    expect(Array.isArray(detail!.images)).toBe(true);
  });

  it('attaches season/episode number satellite fields and grandparent id for an episode', async () => {
    const libTv = await db.selectFrom('catalog_items').select('library_id').where('id', '=', episodeId).executeTakeFirstOrThrow();
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libTv.library_id], restrictedCleared: false, surface: 'restricted' });
    const detail = await getCatalogDetail(db, ctx, episodeId);
    expect(detail).toBeDefined();
    expect(detail!.episodeNumber).toBe(1);
    expect(detail!.parent_id).toBe(seasonId);
    expect(detail!.grandparentId).toBe(seriesCoastlineId);
  });

  it('returns undefined for a restricted item when the viewer is not cleared (indistinguishable from nonexistent)', async () => {
    const ctx = ctxFor(casualId, { allowedLibraryIds: [], restrictedCleared: false, surface: 'restricted' });
    const detail = await getCatalogDetail(db, ctx, restrictedMovieId);
    expect(detail).toBeUndefined();
  });

  it('returns full detail for a restricted item when the viewer IS cleared', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libRestrictedId], restrictedCleared: true, surface: 'restricted' });
    const detail = await getCatalogDetail(db, ctx, restrictedMovieId);
    expect(detail).toBeDefined();
    expect(detail!.title).toBe('After Hours Redline');
  });

  // Gap-closure lane (deliverable D): people[] + mediaFiles[] on the
  // single-item detail read only.
  it('attaches people[] (ordered) and mediaFiles[] for a movie', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const detail = await getCatalogDetail(db, ctx, movieHarborLightsId, { includeDetail: true });
    expect(detail).toBeDefined();

    expect(detail!.people).toEqual([
      expect.objectContaining({ name: 'Elena Marsh', role: 'actor', credit: 'Lead', order: 0 }),
      expect.objectContaining({ name: 'Devon Kade', role: 'director', credit: null, order: 1 }),
    ]);
    expect(detail!.people!.every((p) => typeof p.id === 'string' && p.id.length > 0)).toBe(true);

    expect(detail!.mediaFiles).toEqual([
      expect.objectContaining({
        versionLabel: null,
        container: 'mkv',
        width: 3840,
        height: 2160,
        sizeBytes: 6_400_000_000,
        durationMs: 108 * 60_000,
        // Phosphor W2 L4 additive fields (movie-detail VERSIONS/METADATA
        // cards) — real seed.mjs media_streams rows: one HEVC/10-bit video
        // stream and one default 5.1 EAC3/eng audio stream; no subtitle
        // streams are seeded for movies at all. browser-items-F6: seed.mjs
        // sets color_transfer='smpte2084' on this row but never populates
        // media_streams.hdr, so the raw column reads back NULL — hdr
        // 'hdr10' here is deriveHdrForDisplay() reading that PQ transfer
        // (media-info.ts), not a fabricated claim; see deriveHdrForDisplay's
        // own unit tests (media-info.spec.ts) for the mapping table.
        path: '/data/movies/Harbor.Lights.mkv',
        isDefault: true,
        videoCodec: 'hevc',
        bitDepth: 10,
        hdr: 'hdr10',
        audioTracks: [{ codec: 'eac3', channels: 6, language: 'eng', isDefault: true }],
        subtitleTracks: [],
      }),
    ]);
    expect(typeof detail!.mediaFiles![0]!.id).toBe('string');
  });

  it('marks the single-file case isDefault and resolves the unlabelled row as default among multiple versions', async () => {
    // Add a second (labelled) version of Harbor Lights directly so this
    // test is self-contained — seed.mjs never creates a multi-version
    // fixture (STATE.md ground-truth check before building this: no seeded
    // movie/episode/track has more than one media_files row).
    const secondFile = await db
      .insertInto('media_files')
      .values({
        item_id: movieHarborLightsId,
        path: '/data/movies/Harbor.Lights.1080p.mp4',
        container: 'mp4',
        size_bytes: 2_000_000_000,
        duration_ms: 108 * 60_000,
        version_label: '1080p',
        probed_at_ms: Date.now(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const detail = await getCatalogDetail(db, ctx, movieHarborLightsId, { includeDetail: true });
    const files = detail!.mediaFiles!;
    expect(files).toHaveLength(2);
    const unlabelled = files.find((f) => f.versionLabel === null)!;
    const labelled = files.find((f) => f.versionLabel === '1080p')!;
    expect(unlabelled.isDefault).toBe(true);
    expect(labelled.isDefault).toBe(false);

    await db.deleteFrom('media_files').where('id', '=', secondFile.id).execute();
  });

  it('omits people/mediaFiles by default (includeDetail unset) — the cross-type search/home/export call sites never opt in', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const detail = await getCatalogDetail(db, ctx, movieHarborLightsId);
    expect(detail).toBeDefined();
    expect(detail!.people).toBeUndefined();
    expect(detail!.mediaFiles).toBeUndefined();
  });

  it('never leaks a restricted-class person credited on an otherwise-general item to an uncleared viewer (P1.21)', async () => {
    const lastFerryOut = await db
      .selectFrom('catalog_items')
      .select(['id', 'library_id'])
      .where('title', '=', 'Last Ferry Out')
      .executeTakeFirstOrThrow();

    const uncleared = ctxFor(casualId, { allowedLibraryIds: [lastFerryOut.library_id], restrictedCleared: false, surface: 'restricted' });
    const detailUncleared = await getCatalogDetail(db, uncleared, lastFerryOut.id, { includeDetail: true });
    expect(detailUncleared).toBeDefined();
    expect(detailUncleared!.people).toEqual([]); // the item is general/visible, but its ONLY credit is restricted-class

    const cleared = ctxFor(adminId, { allowedLibraryIds: [lastFerryOut.library_id], restrictedCleared: true, surface: 'restricted' });
    const detailCleared = await getCatalogDetail(db, cleared, lastFerryOut.id, { includeDetail: true });
    expect(detailCleared!.people).toEqual([
      expect.objectContaining({ name: 'Restricted Cameo Performer', role: 'guest', credit: 'Cameo', order: 1 }),
    ]);
  });
});

describe('listCatalogItems', () => {
  it('filters by itemType and libraryId, and returns exactly the seeded movie count (5 of 6 — "Paper Kingdoms" is all-missing-files-hidden per guard.ts)', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const page = await listCatalogItems(db, ctx, { itemType: 'movie', libraryId: libMoviesId, limit: 200 });
    expect(page.rows.length).toBe(5);
    expect(page.rows.every((r) => r.library_id === libMoviesId)).toBe(true);
  });

  it('filters by parentId for hierarchy listing (seasons of a series)', async () => {
    const libTv = await db.selectFrom('catalog_items').select('library_id').where('id', '=', seriesCoastlineId).executeTakeFirstOrThrow();
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libTv.library_id], restrictedCleared: false, surface: 'restricted' });
    const page = await listCatalogItems(db, ctx, { itemType: 'season', parentId: seriesCoastlineId, limit: 50 });
    expect(page.rows.length).toBe(1);
    expect(page.rows[0]!.seasonNumber).toBe(1);
  });

  it('excludes restricted movies from an uncleared viewer', async () => {
    const ctx = ctxFor(casualId, { allowedLibraryIds: [], restrictedCleared: false, surface: 'restricted' });
    const page = await listCatalogItems(db, ctx, { itemType: 'movie', limit: 200 });
    expect(page.rows.some((r) => r.title === 'After Hours Redline')).toBe(false);
  });

  // Gap-closure lane: people/mediaFiles are a single-item-GET-only cost
  // (Tier-0) — list rows must never carry them, even as an empty array.
  it('never attaches people/mediaFiles to list rows (single-item-detail-only fields)', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const page = await listCatalogItems(db, ctx, { itemType: 'movie', libraryId: libMoviesId, limit: 200 });
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.people === undefined)).toBe(true);
    expect(page.rows.every((r) => r.mediaFiles === undefined)).toBe(true);
  });
});

// A client-suppliable filter id that isn't a syntactically valid UUID used
// to be bound straight into a `uuid` column comparison, where Postgres's
// implicit cast throws 22P02 — a raw 500 for what is a client input
// mistake. Same posture as a valid-but-unentitled id (an empty page):
// "invisible == nonexistent".
describe('listCatalogItems malformed-id filters', () => {
  it('returns an empty page for a syntactically invalid libraryId instead of throwing', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const page = await listCatalogItems(db, ctx, { itemType: 'movie', libraryId: 'not-a-uuid', limit: 200 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns an empty page for a syntactically invalid parentId instead of throwing', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const page = await listCatalogItems(db, ctx, { itemType: 'season', parentId: '../../etc/passwd', limit: 50 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a forged cursor whose id is not a UUID as a malformed cursor, not a driver error', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const forged = Buffer.from(
      JSON.stringify({ sort: 'added', order: 'desc', sortKey: 1, id: 'not-a-uuid' }),
      'utf8'
    ).toString('base64url');
    await expect(
      listCatalogItems(db, ctx, { itemType: 'movie', libraryId: libMoviesId, cursor: forged })
    ).rejects.toThrow(/malformed cursor/);
  });
});

// Gap-closure lane: browse Sort control (`sort`/`order` additive params).
// The 5 visible general movies (seed.mjs; "Paper Kingdoms" stays hidden,
// missing-file rule): Harbor Lights (2019, 7.4), The Quiet Frontier
// (2021, 8.1), Neon Static (2018, 6.8), Last Ferry Out (2016, 7.2), Glass
// Orchard (2023, 8.4) — inserted in that array order, so added_at_ms is
// strictly increasing in the same order.
describe('listCatalogItems sort', () => {
  async function movieTitlesInOrder(
    params: Omit<import('../src/query/catalog-detail.js').ListCatalogItemsParams, 'itemType' | 'libraryId'>
  ): Promise<string[]> {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const page = await listCatalogItems(db, ctx, { itemType: 'movie', libraryId: libMoviesId, ...params, limit: 200 });
    return page.rows.map((r) => r.title);
  }

  it('sort=title defaults to order=asc (alphabetical)', async () => {
    expect(await movieTitlesInOrder({ sort: 'title' })).toEqual([
      'Glass Orchard',
      'Harbor Lights',
      'Last Ferry Out',
      'Neon Static',
      'The Quiet Frontier',
    ]);
  });

  it('sort=title order=desc reverses it', async () => {
    expect(await movieTitlesInOrder({ sort: 'title', order: 'desc' })).toEqual([
      'The Quiet Frontier',
      'Neon Static',
      'Last Ferry Out',
      'Harbor Lights',
      'Glass Orchard',
    ]);
  });

  it('sort=added defaults to order=desc (newest-added first) — unchanged pre-existing default behavior', async () => {
    expect(await movieTitlesInOrder({})).toEqual([
      'Glass Orchard',
      'Last Ferry Out',
      'Neon Static',
      'The Quiet Frontier',
      'Harbor Lights',
    ]);
    // sort explicitly 'added' with no order override must match the no-params default exactly.
    expect(await movieTitlesInOrder({ sort: 'added' })).toEqual(await movieTitlesInOrder({}));
  });

  it('sort=added order=asc reverses it (oldest-added first)', async () => {
    expect(await movieTitlesInOrder({ sort: 'added', order: 'asc' })).toEqual([
      'Harbor Lights',
      'The Quiet Frontier',
      'Neon Static',
      'Last Ferry Out',
      'Glass Orchard',
    ]);
  });

  it('sort=rating defaults to order=desc (highest-rated first)', async () => {
    expect(await movieTitlesInOrder({ sort: 'rating' })).toEqual([
      'Glass Orchard', // 8.4
      'The Quiet Frontier', // 8.1
      'Harbor Lights', // 7.4
      'Last Ferry Out', // 7.2
      'Neon Static', // 6.8
    ]);
  });

  it('sort=rating order=asc reverses it (lowest-rated first)', async () => {
    expect(await movieTitlesInOrder({ sort: 'rating', order: 'asc' })).toEqual([
      'Neon Static',
      'Last Ferry Out',
      'Harbor Lights',
      'The Quiet Frontier',
      'Glass Orchard',
    ]);
  });

  it('sort=year defaults to order=desc (newest year first)', async () => {
    expect(await movieTitlesInOrder({ sort: 'year' })).toEqual([
      'Glass Orchard', // 2023
      'The Quiet Frontier', // 2021
      'Harbor Lights', // 2019
      'Neon Static', // 2018
      'Last Ferry Out', // 2016
    ]);
  });

  it('sort=year order=asc reverses it (oldest year first)', async () => {
    expect(await movieTitlesInOrder({ sort: 'year', order: 'asc' })).toEqual([
      'Last Ferry Out',
      'Neon Static',
      'Harbor Lights',
      'The Quiet Frontier',
      'Glass Orchard',
    ]);
  });

  // Cursor stability: walking one row at a time via cursor must reproduce
  // EXACTLY the same total order as fetching all 5 rows in one page, for
  // every sort. Proves the keyset WHERE comparison (sortKeyExpr) matches
  // the ORDER BY expression it was built from.
  it.each([
    { sort: 'title' as const, order: undefined },
    { sort: 'added' as const, order: undefined },
    { sort: 'rating' as const, order: undefined },
    { sort: 'year' as const, order: undefined },
    { sort: 'title' as const, order: 'desc' as const },
    { sort: 'rating' as const, order: 'asc' as const },
  ])('cursor pagination (limit 2) reproduces the full order for sort=$sort order=$order', async ({ sort, order }) => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const fullPage = await listCatalogItems(db, ctx, {
      itemType: 'movie',
      libraryId: libMoviesId,
      sort,
      ...(order ? { order } : {}),
      limit: 200,
    });
    expect(fullPage.rows.length).toBe(5);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await listCatalogItems(db, ctx, {
        itemType: 'movie',
        libraryId: libMoviesId,
        sort,
        ...(order ? { order } : {}),
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(walked).toEqual(fullPage.rows.map((r) => r.id));
    expect(new Set(walked).size).toBe(5); // no duplicates, no skips
  });

  it('rejects a cursor issued under a different sort/order (stale Sort-control switch)', async () => {
    const ctx = ctxFor(adminId, { allowedLibraryIds: [libMoviesId], restrictedCleared: false, surface: 'restricted' });
    const titlePage = await listCatalogItems(db, ctx, { itemType: 'movie', libraryId: libMoviesId, sort: 'title', limit: 2 });
    expect(titlePage.nextCursor).toBeTruthy();

    await expect(
      listCatalogItems(db, ctx, {
        itemType: 'movie',
        libraryId: libMoviesId,
        sort: 'rating', // different sort than the cursor was issued under
        cursor: titlePage.nextCursor!,
        limit: 2,
      })
    ).rejects.toThrow(/malformed cursor/);
  });

  // Null-sentinel handling: albums under "The Salt Layer" (artist fixture)
  // have real, distinct years (2019/2022) but NO community_rating at all
  // (album_details never carries one) — proves sort=rating never crashes
  // on an all-NULL column, and sort=year still resolves correctly among
  // siblings sharing an item type with a nullable-in-practice rating.
  it('sort=rating over an all-NULL-rating set is stable and does not crash; sort=year still resolves', async () => {
    // albumId/artistId captured in the outer beforeAll point at "Low Water"
    // (2019) under "The Salt Layer"; fetch siblings via the artist parent.
    const libMusic = await db.selectFrom('catalog_items').select('library_id').where('id', '=', artistId).executeTakeFirstOrThrow();
    const musicCtx = ctxFor(adminId, { allowedLibraryIds: [libMusic.library_id], restrictedCleared: false, surface: 'restricted' });

    const byRating = await listCatalogItems(db, musicCtx, { itemType: 'album', parentId: artistId, sort: 'rating', limit: 200 });
    expect(byRating.rows.map((r) => r.title).sort()).toEqual(['Departures', 'Low Water']);

    const byYearDesc = await listCatalogItems(db, musicCtx, { itemType: 'album', parentId: artistId, sort: 'year', limit: 200 });
    expect(byYearDesc.rows.map((r) => r.title)).toEqual(['Departures', 'Low Water']); // 2022 before 2019

    const byYearAsc = await listCatalogItems(db, musicCtx, { itemType: 'album', parentId: artistId, sort: 'year', order: 'asc', limit: 200 });
    expect(byYearAsc.rows.map((r) => r.title)).toEqual(['Low Water', 'Departures']);
  });
});

describe('createLibrary', () => {
  it('inserts the library row and writes a library.created event in the same transaction', async () => {
    const nowMs = Date.now();
    const before = await db.selectFrom('events').select((eb) => eb.fn.countAll<string>().as('n')).where('type', '=', 'library.created').executeTakeFirstOrThrow();

    const lib = await createLibrary(db, {
      name: 'Test Library',
      mediaKind: 'movie',
      paths: ['/data/test-library'],
      actorUserId: adminId,
      nowMs,
    });

    expect(lib.name).toBe('Test Library');
    expect(lib.content_class).toBe('general');

    const after = await db.selectFrom('events').select((eb) => eb.fn.countAll<string>().as('n')).where('type', '=', 'library.created').executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n) + 1);

    const event = await db
      .selectFrom('events')
      .selectAll()
      .where('type', '=', 'library.created')
      .where('actor_user_id', '=', adminId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      libraryId: lib.id,
      name: 'Test Library',
      mediaKind: 'movie',
      contentClass: 'general',
    });
  });

  it('respects an explicit restricted contentClass', async () => {
    const nowMs = Date.now();
    const lib = await createLibrary(db, {
      name: 'Test Restricted Library',
      mediaKind: 'movie',
      paths: ['/data/test-restricted'],
      contentClass: 'restricted',
      actorUserId: adminId,
      nowMs,
    });
    expect(lib.content_class).toBe('restricted');

    const event = await db
      .selectFrom('events')
      .selectAll()
      .where('type', '=', 'library.created')
      .where('actor_user_id', '=', adminId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ libraryId: lib.id, contentClass: 'restricted' });
  });

  // Gap-closure regression: a freshly created library must be visible to
  // its creator without a separate PUT permissions call (docs/PLAN.md
  // §6.4 gate 4 is deliberate friction for RESTRICTED libraries only).
  it('auto-grants the creating admin library_permissions on a general library, in the same transaction', async () => {
    const nowMs = Date.now();
    const lib = await createLibrary(db, {
      name: 'Auto-Grant General Library',
      mediaKind: 'movie',
      paths: ['/data/auto-grant-general'],
      actorUserId: adminId,
      nowMs,
    });

    const grant = await db
      .selectFrom('library_permissions')
      .selectAll()
      .where('library_id', '=', lib.id)
      .where('user_id', '=', adminId)
      .executeTakeFirst();
    expect(grant).toBeDefined();
    expect(grant?.granted_at_ms).toBe(nowMs);

    // And the creator can actually see it through the viewer-guarded read
    // path immediately, with no further setup.
    const ctx = ctxFor(adminId, { allowedLibraryIds: [lib.id], restrictedCleared: false, surface: 'restricted' });
    const visible = await getLibraryForViewer(db, ctx, lib.id);
    expect(visible?.id).toBe(lib.id);
  });

  it('does NOT auto-grant the creating admin permission on a restricted library (gate 4 stays an explicit, separate grant)', async () => {
    const nowMs = Date.now();
    const lib = await createLibrary(db, {
      name: 'Auto-Grant Restricted Library',
      mediaKind: 'movie',
      paths: ['/data/auto-grant-restricted'],
      contentClass: 'restricted',
      actorUserId: adminId,
      nowMs,
    });

    const grant = await db
      .selectFrom('library_permissions')
      .selectAll()
      .where('library_id', '=', lib.id)
      .where('user_id', '=', adminId)
      .executeTakeFirst();
    expect(grant).toBeUndefined();

    // Default-deny holds even for the creating admin, including all 5
    // gates: no grant means it never resolves into allowedLibraryIds, so
    // the guarded read stays invisible until PUT /permissions runs.
    const ctx = ctxFor(adminId, { allowedLibraryIds: [], restrictedCleared: true, surface: 'restricted' });
    const invisible = await getLibraryForViewer(db, ctx, lib.id);
    expect(invisible).toBeUndefined();
  });
});
