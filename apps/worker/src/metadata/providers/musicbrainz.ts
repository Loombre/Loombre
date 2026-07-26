// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/providers/musicbrainz.ts
//
// MusicBrainz provider (P1.6, docs/PLAN.md §4.4): music via
// musicbrainz.org/ws/2, with CoverArtArchive (coverartarchive.org) for
// album art refs. No API key is required, but MusicBrainz's usage policy
// REQUIRES a descriptive User-Agent header on every request — sent here
// unconditionally, never configurable, since an absent/generic UA is the
// #1 way self-hosted tools get rate-limited or blocked by MB.
//
// MusicBrainz has three distinct entity types with no shared id space —
// artist / release-group (album) / recording (track) — so SearchQuery and
// ProviderRef both carry `entityKind` for this provider (provider.ts).
// `entityKind` defaults to 'album' when omitted: it is the most common
// scan-time lookup (an album folder is the typical catalog unit).

import type { DbOrTx } from '@loombre/db/internal';
import { cachedGet, type FetchLike } from '../cache.js';
import { acquire, TokenBucket, PROVIDER_RATE_LIMITS, type Clock } from '../rate-limit.js';
import type {
  AlbumProviderDetails,
  ArtistProviderDetails,
  MetadataProvider,
  PersonCredit,
  ProviderDetails,
  ProviderImageRef,
  ProviderRef,
  ProviderSearchResult,
  SearchQuery,
  TrackProviderDetails,
} from '../provider.js';

const MB_BASE = 'https://musicbrainz.org/ws/2';
const CAA_BASE = 'https://coverartarchive.org';
const USER_AGENT = 'Loombre/0.1 (self-hosted media server)';

// ============================================================================
// raw MusicBrainz response shapes (only the fields this module reads)
// ============================================================================

interface MbArtistCreditEntry {
  name: string;
  artist?: { id: string };
}

interface MbGenre {
  name: string;
}

export interface MbArtistSearchResponse {
  artists: { id: string; name: string; score?: number | null; disambiguation?: string | null; 'life-span'?: { begin?: string | null } }[];
}

export interface MbArtistLookupResponse {
  id: string;
  name: string;
  disambiguation?: string | null;
  'life-span'?: { begin?: string | null } | null;
  genres?: MbGenre[];
}

export interface MbReleaseGroupSearchResponse {
  'release-groups': {
    id: string;
    title: string;
    'first-release-date'?: string | null;
    score?: number | null;
    'artist-credit'?: MbArtistCreditEntry[];
  }[];
}

export interface MbReleaseGroupLookupResponse {
  id: string;
  title: string;
  'first-release-date'?: string | null;
  genres?: MbGenre[];
  'artist-credit'?: MbArtistCreditEntry[];
}

export interface MbRecordingSearchResponse {
  recordings: {
    id: string;
    title: string;
    length?: number | null;
    score?: number | null;
    'first-release-date'?: string | null;
    'artist-credit'?: MbArtistCreditEntry[];
  }[];
}

export interface MbRecordingLookupResponse {
  id: string;
  title: string;
  length?: number | null;
  'first-release-date'?: string | null;
  'artist-credit'?: MbArtistCreditEntry[];
  releases?: { media?: { position?: number; tracks?: { position?: number }[] }[] }[];
}

export interface CoverArtArchiveResponse {
  images: { types: string[]; front?: boolean; image: string }[];
}

// ============================================================================
// mapping helpers
// ============================================================================

