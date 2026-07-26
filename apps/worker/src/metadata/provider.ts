// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/provider.ts
//
// The metadata-provider interface (P1.6, docs/PLAN.md §4.4). This is the
// extension-point boundary: TMDB/TVDB/MusicBrainz are the built-in
// implementations today; a future out-of-process adapter (e.g. a
// StashDB-compatible provider scoped to restricted libraries) implements
// the same shape. Closed, documented types — new fields are additive edits
// to this file, mirroring the contract/event-schema evolution discipline.

/** Mirrors @loombre/shared's MediaKind verbatim (docs/PLAN.md §5-6). */
export type MediaKind = 'movie' | 'tv' | 'music';

/** Mirrors @loombre/shared's ContentClass verbatim (docs/PLAN.md §6.4). */
export type ContentClass = 'general' | 'restricted';

export type PersonRole =
  | 'actor'
  | 'director'
  | 'writer'
  | 'artist'
  | 'album_artist'
  | 'performer'
  | 'guest';

export type SeriesStatus = 'continuing' | 'ended' | 'cancelled';

export type ImageKind = 'poster' | 'backdrop' | 'logo' | 'disc' | 'thumb';

// ============================================================================
// search
// ============================================================================

export interface SearchQuery {
  mediaKind: MediaKind;
  title: string;
  year?: number | null;
  /** Music only — mirrors ProviderRef.entityKind: MusicBrainz has distinct
   *  search endpoints per entity (artist/release-group/recording) with no
   *  shared id space, so the caller must say which one it wants searched.
   *  Movie/TV providers ignore this field. */
  entityKind?: 'artist' | 'album' | 'track';
}

export interface ProviderRef {
  provider: string;
  /** The provider's own id for the matched entity (e.g. TMDB numeric id as
   *  a string, an MBID, a TVDB series id). */
  externalId: string;
  mediaKind: MediaKind;
  /** Present only when this ref addresses a season/episode beneath a
   *  series ref (TV fetchDetails/fetchImages for season|episode granularity). */
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  /** Music only: which of MusicBrainz's distinct entity types + endpoints
   *  `externalId` (an MBID) addresses — artist/album(release-group)/track
   *  (recording) share no common id space, so the ref must say which one
   *  this is. Movie/TV providers infer itemType from season/episode number
   *  presence instead and leave this undefined. */
  entityKind?: 'artist' | 'album' | 'track';
}

export interface ProviderSearchResult {
  ref: ProviderRef;
  title: string;
  year?: number | null;
  overview?: string | null;
  /** Optional provider-reported popularity/relevance signal, used only as a
   *  tie-breaker by the match picker (metadata/match.ts) — never load-bearing
   *  on its own. */
  popularity?: number | null;
}

// ============================================================================
// details — one closed variant per item_type that carries provider metadata
// ============================================================================

export interface PersonCredit {
  name: string;
  role: PersonRole;
  /** Display order within the role (docs/PLAN.md §5 item_people.ord). */
  order: number;
  /** e.g. the character name for an 'actor' credit. */
  credit?: string | null;
}

/** provider name -> that provider's external id, for provider_ids rows. */
export type ProviderIdMap = Record<string, string>;

interface ProviderDetailsCommon {
  title: string;
  sortTitle: string;
  year: number | null;
  overview: string | null;
  communityRating: number | null;
  contentRating: string | null;
  genres: string[];
  tags: string[];
  people: PersonCredit[];
  providerIds: ProviderIdMap;
}

export interface MovieProviderDetails extends ProviderDetailsCommon {
  itemType: 'movie';
  tagline: string | null;
  runtimeMs: number | null;
}

export interface SeriesProviderDetails extends ProviderDetailsCommon {
  itemType: 'series';
  status: SeriesStatus | null;
  /** First-air date, epoch ms (docs/PLAN.md §6.2: milliseconds everywhere). */
  airDateMs: number | null;
}

export interface SeasonProviderDetails extends ProviderDetailsCommon {
  itemType: 'season';
  seasonNumber: number;
}

export interface EpisodeProviderDetails extends ProviderDetailsCommon {
  itemType: 'episode';
  seasonNumber: number;
  episodeNumber: number;
  airDateMs: number | null;
}

export interface ArtistProviderDetails extends ProviderDetailsCommon {
  itemType: 'artist';
}

export interface AlbumProviderDetails extends ProviderDetailsCommon {
  itemType: 'album';
}

export interface TrackProviderDetails extends ProviderDetailsCommon {
  itemType: 'track';
  trackNumber: number | null;
  discNumber: number | null;
  durationMs: number | null;
}

export type ProviderDetails =
  | MovieProviderDetails
  | SeriesProviderDetails
  | SeasonProviderDetails
  | EpisodeProviderDetails
  | ArtistProviderDetails
  | AlbumProviderDetails
  | TrackProviderDetails;

// ============================================================================
// images
// ============================================================================

export interface ProviderImageRef {
  kind: ImageKind;
  /** Absolute, fetchable URL. The image pipeline downloads it directly —
   *  providers never hand back bytes here (docs/PLAN.md §8.3). */
  url: string;
  width?: number | null;
  height?: number | null;
}

// ============================================================================
// the provider interface
// ============================================================================

export interface MetadataProvider {
  readonly name: string;
  readonly contentClass: ContentClass;
  readonly kinds: readonly MediaKind[];
  /** False when a required API key is absent (P1.9) — the provider still
   *  constructs and this flag is readable, but every method rejects. */
  readonly enabled: boolean;
  /** Populated only when `enabled` is false — human-readable, surfaced by
   *  ProviderRegistry.disabledProviders() for an admin notice. */
  readonly disabledReason?: string;

  search(query: SearchQuery): Promise<ProviderSearchResult[]>;
  fetchDetails(ref: ProviderRef): Promise<ProviderDetails>;
  fetchImages(ref: ProviderRef): Promise<ProviderImageRef[]>;
}
