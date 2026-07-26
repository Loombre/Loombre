// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-protocol/src/capabilities/metadata-provider.ts
//
// Capability 3.1. Wire types mirror the INTERNAL metadata-provider interface
// (apps/worker/src/metadata/provider.ts's `MetadataProvider.search` /
// `.fetchDetails` / `.fetchImages`, and its keys.ts sibling) field-for-field
// so a host adapter (W2) can map a wire request/response onto that interface
// with zero lossy translation in either direction — every field on
// SearchQuery/ProviderRef/ProviderSearchResult/ProviderDetails(+its 7
// itemType variants)/ProviderImageRef below has a same-named, same-shape
// counterpart in that file. `MediaKind`/`ContentClass`/`PersonRole`/
// `SeriesStatus`/`ImageKind`/the two-entity-kind union are copied verbatim
// from provider.ts's own literal unions (that file already documents each
// one; this file does not re-derive the rationale, only the shape).

import { z } from "zod";
import { LppContentClassSchema, LppMediaKindSchema } from "../enums.js";

// ============================================================================
// capability envelope fields (C2 capability 3.1: `{ type, mediaKinds,
// contentClass, endpoints }`)
// ============================================================================

// H-5 fix wave (frozen-contract narrowing, D23): the ORIGINAL `/^\//` regex
// accepted `"//attacker.example/x"` and `"/\attacker.example/x"` — WHATWG
// `new URL(path, baseUrl)` resolution treats a leading `//` (and, in some
// contexts, `/\`) as an AUTHORITY, not a path, so either shape silently
// redirects every call (carrying `X-LPP-Config`/`X-LPP-Secret-*` headers,
// or a signed event-delivery batch) to an arbitrary third-party host chosen
// by the plugin, with no scope-change signal at all (manifest-diff.ts
// treats endpoint-path changes as non-scope-concerns). The tightened regex
// requires a `/` that is NOT immediately followed by another `/` or a `\`.
const lppPath = z.string().regex(/^\/(?![/\\])/, { message: 'endpoint path must start with "/" and not be protocol-relative (no leading "//" or "/\\")' });

export const LppMetadataProviderEndpointsSchema = z
  .object({
    search: lppPath,
    details: lppPath,
    images: lppPath,
  })
  .strict();

export type LppMetadataProviderEndpoints = z.infer<typeof LppMetadataProviderEndpointsSchema>;

/** Canonical endpoint paths (C2). A manifest MAY declare different paths
 *  (endpoints.ts fields are plain strings, not literals) but every
 *  reference/example plugin in this repo uses these verbatim. */
export const LPP_DEFAULT_METADATA_PROVIDER_ENDPOINTS: LppMetadataProviderEndpoints = {
  search: "/lpp/provider/search",
  details: "/lpp/provider/details",
  images: "/lpp/provider/images",
};

export const LppMetadataProviderCapabilitySchema = z
  .object({
    type: z.literal("metadata-provider"),
    mediaKinds: z.array(LppMediaKindSchema).min(1),
    contentClass: LppContentClassSchema,
    endpoints: LppMetadataProviderEndpointsSchema,
  })
  .strict();

export type LppMetadataProviderCapability = z.infer<typeof LppMetadataProviderCapabilitySchema>;

// ============================================================================
// search — mirrors provider.ts SearchQuery / ProviderSearchResult
// ============================================================================

/** Music-only entity discriminator (provider.ts: MusicBrainz has distinct
 *  search endpoints per entity with no shared id space). */
export const LppEntityKindSchema = z.enum(["artist", "album", "track"]);

export const LppSearchRequestSchema = z
  .object({
    mediaKind: LppMediaKindSchema,
    title: z.string().min(1),
    year: z.number().int().min(0).max(9999).nullable().optional(),
    entityKind: LppEntityKindSchema.optional(),
  })
  .strict();

export type LppSearchRequest = z.infer<typeof LppSearchRequestSchema>;

export const LppProviderRefSchema = z
  .object({
    provider: z.string().min(1),
    /** The provider's own id for the matched entity (TMDB numeric id as a
     *  string, an MBID, a TVDB series id — provider.ts ProviderRef.externalId). */
    externalId: z.string().min(1),
    mediaKind: LppMediaKindSchema,
    seasonNumber: z.number().int().min(0).nullable().optional(),
    episodeNumber: z.number().int().min(0).nullable().optional(),
    entityKind: LppEntityKindSchema.optional(),
  })
  .strict();

export type LppProviderRef = z.infer<typeof LppProviderRefSchema>;

export const LppSearchResultSchema = z
  .object({
    ref: LppProviderRefSchema,
    title: z.string().min(1),
    year: z.number().int().min(0).max(9999).nullable().optional(),
    overview: z.string().nullable().optional(),
    popularity: z.number().nullable().optional(),
  })
  .strict();

export type LppSearchResult = z.infer<typeof LppSearchResultSchema>;

export const LppSearchResponseSchema = z
  .object({
    results: z.array(LppSearchResultSchema),
  })
  .strict();

