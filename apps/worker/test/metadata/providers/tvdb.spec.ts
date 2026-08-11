// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/providers/tvdb.spec.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, resolveTestDatabaseUrl } from '@loombre/db';
import {
  createTvdbProvider,
  mapEpisodeDetails,
  mapImages,
  mapSeasonDetails,
  mapSeriesDetails,
  type TvdbEpisodesResponse,
  type TvdbSeriesExtendedResponse,
} from '../../../src/metadata/providers/tvdb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'tvdb');
const DB_PKG_ROOT = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

describe('tvdb mappers (fixture-based, no network)', () => {
  it('mapSeriesDetails maps status/genres/characters', () => {
    const json = fixture<TvdbSeriesExtendedResponse>('series-extended');
    const details = mapSeriesDetails(json, '79488');

    expect(details.itemType).toBe('series');
    expect(details.title).toBe('Late Night Signal');
    expect(details.status).toBe('continuing');
    expect(details.year).toBe(2019);
    expect(details.genres).toEqual(['Drama', 'Mystery']);
    expect(details.people).toEqual([
      { name: 'Ada Lin', role: 'actor', order: 0, credit: 'Ada Lin' },
      { name: 'Sam Reyes', role: 'director', order: 1, credit: null },
    ]);
  });

  it('mapSeasonDetails synthesizes a minimal season (no dedicated TVDB endpoint)', () => {
    const season = mapSeasonDetails(1, '79488');
    expect(season).toEqual({
      itemType: 'season',
      title: 'Season 1',
      sortTitle: 'Season 1',
      year: null,
      overview: null,
      communityRating: null,
      contentRating: null,
      genres: [],
      tags: [],
      people: [],
      providerIds: { tvdb: '79488' },
      seasonNumber: 1,
    });
  });

  it('mapEpisodeDetails maps season/episode number, title, air date', () => {
    const json = fixture<TvdbEpisodesResponse>('episodes');
    const ep = json.data.episodes.find((e) => e.number === 3)!;
    const mapped = mapEpisodeDetails(ep, '79488');
    expect(mapped.itemType).toBe('episode');
    expect(mapped.seasonNumber).toBe(1);
    expect(mapped.episodeNumber).toBe(3);
    expect(mapped.title).toBe('Static');
    expect(mapped.airDateMs).toBe(Date.parse('2019-10-15'));
  });

  it('mapImages returns the series poster from `image` when present', () => {
    const json = fixture<TvdbSeriesExtendedResponse>('series-extended');
    // The fixture has no `image` field; add one to exercise the mapping.
    const withImage = { data: { ...json.data, image: 'https://example.invalid/poster.jpg' } };
    const images = mapImages(withImage);
    expect(images).toEqual([{ kind: 'poster', url: 'https://example.invalid/poster.jpg', width: null, height: null }]);
  });
});

describe('createTvdbProvider (fake fetch + dedicated live DB)', () => {
  const DATABASE_URL = resolveTestDatabaseUrl();
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
    return async (url: string | URL, init?: RequestInit) => {
      const u = new URL(url.toString());
      const key = init?.method === 'POST' ? `POST ${u.pathname}` : u.pathname;
      const body = routes[key];
      if (body === undefined) {
        return { ok: false, status: 404, statusText: 'not found', text: async () => 'not found' } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) } as Response;
    };
  }

  it('is disabled when LOOMBRE_TVDB_API_KEY is absent', async () => {
    const provider = createTvdbProvider({ db, env: {} });
    expect(provider.enabled).toBe(false);
    await expect(provider.search({ mediaKind: 'tv', title: 'x' })).rejects.toThrow(/disabled/);
  });

  it('logs in once, then search -> fetchDetails -> fetchImages reuse the cached token', async () => {
    const routes: Record<string, unknown> = {
      'POST /v4/login': fixture('login'),
      '/v4/search': fixture('search'),
      '/v4/series/79488/extended': fixture('series-extended'),
    };
    let loginCalls = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') loginCalls += 1;
      return fakeFetch(routes)(url, init);
    }) as never;

    const provider = createTvdbProvider({ db, env: { LOOMBRE_TVDB_API_KEY: 'test-key' }, fetchImpl });
    expect(provider.enabled).toBe(true);

    const results = await provider.search({ mediaKind: 'tv', title: 'Late Night Signal', year: 2019 });
    expect(results[0]?.ref.externalId).toBe('79488');

    const details = await provider.fetchDetails(results[0]!.ref);
    expect(details.itemType).toBe('series');

    await provider.fetchImages(results[0]!.ref);

    expect(loginCalls).toBe(1);
  });

  it('fetches episode details via the episodes endpoint', async () => {
    const routes: Record<string, unknown> = {
      'POST /v4/login': fixture('login'),
      '/v4/series/79488/episodes/default': fixture('episodes'),
    };
    const fetchImpl = fakeFetch(routes) as never;
    const provider = createTvdbProvider({ db, env: { LOOMBRE_TVDB_API_KEY: 'test-key-2' }, fetchImpl });

    const details = await provider.fetchDetails({
      provider: 'tvdb',
      externalId: '79488',
      mediaKind: 'tv',
      seasonNumber: 1,
      episodeNumber: 3,
    });
    expect(details.itemType).toBe('episode');
    if (details.itemType === 'episode') {
      expect(details.title).toBe('Static');
    }
  });
});
