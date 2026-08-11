// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/providers/tmdb.spec.ts
//
// Two layers:
//  1. Pure mapper unit tests against checked-in fixture JSON (no network,
//     no DB) — mapMovieDetails/mapSeriesDetails/mapSeasonDetails/
//     mapEpisodeDetails/mapImages.
//  2. A thin end-to-end wiring test (fake fetch, real dedicated DB via
//     @loombre/db) proving search/fetchDetails/fetchImages actually flow
//     through cachedGet + the rate limiter + the mappers together.
//
// Live network contract test: providers/tmdb.live.spec.ts.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createDb, ensureTestDatabase, resolveTestDatabaseUrl } from '@loombre/db';
import {
  createTmdbProvider,
  mapEpisodeDetails,
  mapImages,
  mapMovieDetails,
  mapSeasonDetails,
  mapSeriesDetails,
  type TmdbMovieDetailsResponse,
  type TmdbSeasonResponse,
  type TmdbTvDetailsResponse,
} from '../../../src/metadata/providers/tmdb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'tmdb');
const DB_PKG_ROOT = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db');

// PER-SUITE DATABASE (Wave A / A1's recommendation, swept at pre-D
// consolidation). This suite RESETS the schema in its own hook; on the
// shared `<base>_test` database a sibling package's reset landing mid-run
// wipes it out from under whatever is executing and presents as a product
// bug. `ensureTestDatabase` gives it one of its own — resolved at module
// load (top-level await) so every describe-scope handle below is built
// against the right connection string.
const DATABASE_URL = await ensureTestDatabase(resolveTestDatabaseUrl(), 'worker_tmdb_test');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

describe('tmdb mappers (fixture-based, no network)', () => {
  it('mapMovieDetails maps title/year/overview/rating/genres/tagline/runtime/credits', () => {
    const json = fixture<TmdbMovieDetailsResponse>('movie-details');
    const details = mapMovieDetails(json, '603');

    expect(details.itemType).toBe('movie');
    expect(details.title).toBe('The Matrix');
    expect(details.year).toBe(1999);
    expect(details.communityRating).toBe(8.2);
    expect(details.genres).toEqual(['Action', 'Science Fiction']);
    expect(details.tagline).toBe('Welcome to the Real World.');
    expect(details.runtimeMs).toBe(136 * 60_000);
    expect(details.providerIds).toEqual({ tmdb: '603' });

    const neo = details.people.find((p) => p.name === 'Keanu Reeves');
    expect(neo).toEqual({ name: 'Keanu Reeves', role: 'actor', order: 0, credit: 'Neo' });
    const directors = details.people.filter((p) => p.role === 'director');
    expect(directors.map((d) => d.name)).toEqual(['Lana Wachowski', 'Lilly Wachowski']);
  });

  it('mapSeriesDetails maps status enum + first-air-date', () => {
    const json = fixture<TmdbTvDetailsResponse>('tv-details');
    const details = mapSeriesDetails(json, '1399');

    expect(details.itemType).toBe('series');
    expect(details.title).toBe('Game of Thrones');
    expect(details.status).toBe('ended');
    expect(details.year).toBe(2011);
    expect(details.airDateMs).toBe(Date.parse('2011-04-17'));
  });

  it('mapSeasonDetails / mapEpisodeDetails extract season+episode fields', () => {
    const json = fixture<TmdbSeasonResponse>('tv-season');
    const season = mapSeasonDetails(json, '1399');
    expect(season.itemType).toBe('season');
    expect(season.seasonNumber).toBe(1);

    const episode = json.episodes?.find((e) => e.episode_number === 1);
    expect(episode).toBeDefined();
    const mapped = mapEpisodeDetails(episode!, 1, '1399');
    expect(mapped.itemType).toBe('episode');
    expect(mapped.seasonNumber).toBe(1);
    expect(mapped.episodeNumber).toBe(1);
    expect(mapped.title).toBe('Winter Is Coming');
    expect(mapped.people.some((p) => p.role === 'guest' && p.name === 'Sean Bean')).toBe(true);
  });

  it('mapImages builds absolute URLs from the image base + file_path, tagged by kind', () => {
    const json = fixture<{ posters: { file_path: string; width: number; height: number }[]; backdrops: unknown[]; logos: unknown[] }>(
      'movie-images'
    );
    const images = mapImages(json, 'https://image.tmdb.org/t/p/original');
    expect(images).toContainEqual({ kind: 'poster', url: 'https://image.tmdb.org/t/p/original/poster1.jpg', width: 2000, height: 3000 });
    expect(images.some((i) => i.kind === 'backdrop')).toBe(true);
  });
});

describe('createTmdbProvider (fake fetch + dedicated live DB)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    const result = spawnSync(process.execPath, [join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), 'reset'], {
      cwd: DB_PKG_ROOT,
      env: { ...process.env, DATABASE_URL },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`db reset failed: ${result.stdout}\n${result.stderr}`);
    }
    db = createDb(DATABASE_URL);
  });

  afterAll(async () => {
    await db?.destroy();
  });

  function fakeFetch(routes: Record<string, unknown>) {
    return async (url: string | URL) => {
      const u = new URL(url.toString());
      const key = `${u.pathname}`;
      const body = routes[key];
      if (body === undefined) {
        return { ok: false, status: 404, statusText: 'not found', text: async () => 'not found' } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) } as Response;
    };
  }

  it('is disabled when LOOMBRE_TMDB_API_KEY is absent, and every method rejects', async () => {
    const provider = createTmdbProvider({ db, env: {} });
    expect(provider.enabled).toBe(false);
    expect(provider.disabledReason).toMatch(/LOOMBRE_TMDB_API_KEY/);
    await expect(provider.search({ mediaKind: 'movie', title: 'x' })).rejects.toThrow(/disabled/);
  });

  it('search -> fetchDetails -> fetchImages round-trips through the fake fetch + cache', async () => {
    const routes: Record<string, unknown> = {
      '/3/search/movie': fixture('search-movie'),
      '/3/movie/603': fixture('movie-details'),
      '/3/movie/603/images': fixture('movie-images'),
    };
    const fetchImpl = fakeFetch(routes) as never;
    const provider = createTmdbProvider({ db, env: { LOOMBRE_TMDB_API_KEY: 'test-key' }, fetchImpl });

    expect(provider.enabled).toBe(true);

    const results = await provider.search({ mediaKind: 'movie', title: 'The Matrix', year: 1999 });
    expect(results[0]?.ref.externalId).toBe('603');

    const details = await provider.fetchDetails(results[0]!.ref);
    expect(details.itemType).toBe('movie');
    expect(details.title).toBe('The Matrix');

    const images = await provider.fetchImages(results[0]!.ref);
    expect(images.length).toBeGreaterThan(0);
  });
});