export type LppSearchResponse = z.infer<typeof LppSearchResponseSchema>;

// ============================================================================
// details — mirrors provider.ts's itemType-discriminated ProviderDetails
// ============================================================================

export const LppDetailsRequestSchema = z
  .object({
    ref: LppProviderRefSchema,
  })
  .strict();

export type LppDetailsRequest = z.infer<typeof LppDetailsRequestSchema>;

export const LppPersonRoleSchema = z.enum([
  "actor",
  "director",
  "writer",
  "artist",
  "album_artist",
  "performer",
  "guest",
]);

export const LppPersonCreditSchema = z
  .object({
    name: z.string().min(1),
    role: LppPersonRoleSchema,
    /** Display order within the role (item_people.ord). */
    order: z.number().int().min(0),
    credit: z.string().nullable().optional(),
  })
  .strict();

export type LppPersonCredit = z.infer<typeof LppPersonCreditSchema>;

export const LppSeriesStatusSchema = z.enum(["continuing", "ended", "cancelled"]);

export const LppImageKindSchema = z.enum(["poster", "backdrop", "logo", "disc", "thumb"]);

/** provider name -> that provider's external id (provider.ts ProviderIdMap). */
export const LppProviderIdMapSchema = z.record(z.string(), z.string());

const providerDetailsCommon = {
  title: z.string().min(1),
  sortTitle: z.string().min(1),
  year: z.number().int().min(0).max(9999).nullable(),
  overview: z.string().nullable(),
  communityRating: z.number().min(0).max(10).nullable(),
  contentRating: z.string().nullable(),
  genres: z.array(z.string()),
  tags: z.array(z.string()),
  people: z.array(LppPersonCreditSchema),
  providerIds: LppProviderIdMapSchema,
};

export const LppMovieDetailsSchema = z
  .object({
    ...providerDetailsCommon,
    itemType: z.literal("movie"),
    tagline: z.string().nullable(),
    runtimeMs: z.number().int().min(0).nullable(),
  })
  .strict();

export const LppSeriesDetailsSchema = z
  .object({
    ...providerDetailsCommon,
    itemType: z.literal("series"),
    status: LppSeriesStatusSchema.nullable(),
    airDateMs: z.number().int().min(0).nullable(),
  })
  .strict();

export const LppSeasonDetailsSchema = z
  .object({
    ...providerDetailsCommon,
    itemType: z.literal("season"),
    seasonNumber: z.number().int().min(0),
  })
  .strict();

export const LppEpisodeDetailsSchema = z
  .object({
    ...providerDetailsCommon,
    itemType: z.literal("episode"),
    seasonNumber: z.number().int().min(0),
    episodeNumber: z.number().int().min(0),
    airDateMs: z.number().int().min(0).nullable(),
  })
  .strict();

export const LppArtistDetailsSchema = z
  .object({
    ...providerDetailsCommon,
    itemType: z.literal("artist"),
  })
  .strict();

export const LppAlbumDetailsSchema = z
  .object({
    ...providerDetailsCommon,
    itemType: z.literal("album"),
  })
  .strict();

export const LppTrackDetailsSchema = z
  .object({
    ...providerDetailsCommon,
    itemType: z.literal("track"),
    trackNumber: z.number().int().min(0).nullable(),
    discNumber: z.number().int().min(0).nullable(),
    durationMs: z.number().int().min(0).nullable(),
  })
  .strict();

export const LppProviderDetailsSchema = z.discriminatedUnion("itemType", [
  LppMovieDetailsSchema,
  LppSeriesDetailsSchema,
  LppSeasonDetailsSchema,
  LppEpisodeDetailsSchema,
  LppArtistDetailsSchema,
  LppAlbumDetailsSchema,
  LppTrackDetailsSchema,
]);

export type LppProviderDetails = z.infer<typeof LppProviderDetailsSchema>;

export const LppDetailsResponseSchema = z
  .object({
    details: LppProviderDetailsSchema,
  })
  .strict();

export type LppDetailsResponse = z.infer<typeof LppDetailsResponseSchema>;

// ============================================================================
// images — mirrors provider.ts ProviderImageRef
// ============================================================================

export const LppImagesRequestSchema = z
  .object({
    ref: LppProviderRefSchema,
  })
  .strict();

export type LppImagesRequest = z.infer<typeof LppImagesRequestSchema>;

export const LppProviderImageRefSchema = z
  .object({
    kind: LppImageKindSchema,
    /** Absolute, fetchable URL — the image pipeline downloads it directly;
     *  providers never hand back bytes (docs/PLAN.md §8.3). */
    url: z.string().min(1),
    width: z.number().int().min(0).nullable().optional(),
    height: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export type LppProviderImageRef = z.infer<typeof LppProviderImageRefSchema>;

export const LppImagesResponseSchema = z
  .object({
    images: z.array(LppProviderImageRefSchema),
  })
  .strict();

export type LppImagesResponse = z.infer<typeof LppImagesResponseSchema>;
