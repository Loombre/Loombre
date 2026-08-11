// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/providers/musicbrainz.spec.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, resolveTestDatabaseUrl } from '@loombre/db';
import {
  createMusicBrainzProvider,
  mapAlbumDetails,
  mapArtistDetails,
  mapCoverArtImages,
  mapTrackDetails,
  type CoverArtArchiveResponse,
  type MbArtistLookupResponse,
  type MbRecordingLookupResponse,
  type MbReleaseGroupLookupResponse,
} from '../../../src/metadata/providers/musicbrainz.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'musicbrainz');
const DB_PKG_ROOT = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

describe('musicbrainz mappers (fixture-based, no network)', () => {
  it('mapArtistDetails', () => {
    const details = mapArtistDetails(fixture<MbArtistLookupResponse>('artist-lookup'));
    expect(details.itemType).toBe('artist');
    expect(details.title).toBe('Nirvana');
    expect(details.year).toBe(1987);
    expect(details.genres).toEqual(['grunge', 'alternative rock']);
    expect(details.providerIds).toEqual({ musicbrainz: '5b11f4ce-a62d-471e-81fc-a69a8278c7da' });
  });

  it('mapAlbumDetails', () => {
    const details = mapAlbumDetails(fixture<MbReleaseGroupLookupResponse>('release-group-lookup'));
    expect(details.itemType).toBe('album');
    expect(details.title).toBe('Nevermind');
    expect(details.year).toBe(1991);
    expect(details.people).toEqual([{ name: 'Nirvana', role: 'album_artist', order: 0, credit: null }]);
  });

  it('mapTrackDetails extracts track/disc number and duration', () => {
    const details = mapTrackDetails(fixture<MbRecordingLookupResponse>('recording-lookup'));
    expect(details.itemType).toBe('track');
    expect(details.title).toBe('Smells Like Teen Spirit');
    expect(details.durationMs).toBe(301000);
    expect(details.trackNumber).toBe(1);
    expect(details.discNumber).toBe(1);
  });

  it('mapCoverArtImages keeps only front images, tagged as poster', () => {
    const images = mapCoverArtImages(fixture<CoverArtArchiveResponse>('coverartarchive-release-group'));
    expect(images).toEqual([
      { kind: 'poster', url: 'https://coverartarchive.org/release/rel-1/123456.jpg', width: null, height: null },
    ]);
  });
});

describe('createMusicBrainzProvider (fake fetch + dedicated live DB)', () => {
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
      const headers = init?.headers as Record<string, string> | undefined;
      // Proves the User-Agent requirement is actually honored, not just documented.
      if (u.hostname === 'musicbrainz.org' && headers?.['User-Agent'] !== 'Loombre/0.1 (self-hosted media server)') {
        throw new Error('musicbrainz request sent without the required User-Agent header');
      }
      const body = routes[u.pathname];
      if (body === undefined) {
        return { ok: false, status: 404, statusText: 'not found', text: async () => 'not found' } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) } as Response;
    };
  }

  it('is always enabled (no API key required)', () => {
    const provider = createMusicBrainzProvider({ db });
    expect(provider.enabled).toBe(true);
  });

  it('search defaults to album (release-group) when entityKind is omitted', async () => {
    const routes: Record<string, unknown> = { '/ws/2/release-group/': fixture('release-group-search') };
    const provider = createMusicBrainzProvider({ db, fetchImpl: fakeFetch(routes) as never });

    const results = await provider.search({ mediaKind: 'music', title: 'Nevermind' });
    expect(results[0]?.ref.entityKind).toBe('album');
    expect(results[0]?.ref.externalId).toBe('5968a262-a839-3153-b71a-b829f0b0d7dd');
  });

  it('search(entityKind: artist) hits the artist endpoint', async () => {
    const routes: Record<string, unknown> = { '/ws/2/artist/': fixture('artist-search') };
    const provider = createMusicBrainzProvider({ db, fetchImpl: fakeFetch(routes) as never });

    const results = await provider.search({ mediaKind: 'music', title: 'Nirvana', entityKind: 'artist' });
    expect(results[0]?.ref.entityKind).toBe('artist');
    expect(results[0]?.title).toBe('Nirvana');
  });

  it('search(entityKind: track) hits the recording endpoint', async () => {
    const routes: Record<string, unknown> = { '/ws/2/recording/': fixture('recording-search') };
    const provider = createMusicBrainzProvider({ db, fetchImpl: fakeFetch(routes) as never });

    const results = await provider.search({ mediaKind: 'music', title: 'Smells Like Teen Spirit', entityKind: 'track' });
    expect(results[0]?.ref.entityKind).toBe('track');
  });

  it('fetchDetails(album) -> fetchImages(album) round-trips through release-group + coverartarchive', async () => {
    const routes: Record<string, unknown> = {
      '/ws/2/release-group/5968a262-a839-3153-b71a-b829f0b0d7dd': fixture('release-group-lookup'),
      '/release-group/5968a262-a839-3153-b71a-b829f0b0d7dd': fixture('coverartarchive-release-group'),
    };
    const provider = createMusicBrainzProvider({ db, fetchImpl: fakeFetch(routes) as never });

    const ref = { provider: 'musicbrainz', externalId: '5968a262-a839-3153-b71a-b829f0b0d7dd', mediaKind: 'music' as const, entityKind: 'album' as const };
    const details = await provider.fetchDetails(ref);
    expect(details.itemType).toBe('album');

    const images = await provider.fetchImages(ref);
    expect(images).toHaveLength(1);
    expect(images[0]?.kind).toBe('poster');
  });

  it('fetchImages returns [] for artist/track refs (CoverArtArchive is release-group-only)', async () => {
    const provider = createMusicBrainzProvider({ db, fetchImpl: fakeFetch({}) as never });
    const images = await provider.fetchImages({
      provider: 'musicbrainz',
      externalId: 'x',
      mediaKind: 'music',
      entityKind: 'artist',
    });
    expect(images).toEqual([]);
  });
});
