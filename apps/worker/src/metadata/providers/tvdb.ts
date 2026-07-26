// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/providers/tvdb.ts
//
// TVDB provider (P1.6, docs/PLAN.md §4.4): TV fallback via
// api4.thetvdb.com/v4. Login exchanges the API key for a bearer JWT; the
// token is cached in-memory for the life of the process AND persisted
// through provider_cache (getProviderCacheEntry/upsertProviderCacheEntry
// directly, not cachedGet — a POST /login isn't a GET the cache wrapper
// models) so a fresh worker process picks up an unexpired token instead of
// re-logging-in on every restart.
//
// `map*` functions are pure and exported for fixture-based unit tests
// (test/metadata/providers/tvdb.spec.ts).

import type { DbOrTx } from '@loombre/db/internal';
import { getProviderCacheEntry, upsertProviderCacheEntry } from '@loombre/db/internal';
import { cachedGet, ProviderFetchError, type FetchLike } from '../cache.js';
import { resolveApiKey } from '../keys.js';
import { acquire, TokenBucket, PROVIDER_RATE_LIMITS, type Clock } from '../rate-limit.js';
import type {
  EpisodeProviderDetails,
  MetadataProvider,
  PersonCredit,
  ProviderDetails,
  ProviderImageRef,
  ProviderRef,
  ProviderSearchResult,
  SearchQuery,
  SeasonProviderDetails,
  SeriesProviderDetails,
} from '../provider.js';

const API_BASE = 'https://api4.thetvdb.com/v4';
/** TVDB JWTs are documented as valid ~1 month; cached conservatively at 20h
 *  so a stale-but-still-valid token is never trusted past a single work day. */
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000;

// ============================================================================
// raw TVDB v4 response shapes (only the fields this module reads)
// ============================================================================

export interface TvdbSearchResponse {
  data: { tvdb_id: string; name: string; year?: string | null; overview?: string | null; score?: number | null }[];
}

interface TvdbCharacter {
  name?: string | null;
  personName: string;
  peopleType: string;
  sort?: number | null;
}

interface TvdbArtwork {
  image: string;
  type: number;
  width?: number | null;
  height?: number | null;
}

export interface TvdbSeriesExtendedResponse {
  data: {
    id: number;
    name: string;
    overview?: string | null;
    score?: number | null;
    status?: { name?: string | null } | null;
    firstAired?: string | null;
    genres?: { name: string }[];
    characters?: TvdbCharacter[];
    image?: string | null;
    artworks?: TvdbArtwork[];
  };
}

export interface TvdbEpisode {
  seasonNumber: number;
  number: number;
  name: string;
  overview?: string | null;
  aired?: string | null;
}

export interface TvdbEpisodesResponse {
  data: { episodes: TvdbEpisode[] };
}

// ============================================================================
// mapping helpers
// ============================================================================