function yearFromDate(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function mapArtistCredit(credits: MbArtistCreditEntry[] | undefined, role: PersonCredit['role']): PersonCredit[] {
  return (credits ?? []).map((c, i) => ({ name: c.name, role, order: i, credit: null }));
}

export function mapArtistDetails(json: MbArtistLookupResponse): ArtistProviderDetails {
  return {
    itemType: 'artist',
    title: json.name,
    sortTitle: json.name,
    year: yearFromDate(json['life-span']?.begin),
    overview: json.disambiguation ?? null,
    communityRating: null,
    contentRating: null,
    genres: (json.genres ?? []).map((g) => g.name),
    tags: [],
    people: [],
    providerIds: { musicbrainz: json.id },
  };
}

export function mapAlbumDetails(json: MbReleaseGroupLookupResponse): AlbumProviderDetails {
  return {
    itemType: 'album',
    title: json.title,
    sortTitle: json.title,
    year: yearFromDate(json['first-release-date']),
    overview: null,
    communityRating: null,
    contentRating: null,
    genres: (json.genres ?? []).map((g) => g.name),
    tags: [],
    people: mapArtistCredit(json['artist-credit'], 'album_artist'),
    providerIds: { musicbrainz: json.id },
  };
}

export function mapTrackDetails(json: MbRecordingLookupResponse): TrackProviderDetails {
  const media = json.releases?.[0]?.media?.[0];
  return {
    itemType: 'track',
    title: json.title,
    sortTitle: json.title,
    year: yearFromDate(json['first-release-date']),
    overview: null,
    communityRating: null,
    contentRating: null,
    genres: [],
    tags: [],
    people: mapArtistCredit(json['artist-credit'], 'artist'),
    providerIds: { musicbrainz: json.id },
    trackNumber: media?.tracks?.[0]?.position ?? null,
    discNumber: media?.position ?? null,
    durationMs: json.length ?? null,
  };
}

export function mapCoverArtImages(json: CoverArtArchiveResponse): ProviderImageRef[] {
  return json.images
    .filter((img) => img.front === true || img.types.includes('Front'))
    .map((img) => ({ kind: 'poster' as const, url: img.image, width: null, height: null }));
}

// ============================================================================
// provider factory
// ============================================================================

export interface MusicBrainzProviderDeps {
  db: DbOrTx;
  fetchImpl?: FetchLike;
  clock?: () => number;
  bucket?: TokenBucket;
}

export function createMusicBrainzProvider(deps: MusicBrainzProviderDeps): MetadataProvider {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  const clock = deps.clock ?? (() => Date.now());
  const clockObj: Clock = { nowMs: clock };
  const bucket = deps.bucket ?? new TokenBucket({ ...PROVIDER_RATE_LIMITS.musicbrainz, clock: clockObj });

  async function getMb<T>(path: string, query: Record<string, string>, endpointClass: 'search' | 'details'): Promise<T> {
    await acquire(bucket);
    const url = new URL(`${MB_BASE}${path}`);
    url.searchParams.set('fmt', 'json');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const body = await cachedGet({ db: deps.db, provider: 'musicbrainz', fetchImpl, clock }, url.toString(), {
      endpointClass,
      headers: { 'User-Agent': USER_AGENT },
      cacheKeyHeaderNames: [],
    });
    return JSON.parse(body) as T;
  }

  /** CoverArtArchive is a separate host from musicbrainz.org — not subject
   *  to MB's 1 req/s rule, so it deliberately bypasses `bucket`. */
  async function getCoverArt(mbid: string): Promise<CoverArtArchiveResponse | null> {
    try {
      const body = await cachedGet(
        { db: deps.db, provider: 'coverartarchive', fetchImpl, clock },
        `${CAA_BASE}/release-group/${mbid}`,
        { endpointClass: 'images', headers: { 'User-Agent': USER_AGENT } }
      );
      return JSON.parse(body) as CoverArtArchiveResponse;
    } catch {
      // No cover art is a normal, non-fatal outcome (CAA 404s constantly).
      return null;
    }
  }

  return {
    name: 'musicbrainz',
    contentClass: 'general',
    kinds: ['music'],
    enabled: true,

    async search(query: SearchQuery): Promise<ProviderSearchResult[]> {
      if (query.mediaKind !== 'music') return [];
      const entityKind = query.entityKind ?? 'album';

      if (entityKind === 'artist') {
        const json = await getMb<MbArtistSearchResponse>('/artist/', { query: query.title }, 'search');
        return json.artists.map((a) => ({
          ref: { provider: 'musicbrainz', externalId: a.id, mediaKind: 'music', entityKind: 'artist' },
          title: a.name,
          year: yearFromDate(a['life-span']?.begin),
          overview: a.disambiguation ?? null,
          popularity: a.score ?? null,
        }));
      }
      if (entityKind === 'track') {
        const json = await getMb<MbRecordingSearchResponse>('/recording/', { query: query.title }, 'search');
        return json.recordings.map((r) => ({
          ref: { provider: 'musicbrainz', externalId: r.id, mediaKind: 'music', entityKind: 'track' },
          title: r.title,
          year: yearFromDate(r['first-release-date']),
          overview: null,
          popularity: r.score ?? null,
        }));
      }
      const json = await getMb<MbReleaseGroupSearchResponse>('/release-group/', { query: query.title }, 'search');
      return json['release-groups'].map((rg) => ({
        ref: { provider: 'musicbrainz', externalId: rg.id, mediaKind: 'music', entityKind: 'album' },
        title: rg.title,
        year: yearFromDate(rg['first-release-date']),
        overview: null,
        popularity: rg.score ?? null,
      }));
    },

    async fetchDetails(ref: ProviderRef): Promise<ProviderDetails> {
      const entityKind = ref.entityKind ?? 'album';
      if (entityKind === 'artist') {
        const json = await getMb<MbArtistLookupResponse>(`/artist/${ref.externalId}`, { inc: 'genres' }, 'details');
        return mapArtistDetails(json);
      }
      if (entityKind === 'track') {
        const json = await getMb<MbRecordingLookupResponse>(`/recording/${ref.externalId}`, { inc: 'artist-credits+releases' }, 'details');
        return mapTrackDetails(json);
      }
      const json = await getMb<MbReleaseGroupLookupResponse>(`/release-group/${ref.externalId}`, { inc: 'artist-credits+genres' }, 'details');
      return mapAlbumDetails(json);
    },

    async fetchImages(ref: ProviderRef): Promise<ProviderImageRef[]> {
      // Cover art only exists at the release-group (album) level.
      if ((ref.entityKind ?? 'album') !== 'album') return [];
      const caa = await getCoverArt(ref.externalId);
      if (!caa) return [];
      return mapCoverArtImages(caa);
    },
  };
}
