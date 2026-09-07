// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/providers/tmdb.ts
//
// TMDB provider (P1.6, docs/PLAN.md §4.4): movies + TV via
// api.themoviedb.org/3. Uses `append_to_response=credits,images` on the
// single details GET so fetchDetails/fetchImages share one cached request
// per entity rather than three round trips.
//
// The `map*` functions are pure and exported separately so unit tests can
// exercise them directly against checked-in fixture JSON with no network
// and no provider construction (test/metadata/providers/tmdb.spec.ts).

import type { DbOrTx } from '@loombre/db/internal';
import { cachedGet, type FetchLike } from '../cache.js';
import { resolveApiKey, type KeyResolution } from '../keys.js';
import { acquire, TokenBucket, PROVIDER_RATE_LIMITS, type Clock } from '../rate-limit.js';
import type {
  EpisodeProviderDetails,
  MetadataProvider,
  MovieProviderDetails,
  PersonCredit,
  ProviderDetails,
  ProviderImageRef,
  ProviderRef,
  ProviderSearchResult,
  SearchQuery,
  SeasonProviderDetails,
  SeriesProviderDetails,
} from '../provider.js';

const API_BASE = 'https://api.themoviedb.org/3';
/** TMDB image URLs are `<secure_base_url><size><file_path>`: the base from
 *  /configuration ends at `/t/p/` and carries NO size segment, and
 *  file_path starts with a slash. The size this module asks for is always
 *  `original` (the image pipeline downscales at ingest — CLAUDE.md
 *  invariant 9), so the base is completed with it here, once. A base
 *  without the size ("…/t/p//poster.jpg") is a 404 for every image —
 *  which is exactly what every install had until this was pinned. */
const TMDB_IMAGE_HOST_BASE = 'https://image.tmdb.org/t/p/';
const TMDB_IMAGE_SIZE = 'original';

/** `<base>/original` with exactly one slash between them, whatever shape
 *  the base arrived in (TMDB's own `secure_base_url` ends with a slash;
 *  a base that already names a size is left alone). */
export function resolveImageBaseUrl(secureBaseUrl: string | undefined): string {
  const base = (secureBaseUrl && secureBaseUrl.trim().length > 0 ? secureBaseUrl.trim() : TMDB_IMAGE_HOST_BASE).replace(/\/+$/, '');
  if (/\/(original|w\d+|h\d+)$/.test(base)) return base;
  return `${base}/${TMDB_IMAGE_SIZE}`;
}

// ============================================================================
// raw TMDB response shapes (only the fields this module reads)
// ============================================================================

interface TmdbGenre {
  name: string;
}

interface TmdbCastMember {
  name: string;
  character?: string | null;
  order?: number | null;
  profile_path?: string | null;
}

interface TmdbCrewMember {
  name: string;
  job: string;
  profile_path?: string | null;
}

interface TmdbCredits {
  cast?: TmdbCastMember[];
  crew?: TmdbCrewMember[];
}

interface TmdbImageFile {
  file_path: string;
  width?: number | null;
  height?: number | null;
  /** ISO 639-1 of the text on the image; null for textless artwork. */
  iso_639_1?: string | null;
  vote_average?: number | null;
  vote_count?: number | null;
}

interface TmdbImages {
  posters?: TmdbImageFile[];
  backdrops?: TmdbImageFile[];
  logos?: TmdbImageFile[];
}

export interface TmdbSearchMovieResponse {
  results: {
    id: number;
    title: string;
    release_date?: string | null;
    overview?: string | null;
    vote_average?: number | null;
    popularity?: number | null;
  }[];
}

export interface TmdbSearchTvResponse {
  results: {
    id: number;
    name: string;
    first_air_date?: string | null;
    overview?: string | null;
    vote_average?: number | null;
    popularity?: number | null;
  }[];
}

export interface TmdbMovieDetailsResponse {
  title: string;
  release_date?: string | null;
  overview?: string | null;
  tagline?: string | null;
  runtime?: number | null;
  vote_average?: number | null;
  genres?: TmdbGenre[];
  credits?: TmdbCredits;
}

