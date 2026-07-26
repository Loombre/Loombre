// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/index.ts — public barrel for the
// metadata-provider subsystem (P1.6/P1.7).
//
// `metadataConsumerHandler` is a FACTORY (see consumer.ts's header): call
// it with real deps to get the JobHandler<'metadata'> a
// `queue.work('metadata', ...)` call expects. Wiring into
// apps/worker/src/index.ts happens in a later wave, by design (out of
// this module's scope).

export type {
  ContentClass,
  ImageKind,
  MediaKind,
  MetadataProvider,
  PersonCredit,
  PersonRole,
  ProviderDetails,
  ProviderIdMap,
  ProviderImageRef,
  ProviderRef,
  ProviderSearchResult,
  SearchQuery,
  SeriesStatus,
  MovieProviderDetails,
  SeriesProviderDetails,
  SeasonProviderDetails,
  EpisodeProviderDetails,
  ArtistProviderDetails,
  AlbumProviderDetails,
  TrackProviderDetails,
} from './provider.js';

export {
  ProviderRegistry,
  RestrictedProviderScopeError,
  UnknownProviderError,
  type DisabledProviderNotice,
} from './registry.js';

export { TokenBucket, acquire, systemClock, PROVIDER_RATE_LIMITS, type Clock, type Sleep } from './rate-limit.js';

export { cachedGet, ProviderFetchError, CACHE_TTL_MS, type CachingFetchDeps, type CachedGetOptions, type EndpointClass, type FetchLike } from './cache.js';

export { resolveApiKey, resolveApiKeyWithKeyring, type KeyResolution } from './keys.js';

export {
  mergeFields,
  type FieldSource,
  type ProviderFieldSource,
  type FieldLayers,
  type LayeredFields,
  type ExistingProvenanceEntry,
  type ExistingProvenance,
  type MergeFieldsResult,
} from './precedence.js';

export { parseNfo, type ParsedNfo, type NfoParseResult, type NfoActor, type NfoUniqueId } from './nfo.js';

export { pickBestMatch, titleSimilarity, scoreCandidate, type PickBestMatchOptions, type ScoredCandidate } from './match.js';

export { getMetadataSourceItem, getCurrentSatelliteFields, getCurrentRelations, type MetadataSourceItem, type MetadataItemType, type CurrentRelations } from './item-read.js';

export { metadataConsumerHandler, type MetadataConsumerDeps } from './consumer.js';

export { metadataSearchConsumerHandler, type MetadataSearchConsumerDeps, type MatchCandidate } from './match-search-consumer.js';

export { createTmdbProvider, type TmdbProviderDeps } from './providers/tmdb.js';
export { createTvdbProvider, type TvdbProviderDeps } from './providers/tvdb.js';
export { createMusicBrainzProvider, type MusicBrainzProviderDeps } from './providers/musicbrainz.js';

// Deliberately NOT re-exported here: makeFakeProvider (test-support.ts) is
// its own barrel, imported directly by tests
// (`../../src/metadata/test-support.js`) — kept out of the production
// barrel so nothing outside test/ can accidentally depend on it.