function yearFromIsoDate(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function isoDateToEpochMs(date: string | null | undefined): number | null {
  if (!date) return null;
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : null;
}

function mapCharacters(characters: TvdbCharacter[] | undefined): PersonCredit[] {
  const sorted = [...(characters ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const people: PersonCredit[] = [];
  for (const c of sorted) {
    if (c.peopleType === 'Actor') {
      people.push({ name: c.personName, role: 'actor', order: c.sort ?? people.length, credit: c.name ?? null });
    } else if (c.peopleType === 'Director') {
      people.push({ name: c.personName, role: 'director', order: c.sort ?? people.length, credit: null });
    } else if (c.peopleType === 'Writer') {
      people.push({ name: c.personName, role: 'writer', order: c.sort ?? people.length, credit: null });
    }
  }
  return people;
}

const TVDB_STATUS: Record<string, SeriesProviderDetails['status']> = {
  Continuing: 'continuing',
  Ended: 'ended',
  Upcoming: 'continuing',
};

export function mapSeriesDetails(json: TvdbSeriesExtendedResponse, externalId: string): SeriesProviderDetails {
  const d = json.data;
  return {
    itemType: 'series',
    title: d.name,
    sortTitle: d.name,
    year: yearFromIsoDate(d.firstAired),
    overview: d.overview ?? null,
    communityRating: d.score ?? null,
    contentRating: null,
    genres: (d.genres ?? []).map((g) => g.name),
    tags: [],
    people: mapCharacters(d.characters),
    providerIds: { tvdb: externalId },
    status: d.status?.name ? (TVDB_STATUS[d.status.name] ?? null) : null,
    airDateMs: isoDateToEpochMs(d.firstAired),
  };
}

/** No dedicated TVDB season-details endpoint is called: season_details has
 *  no columns beyond season_number, so this synthesizes a minimal
 *  SeasonProviderDetails from the already-fetched series-extended payload
 *  (documented simplification). */
export function mapSeasonDetails(seasonNumber: number, externalId: string): SeasonProviderDetails {
  return {
    itemType: 'season',
    title: `Season ${seasonNumber}`,
    sortTitle: `Season ${seasonNumber}`,
    year: null,
    overview: null,
    communityRating: null,
    contentRating: null,
    genres: [],
    tags: [],
    people: [],
    providerIds: { tvdb: externalId },
    seasonNumber,
  };
}

export function mapEpisodeDetails(ep: TvdbEpisode, externalId: string): EpisodeProviderDetails {
  return {
    itemType: 'episode',
    title: ep.name,
    sortTitle: ep.name,
    year: yearFromIsoDate(ep.aired),
    overview: ep.overview ?? null,
    communityRating: null,
    contentRating: null,
    genres: [],
    tags: [],
    people: [],
    providerIds: { tvdb: externalId },
    seasonNumber: ep.seasonNumber,
    episodeNumber: ep.number,
    airDateMs: isoDateToEpochMs(ep.aired),
  };
}

/** Approximate artwork-type mapping (TVDB does not publish a single
 *  authoritative type-id table across all entity kinds) — series poster
 *  (2), background/fanart (3), and icon/thumb (5) are the only ones this
 *  project has verified; anything else is skipped rather than guessed. */
const ARTWORK_TYPE_KIND: Record<number, ProviderImageRef['kind']> = { 2: 'poster', 3: 'backdrop', 5: 'thumb' };

export function mapImages(json: TvdbSeriesExtendedResponse): ProviderImageRef[] {
  const refs: ProviderImageRef[] = [];
  const d = json.data;
  if (d.image) {
    refs.push({ kind: 'poster', url: d.image, width: null, height: null });
  }
  for (const a of d.artworks ?? []) {
    const kind = ARTWORK_TYPE_KIND[a.type];
    if (!kind) continue;
    refs.push({ kind, url: a.image, width: a.width ?? null, height: a.height ?? null });
  }
  return refs;
}

// ============================================================================
// provider factory
// ============================================================================

export interface TvdbProviderDeps {
  db: DbOrTx;
  fetchImpl?: FetchLike;
  clock?: () => number;
  bucket?: TokenBucket;
  env?: NodeJS.ProcessEnv;
}

export function createTvdbProvider(deps: TvdbProviderDeps): MetadataProvider {
  const keyResolution = resolveApiKey('LOOMBRE_TVDB_API_KEY', deps.env);
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  const clock = deps.clock ?? (() => Date.now());
  const clockObj: Clock = { nowMs: clock };
  const bucket = deps.bucket ?? new TokenBucket({ ...PROVIDER_RATE_LIMITS.tvdb, clock: clockObj });

  let inMemoryToken: { token: string; expiresAtMs: number } | null = null;

  function requireEnabled(): string {
    if (!keyResolution.enabled) {
      throw new Error(`tvdb: provider is disabled (${keyResolution.reason})`);
    }
    return keyResolution.apiKey;
  }

  async function getToken(): Promise<string> {
    const apiKey = requireEnabled();
    const now = clock();

    if (inMemoryToken && inMemoryToken.expiresAtMs > now) {
      return inMemoryToken.token;
    }

    const cached = await getProviderCacheEntry(deps.db, 'tvdb', 'login-token', now);
    if (cached) {
      const parsed = JSON.parse(cached.body) as { token: string };
      inMemoryToken = { token: parsed.token, expiresAtMs: cached.expires_at_ms };
      return inMemoryToken.token;
    }

    await acquire(bucket);
    const res = await fetchImpl(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: apiKey }),
    });
    if (!res.ok) {
      throw new ProviderFetchError(`${API_BASE}/login`, res.status, res.statusText);
    }
    const json = JSON.parse(await res.text()) as { data: { token: string } };
    const token = json.data.token;
    const expiresAtMs = now + TOKEN_TTL_MS;

    await upsertProviderCacheEntry(deps.db, {
      provider: 'tvdb',
      requestHash: 'login-token',
      body: JSON.stringify({ token }),
      fetchedAtMs: now,
      expiresAtMs,
    });
    inMemoryToken = { token, expiresAtMs };
    return token;
  }

  async function get<T>(path: string, query: Record<string, string>, endpointClass: 'search' | 'details' | 'images'): Promise<T> {
    const token = await getToken();
    await acquire(bucket);
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const body = await cachedGet({ db: deps.db, provider: 'tvdb', fetchImpl, clock }, url.toString(), {
      endpointClass,
      headers: { Authorization: `Bearer ${token}` },
      // Authorization deliberately excluded from the cache key: a token
      // rotation must not bust an otherwise-identical cached response.
      cacheKeyHeaderNames: [],
    });
    return JSON.parse(body) as T;
  }

  return {
    name: 'tvdb',
    contentClass: 'general',
    kinds: ['tv'],
    enabled: keyResolution.enabled,
    ...(!keyResolution.enabled ? { disabledReason: keyResolution.reason } : {}),

    async search(query: SearchQuery): Promise<ProviderSearchResult[]> {
      if (query.mediaKind !== 'tv') return [];
      const json = await get<TvdbSearchResponse>('/search', { query: query.title, type: 'series' }, 'search');
      return json.data.map((r) => ({
        ref: { provider: 'tvdb', externalId: r.tvdb_id, mediaKind: 'tv' },
        title: r.name,
        year: r.year ? Number.parseInt(r.year, 10) : null,
        overview: r.overview ?? null,
        popularity: r.score ?? null,
      }));
    },

    async fetchDetails(ref: ProviderRef): Promise<ProviderDetails> {
      if (ref.mediaKind !== 'tv') {
        throw new Error(`tvdb: unsupported mediaKind "${ref.mediaKind}"`);
      }
      if (ref.seasonNumber != null && ref.episodeNumber != null) {
        const json = await get<TvdbEpisodesResponse>(`/series/${ref.externalId}/episodes/default`, { season: String(ref.seasonNumber) }, 'details');
        const episode = json.data.episodes.find((e) => e.seasonNumber === ref.seasonNumber && e.number === ref.episodeNumber);
        if (!episode) {
          throw new Error(`tvdb: series ${ref.externalId} has no S${ref.seasonNumber}E${ref.episodeNumber}`);
        }
        return mapEpisodeDetails(episode, ref.externalId);
      }
      if (ref.seasonNumber != null) {
        return mapSeasonDetails(ref.seasonNumber, ref.externalId);
      }
      const json = await get<TvdbSeriesExtendedResponse>(`/series/${ref.externalId}/extended`, {}, 'details');
      return mapSeriesDetails(json, ref.externalId);
    },

    async fetchImages(ref: ProviderRef): Promise<ProviderImageRef[]> {
      if (ref.mediaKind !== 'tv') return [];
      const json = await get<TvdbSeriesExtendedResponse>(`/series/${ref.externalId}/extended`, {}, 'images');
      return mapImages(json);
    },
  };
}