export interface TmdbTvDetailsResponse {
  name: string;
  first_air_date?: string | null;
  overview?: string | null;
  vote_average?: number | null;
  status?: string | null;
  genres?: TmdbGenre[];
  credits?: TmdbCredits;
}

export interface TmdbSeasonResponse {
  season_number: number;
  name?: string | null;
  overview?: string | null;
  episodes?: TmdbEpisode[];
}

export interface TmdbEpisode {
  episode_number: number;
  name: string;
  overview?: string | null;
  air_date?: string | null;
  vote_average?: number | null;
  crew?: TmdbCrewMember[];
  guest_stars?: TmdbCastMember[];
}

export interface TmdbConfigurationResponse {
  images: { secure_base_url: string };
}

// ============================================================================
// shared mapping helpers
// ============================================================================

function isoDateToEpochMs(date: string | null | undefined): number | null {
  if (!date) return null;
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : null;
}

function yearFromIsoDate(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/** TMDB's `profile_path` is a bare `/xyz.jpg`; the portrait URL is the
 *  configuration's secure base + size + path, exactly like poster/backdrop
 *  file_paths (mapImages). Without a base (pure mapper tests) the credit
 *  carries no imageUrl at all rather than a half-built one. */
function personImage(profilePath: string | null | undefined, imageBaseUrl: string | undefined): { imageUrl: string } | Record<string, never> {
  if (!profilePath || !imageBaseUrl) return {};
  return { imageUrl: `${imageBaseUrl}${profilePath}` };
}

function mapCredits(credits: TmdbCredits | undefined, imageBaseUrl?: string): PersonCredit[] {
  const people: PersonCredit[] = [];
  let order = 0;
  for (const c of credits?.cast ?? []) {
    people.push({ name: c.name, role: 'actor', order: c.order ?? order, credit: c.character ?? null, ...personImage(c.profile_path, imageBaseUrl) });
    order += 1;
  }
  for (const c of credits?.crew ?? []) {
    if (c.job === 'Director') {
      people.push({ name: c.name, role: 'director', order, credit: null, ...personImage(c.profile_path, imageBaseUrl) });
      order += 1;
    } else if (c.job === 'Writer' || c.job === 'Screenplay') {
      people.push({ name: c.name, role: 'writer', order, credit: null, ...personImage(c.profile_path, imageBaseUrl) });
      order += 1;
    }
  }
  return people;
}

/** TMDB has no first-class "tags" concept distinct from genres — tags stay
 *  empty (documented deviation; the keywords endpoint is out of scope). */
export function mapMovieDetails(json: TmdbMovieDetailsResponse, externalId: string, imageBaseUrl?: string): MovieProviderDetails {
  return {
    itemType: 'movie',
    title: json.title,
    sortTitle: json.title,
    year: yearFromIsoDate(json.release_date),
    overview: json.overview ?? null,
    communityRating: json.vote_average ?? null,
    contentRating: null,
    genres: (json.genres ?? []).map((g) => g.name),
    tags: [],
    people: mapCredits(json.credits, imageBaseUrl),
    providerIds: { tmdb: externalId },
    tagline: json.tagline ?? null,
    runtimeMs: json.runtime ? json.runtime * 60_000 : null,
  };
}

const TMDB_TV_STATUS: Record<string, SeriesProviderDetails['status']> = {
  'Returning Series': 'continuing',
  'Ended': 'ended',
  'Canceled': 'cancelled',
};

export function mapSeriesDetails(json: TmdbTvDetailsResponse, externalId: string, imageBaseUrl?: string): SeriesProviderDetails {
  return {
    itemType: 'series',
    title: json.name,
    sortTitle: json.name,
    year: yearFromIsoDate(json.first_air_date),
    overview: json.overview ?? null,
    communityRating: json.vote_average ?? null,
    contentRating: null,
    genres: (json.genres ?? []).map((g) => g.name),
    tags: [],
    people: mapCredits(json.credits, imageBaseUrl),
    providerIds: { tmdb: externalId },
    status: json.status ? (TMDB_TV_STATUS[json.status] ?? null) : null,
    airDateMs: isoDateToEpochMs(json.first_air_date),
  };
}

export function mapSeasonDetails(json: TmdbSeasonResponse, externalId: string): SeasonProviderDetails {
  return {
    itemType: 'season',
    title: json.name ?? `Season ${json.season_number}`,
    sortTitle: json.name ?? `Season ${json.season_number}`,
    year: null,
    overview: json.overview ?? null,
    communityRating: null,
    contentRating: null,
    genres: [],
    tags: [],
    people: [],
    providerIds: { tmdb: externalId },
    seasonNumber: json.season_number,
  };
}

export function mapEpisodeDetails(ep: TmdbEpisode, seasonNumber: number, externalId: string, imageBaseUrl?: string): EpisodeProviderDetails {
  const people: PersonCredit[] = [];
  let order = 0;
  for (const c of ep.crew ?? []) {
    if (c.job === 'Director') {
      people.push({ name: c.name, role: 'director', order, credit: null, ...personImage(c.profile_path, imageBaseUrl) });
      order += 1;
    }
  }
  for (const c of ep.guest_stars ?? []) {
    people.push({ name: c.name, role: 'guest', order, credit: c.character ?? null, ...personImage(c.profile_path, imageBaseUrl) });
    order += 1;
  }

  return {
    itemType: 'episode',
    title: ep.name,
    sortTitle: ep.name,
    year: yearFromIsoDate(ep.air_date),
    overview: ep.overview ?? null,
    communityRating: ep.vote_average ?? null,
    contentRating: null,
    genres: [],
    tags: [],
    people,
    providerIds: { tmdb: externalId },
    seasonNumber,
    episodeNumber: ep.episode_number,
    airDateMs: isoDateToEpochMs(ep.air_date),
  };
}

export function mapImages(images: TmdbImages | undefined, imageBaseUrl: string): ProviderImageRef[] {
  const refs: ProviderImageRef[] = [];
  const ref = (kind: ProviderImageRef['kind'], file: TmdbImageFile): ProviderImageRef => ({
    kind,
    url: `${imageBaseUrl}${file.file_path}`,
    width: file.width ?? null,
    height: file.height ?? null,
    language: file.iso_639_1 ?? null,
    voteAverage: file.vote_average ?? null,
    voteCount: file.vote_count ?? null,
  });
  for (const p of images?.posters ?? []) refs.push(ref('poster', p));
  for (const b of images?.backdrops ?? []) refs.push(ref('backdrop', b));
  for (const l of images?.logos ?? []) refs.push(ref('logo', l));
  return refs;
}

// ============================================================================
// provider factory
// ============================================================================

export interface TmdbProviderDeps {
  db: DbOrTx;
  fetchImpl?: FetchLike;
  clock?: () => number;
  bucket?: TokenBucket;
  env?: NodeJS.ProcessEnv;
  /** Job-boundary key re-resolution (keys.ts createKeyringKeyResolver) —
   *  when present, `refresh()` replaces the construction-time env read
   *  with its result, so a key saved in the admin screen takes effect
   *  without a restart. */
  resolveKey?: () => Promise<KeyResolution>;
}

function buildUrl(path: string, query: Record<string, string>): string {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function createTmdbProvider(deps: TmdbProviderDeps): MetadataProvider {
  let keyResolution: KeyResolution = resolveApiKey('LOOMBRE_TMDB_API_KEY', deps.env);
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  const clock = deps.clock ?? (() => Date.now());
  const clockObj: Clock = { nowMs: clock };
  const bucket = deps.bucket ?? new TokenBucket({ ...PROVIDER_RATE_LIMITS.tmdb, clock: clockObj });

  function requireEnabled(): string {
    if (!keyResolution.enabled) {
      throw new Error(`tmdb: provider is disabled (${keyResolution.reason})`);
    }
    return keyResolution.apiKey;
  }

  async function get<T>(path: string, query: Record<string, string>, endpointClass: 'search' | 'details' | 'images'): Promise<T> {
    const apiKey = requireEnabled();
    await acquire(bucket);
    const url = buildUrl(path, { ...query, api_key: apiKey });
    const body = await cachedGet({ db: deps.db, provider: 'tmdb', fetchImpl, clock }, url, { endpointClass });
    return JSON.parse(body) as T;
  }

  async function imageBaseUrl(): Promise<string> {
    try {
      const config = await get<TmdbConfigurationResponse>('/configuration', {}, 'details');
      return resolveImageBaseUrl(config.images?.secure_base_url);
    } catch {
      return resolveImageBaseUrl(undefined);
    }
  }

  return {
    name: 'tmdb',
    contentClass: 'general',
    kinds: ['movie', 'tv'],
    get enabled(): boolean {
      return keyResolution.enabled;
    },
    get disabledReason(): string | undefined {
      return keyResolution.enabled ? undefined : keyResolution.reason;
    },
    async refresh(): Promise<void> {
      if (deps.resolveKey) keyResolution = await deps.resolveKey();
    },

    async search(query: SearchQuery): Promise<ProviderSearchResult[]> {
      if (query.mediaKind === 'movie') {
        const json = await get<TmdbSearchMovieResponse>(
          '/search/movie',
          { query: query.title, ...(query.year != null ? { year: String(query.year) } : {}) },
          'search'
        );
        return json.results.map((r) => ({
          ref: { provider: 'tmdb', externalId: String(r.id), mediaKind: 'movie' },
          title: r.title,
          year: yearFromIsoDate(r.release_date),
          overview: r.overview ?? null,
          popularity: r.popularity ?? null,
        }));
      }
      if (query.mediaKind === 'tv') {
        const json = await get<TmdbSearchTvResponse>(
          '/search/tv',
          { query: query.title, ...(query.year != null ? { first_air_date_year: String(query.year) } : {}) },
          'search'
        );
        return json.results.map((r) => ({
          ref: { provider: 'tmdb', externalId: String(r.id), mediaKind: 'tv' },
          title: r.name,
          year: yearFromIsoDate(r.first_air_date),
          overview: r.overview ?? null,
          popularity: r.popularity ?? null,
        }));
      }
      return [];
    },

    async fetchDetails(ref: ProviderRef): Promise<ProviderDetails> {
      // Portraits need the same configuration base as poster/backdrop
      // paths; cached under the 'details' endpoint class like the rest.
      const base = await imageBaseUrl();
      if (ref.mediaKind === 'movie') {
        const json = await get<TmdbMovieDetailsResponse>(`/movie/${ref.externalId}`, { append_to_response: 'credits' }, 'details');
        return mapMovieDetails(json, ref.externalId, base);
      }
      if (ref.mediaKind === 'tv') {
        if (ref.seasonNumber != null && ref.episodeNumber != null) {
          const season = await get<TmdbSeasonResponse>(`/tv/${ref.externalId}/season/${ref.seasonNumber}`, {}, 'details');
          const episode = season.episodes?.find((e) => e.episode_number === ref.episodeNumber);
          if (!episode) {
            throw new Error(`tmdb: series ${ref.externalId} has no S${ref.seasonNumber}E${ref.episodeNumber}`);
          }
          return mapEpisodeDetails(episode, ref.seasonNumber, ref.externalId, base);
        }
        if (ref.seasonNumber != null) {
          const season = await get<TmdbSeasonResponse>(`/tv/${ref.externalId}/season/${ref.seasonNumber}`, {}, 'details');
          return mapSeasonDetails(season, ref.externalId);
        }
        const json = await get<TmdbTvDetailsResponse>(`/tv/${ref.externalId}`, { append_to_response: 'credits' }, 'details');
        return mapSeriesDetails(json, ref.externalId, base);
      }
      throw new Error(`tmdb: unsupported mediaKind "${ref.mediaKind}"`);
    },

    async fetchImages(ref: ProviderRef): Promise<ProviderImageRef[]> {
      const base = await imageBaseUrl();
      const path = ref.mediaKind === 'movie' ? `/movie/${ref.externalId}/images` : `/tv/${ref.externalId}/images`;
      const json = await get<TmdbImages>(path, {}, 'images');
      return mapImages(json, base);
    },
  };
}
