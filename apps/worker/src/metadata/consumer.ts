// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/consumer.ts
//
// The 'metadata' job consumer (P1.6/P1.7, docs/PLAN.md §8.1/§8.3).
//
// `metadataConsumerHandler(deps)` is a FACTORY, not the handler itself —
// it closes over injected dependencies (db, a configured ProviderRegistry,
// an enqueue-image-job function) and returns the actual
// `JobHandler<'metadata'>` a queue.work('metadata', ...) call expects. The
// next wave's wiring in apps/worker/src/index.ts calls this factory once
// at startup with real deps, e.g.:
//   queue.work('metadata', metadataConsumerHandler({ db, registry, enqueueImageJob }));
//
// Scope decision (documented, not silently narrowed): the job payload
// carries only {itemId, mediaKind, contentClass} — no item_type, no
// season/episode numbers — which matches the top-level browsable catalog
// entity per media kind: a movie, a series, an artist, or an album (the
// units a scanner naturally enqueues one metadata-refresh job for).
// season/episode/track enrichment is out of scope for THIS job type: a
// season_details row has no fields beyond season_number (already scan-
// known, non-nullable per D24) worth fetching, and per-episode/per-track
// enrichment is future work layered on top of a matched series/album ref,
// not a standalone job target. Items of those types are a clean no-op here.
//
// LPP v1 (Lane W3) update: the provider chain used to be this file's own
// hardcoded PROVIDER_CHAIN constant, looked up purely by mediaKind. It is
// now resolved PER LIBRARY, fresh, at job time via
// chain-resolution.ts's resolveProviderChainForLibrary — see that file's
// header for the full design (three-layer C5 STRICT defense-in-depth,
// zero-rows-falls-back-to-the-legacy-default behavior-neutrality, why
// there is no cross-job caching). PROVIDER_CHAIN itself moved verbatim to
// provider-chain-defaults.ts (the single default source both modules
// import) — nothing about its VALUES changed. `breakers` is this
// handler's own per-process PluginCircuitBreaker registry (mission point
// 1: "instantiate PluginCircuitBreaker per plugin in the worker process"),
// constructed ONCE when this factory runs and reused for the life of the
// worker process.

import type { JobHandler, JobPayloads } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import {
  findOrCreatePerson,
  findOrCreateTag,
  getProvenanceForItem,
  replaceItemPeople,
  replaceItemTags,
  upsertCatalogItem,
  upsertMetadataProvenance,
  upsertProviderId,
  upsertSatellite,
  withTransaction,
  writeEvent,
} from '@loombre/db/internal';
import { getCurrentRelations, getCurrentSatelliteFields, getMetadataSourceItem, type MetadataItemType } from './item-read.js';
import { mergeFields, type ProviderFieldSource } from './precedence.js';
import { buildLayers, isEqual, toProvenanceMap } from './layers.js';
import { pickBestMatch } from './match.js';
import type { ProviderRegistry } from './registry.js';
import type { ContentClass, MediaKind, PersonCredit, ProviderDetails, ProviderImageRef, ProviderRef } from './provider.js';
import { resolveLppProviderForPlugin, resolveProviderChainForLibrary, type ResolveProviderChainForLibraryDeps } from './chain-resolution.js';
import { pluginIdFromLppProviderName } from './plugin-provider.js';
import { createPluginBreakerRegistry, type PluginBreakerRegistry } from './plugin-breakers.js';
import { redactSecretShapedValues } from '../crash/redact.js';

// PROVIDER_CHAIN itself now lives in provider-chain-defaults.ts (LPP v1,
// Lane W3) — re-exported here so any existing importer of
// `PROVIDER_CHAIN` from this module keeps working unchanged; it is no
// longer used directly below (resolveProviderChainForLibrary consumes it
// internally as the zero-rows fallback).
export { PROVIDER_CHAIN } from './provider-chain-defaults.js';

const SUPPORTED_ITEM_TYPES = new Set<MetadataItemType>(['movie', 'series', 'artist', 'album']);

export interface MetadataConsumerDeps {
  db: DbOrTx;
  registry: ProviderRegistry;
  enqueueImageJob: (payload: JobPayloads['image']) => Promise<unknown>;
  clock?: () => number;
  /** Injectable for tests — forwarded to pickBestMatch's ambiguity log. */
  log?: (message: string) => void;
  /** LPP v1 (Lane W3) — this handler's own per-process
   *  PluginCircuitBreaker registry (mission point 1). Injectable for
   *  tests (so a test can inspect/pre-seed breaker state); defaults to a
   *  fresh registry constructed once per metadataConsumerHandler() call. */
  pluginBreakers?: PluginBreakerRegistry;
}

/** Extracts the per-itemType scalar + relation fields ProviderDetails
 *  carries, keyed to match the DB column names buildLayers/mergeFields
 *  operate on. */
function providerFieldsFor(itemType: MetadataItemType, details: ProviderDetails): Record<string, unknown> {
  const common: Record<string, unknown> = {
    title: details.title,
    sortTitle: details.sortTitle,
    year: details.year,
    communityRating: details.communityRating,
    genres: details.genres,
    tags: details.tags,
    people: details.people,
  };

  switch (details.itemType) {
    case 'movie':
      return { ...common, overview: details.overview, contentRating: details.contentRating, tagline: details.tagline, runtimeMs: details.runtimeMs };
    case 'series':
      return { ...common, overview: details.overview, contentRating: details.contentRating, status: details.status };
    case 'artist':
      return { ...common, overview: details.overview };
    case 'album':
      return common;
    default:
      // season/episode/track are unreachable here — SUPPORTED_ITEM_TYPES
      // filters them out before this function is ever called.
      return common;
  }
}

interface MatchedProvider {
  providerName: string;
  ref: ProviderRef;
  details: ProviderDetails;
  images: ProviderImageRef[];
}

/**
 * d4-f3 (backlog #084): an apply-match whose provider this worker cannot
 * resolve FAILS its job instead of completing with `error: null`. The
 * admin picked one exact candidate on POST /admin/items/{id}/apply-match;
 * "completed, changed nothing, no error" is the one answer GET
 * /admin/jobs/{id} must never give for that. Thrown BEFORE any write, so
 * the "never partially applies" half of the original contract is intact —
 * only the silence is gone. 'metadata' carries retryLimit 2
 * (packages/jobs/src/types.ts), so an unresolvable ref costs three cheap
 * registry/DB lookups before the row reaches 'failed' with this message.
 */
export class ForcedMatchUnresolvableError extends Error {
  readonly provider: string;

  constructor(provider: string, reason: string) {
    super(`forced-match provider "${provider}" could not be resolved by this worker (${reason}) — the chosen match was not applied`);
    this.name = 'ForcedMatchUnresolvableError';
    this.provider = provider;
  }
}

/**
 * Phosphor retheme Wave 2 (Lane L2 — Fix Match's POST /admin/items/{id}/
 * apply-match): MetadataJobPayload.forceRef bypasses search/pickBestMatch
 * entirely and fetches details+images for EXACTLY the admin's chosen
 * candidate.
 *
 * TWO WAYS TO REACH A PROVIDER, in order (d4-f3 added the second):
 *   1. `registry.get(name)` — a built-in registered at worker startup
 *      (apps/worker/src/index.ts), or an `lpp:<pluginId>` adapter some
 *      earlier chain resolution in THIS process already registered.
 *   2. For an `lpp:<pluginId>` name only: construct the adapter ON DEMAND
 *      from the plugin row (chain-resolution.ts's resolveLppProviderForPlugin,
 *      C5 STRICT layers 2+3 included). This is the fix for #084 — forceRef
 *      deliberately skips chain resolution, so a registered+enabled plugin
 *      that no library chain has attached in this worker's lifetime was
 *      simply unreachable through (1), and a perfectly valid admin choice
 *      log-and-skipped forever.
 *
 * An UNRESOLVABLE or administratively DISABLED provider throws
 * (ForcedMatchUnresolvableError, above). A fetchDetails failure still
 * resolves to null — that is a provider outage, not a misdirected job, and
 * it is the same "no match found" no-op an ordinary chain walk produces.
 */
async function resolveForcedMatch(
  db: DbOrTx,
  registry: ProviderRegistry,
  contentClass: ContentClass,
  mediaKind: MediaKind,
  entityKind: 'artist' | 'album' | undefined,
  forceRef: { provider: string; externalId: string },
  lppDeps: ResolveProviderChainForLibraryDeps,
  log: (message: string) => void
): Promise<MatchedProvider | null> {
  let provider = registry.get(forceRef.provider);

  if (!provider) {
    const pluginId = pluginIdFromLppProviderName(forceRef.provider);
    if (pluginId) {
      const name = await resolveLppProviderForPlugin(db, pluginId, contentClass, lppDeps, 'metadata consumer: forced-match');
      if (name) provider = registry.get(name);
    }
  }

  if (!provider) {
    throw new ForcedMatchUnresolvableError(forceRef.provider, 'no such registered built-in provider, and no eligible plugin adapter for it');
  }
  if (!provider.enabled) {
    throw new ForcedMatchUnresolvableError(forceRef.provider, provider.disabledReason ?? 'administratively disabled');
  }

  const ref: ProviderRef = {
    provider: forceRef.provider,
    externalId: forceRef.externalId,
    mediaKind,
    ...(entityKind ? { entityKind } : {}),
  };

  try {
    const details = await registry.fetchDetails(forceRef.provider, contentClass, ref);
    let images: ProviderImageRef[] = [];
    try {
      images = await registry.fetchImages(forceRef.provider, contentClass, ref);
    } catch (err) {
      log(`metadata consumer: forced-match fetchImages failed for provider "${forceRef.provider}": ${err instanceof Error ? err.message : String(err)}`);
    }
    return { providerName: forceRef.provider, ref, details, images };
  } catch (err) {
    log(`metadata consumer: forced-match fetchDetails failed for provider "${forceRef.provider}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function resolveViaProviderChain(
  registry: ProviderRegistry,
  chain: readonly string[],
  mediaKind: MediaKind,
  contentClass: ContentClass,
  title: string,
  year: number | null,
  entityKind: 'artist' | 'album' | undefined,
  log: (message: string) => void
): Promise<MatchedProvider | null> {
  for (const providerName of chain) {
    const provider = registry.get(providerName);
    if (!provider || !provider.enabled) continue;

    try {
      const results = await registry.search(providerName, contentClass, {
        mediaKind,
        title,
        ...(year != null ? { year } : {}),
        ...(entityKind ? { entityKind } : {}),
      });
      const best = pickBestMatch({ mediaKind, title, ...(year != null ? { year } : {}) }, results, { log });
      if (!best) continue;

      const details = await registry.fetchDetails(providerName, contentClass, best.ref);
      let images: ProviderImageRef[] = [];
      try {
        images = await registry.fetchImages(providerName, contentClass, best.ref);
      } catch (err) {
        log(`metadata consumer: fetchImages failed for provider "${providerName}": ${err instanceof Error ? err.message : String(err)}`);
      }
      return { providerName, ref: best.ref, details, images };
    } catch (err) {
      log(`metadata consumer: provider "${providerName}" failed, trying next in chain: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

export function metadataConsumerHandler(deps: MetadataConsumerDeps): JobHandler<'metadata'> {
  const clock = deps.clock ?? (() => Date.now());
  // AUD-A7c-002: the LOGGING BOUNDARY, not the one throw site the finding
  // named — a provider's ProviderFetchError carries its full request URL
  // (TMDB: `?api_key=<secret>` — cache.ts) straight into err.message, and
  // every catch block below forwards err.message into this `log`
  // unmodified. Redacting HERE, on every message this closure ever emits,
  // covers that call site AND every future one that reuses `log` — instead
  // of patching each throw/catch pair (the ad-hoc-string-surgery approach
  // this fix deliberately avoids) — including messages a test-injected
  // deps.log receives, which is what makes "assert on the emitted log
  // content" (not "was the mock called") a meaningful test.
  const sink = deps.log ?? ((message: string) => console.warn(message));
  const log = (message: string) => sink(redactSecretShapedValues(message));
  const pluginBreakers = deps.pluginBreakers ?? createPluginBreakerRegistry();

  return async (payload) => {
    const item = await getMetadataSourceItem(deps.db, payload.itemId);
    if (!item) return; // race: item deleted before the job ran — no-op.

    if (!SUPPORTED_ITEM_TYPES.has(item.itemType)) return;

    const entityKind = item.itemType === 'artist' ? 'artist' : item.itemType === 'album' ? 'album' : undefined;

    // Phosphor retheme Wave 2 (Lane L2 — Fix Match): forceRef bypasses
    // chain resolution AND search entirely — the admin already chose the
    // exact candidate via POST /admin/items/{id}/match-search's ranked
    // list, so re-running the chain/search here would be wasted provider
    // I/O at best and could pick a DIFFERENT candidate than the one
    // approved at worst.
    // d4-f3: the SAME dependency bundle both branches hand to LPP adapter
    // construction — a forced ref reaches a plugin through
    // resolveLppProviderForPlugin, a chain walk through
    // resolveProviderChainForLibrary, and neither may get a different
    // breaker registry or logger than the other.
    const lppDeps: ResolveProviderChainForLibraryDeps = {
      registry: deps.registry,
      getBreaker: (pluginId, seed) => pluginBreakers.getBreaker(pluginId, seed), // C5.1: forward the seed
      clock,
      log,
    };

    const matched = payload.forceRef
      ? await resolveForcedMatch(deps.db, deps.registry, item.contentClass, payload.mediaKind, entityKind, payload.forceRef, lppDeps, log)
      : await resolveViaProviderChain(
          deps.registry,
          // LPP v1 (Lane W3): per-library chain, resolved fresh every job —
          // see chain-resolution.ts's header. Zero library_provider_entries
          // rows resolves to PROVIDER_CHAIN[payload.mediaKind] verbatim.
          await resolveProviderChainForLibrary(deps.db, item.libraryId, payload.mediaKind, item.contentClass, lppDeps),
          payload.mediaKind,
          item.contentClass,
          item.title,
          item.year,
          entityKind,
          log
        );
    if (!matched) return;

    const providerSourceTag = `provider:${matched.providerName}` as ProviderFieldSource;

    const [existingProvenanceRows, currentSatelliteFields, currentRelations] = await Promise.all([
      getProvenanceForItem(deps.db, item.id),
      getCurrentSatelliteFields(deps.db, item.itemType, item.id),
      getCurrentRelations(deps.db, item.id),
    ]);
    const existingProvenance = toProvenanceMap(existingProvenanceRows);

    const current: Record<string, unknown> = {
      title: item.title,
      sortTitle: item.sortTitle,
      year: item.year,
      communityRating: item.communityRating,
      genres: currentRelations.genres,
      tags: currentRelations.tags,
      people: currentRelations.people,
      ...currentSatelliteFields,
    };
    const providerFields = providerFieldsFor(item.itemType, matched.details);

    const layers = buildLayers(item.itemType, providerFields, current, existingProvenance);
    const merged = mergeFields(layers, existingProvenance, {}, providerSourceTag);

    const now = clock();
    const changedFields = Object.keys(merged.fields).filter((field) => !isEqual(merged.fields[field], current[field]));

    const finalTitle = (merged.fields.title as string | undefined) ?? item.title;
    const finalSortTitle = (merged.fields.sortTitle as string | undefined) ?? item.sortTitle;
    const finalYear = 'year' in merged.fields ? (merged.fields.year as number | null) : item.year;
    const finalCommunityRating = 'communityRating' in merged.fields ? (merged.fields.communityRating as number | null) : item.communityRating;
    const finalGenres = (merged.fields.genres as string[] | undefined) ?? currentRelations.genres;
    const finalTags = (merged.fields.tags as string[] | undefined) ?? currentRelations.tags;
    const finalPeople = (merged.fields.people as PersonCredit[] | undefined) ?? currentRelations.people;

    await withTransaction(deps.db, async (trx) => {
      await upsertCatalogItem(trx, {
        id: item.id,
        libraryId: item.libraryId,
        itemType: item.itemType,
        // MUST be forwarded: upsertCatalogItem's ON CONFLICT clause always
        // overwrites parent_id with the caller's value (defaulting to NULL
        // when omitted) — omitting this here silently unlinks an album
        // from its artist (or any other parented item) on every
        // enrichment write. Regression test:
        // apps/worker/test/metadata/consumer.spec.ts "preserves an album
        // item.parent_id ...".
        parentId: item.parentId,
        title: finalTitle,
        sortTitle: finalSortTitle,
        year: finalYear,
        communityRating: finalCommunityRating,
        addedAtMs: item.addedAtMs,
        updatedAtMs: now,
      });

      await writeSatellite(trx, item.itemType, item.id, merged.fields, currentSatelliteFields);

      for (const p of merged.provenance) {
        await upsertMetadataProvenance(trx, { itemId: item.id, field: p.field, source: p.source, updatedAtMs: now });
      }

      for (const [provider, externalId] of Object.entries(matched.details.providerIds)) {
        await upsertProviderId(trx, { itemId: item.id, provider, externalId });
      }

      const tagInputs = [
        ...(await Promise.all(finalGenres.map(async (name) => ({ tagId: (await findOrCreateTag(trx, name, item.contentClass)).id, kind: 'genre' as const })))),
        ...(await Promise.all(finalTags.map(async (name) => ({ tagId: (await findOrCreateTag(trx, name, item.contentClass)).id, kind: 'tag' as const })))),
      ];
      await replaceItemTags(trx, item.id, tagInputs);

      const peopleInputs = await Promise.all(
        finalPeople.map(async (p) => ({
          personId: (await findOrCreatePerson(trx, p.name, item.contentClass)).id,
          role: p.role,
          credit: p.credit ?? null,
          order: p.order,
        }))
      );
      await replaceItemPeople(trx, item.id, peopleInputs);

      if (changedFields.length > 0) {
        await writeEvent(trx, {
          type: 'item.updated',
          tsMs: now,
          payload: { itemId: item.id, libraryId: item.libraryId, itemType: item.itemType, contentClass: item.contentClass, changedFields, updatedAtMs: now },
        });
      }
    });

    for (const image of matched.images) {
      if (image.kind !== 'poster' && image.kind !== 'backdrop') continue;
      await deps.enqueueImageJob({
        entityType: 'catalog_item',
        entityId: item.id,
        kind: image.kind,
        sourcePath: `url:${image.url}`,
      });
    }
  };
}

async function writeSatellite(
  trx: DbOrTx,
  itemType: MetadataItemType,
  itemId: string,
  merged: Record<string, unknown>,
  current: Record<string, unknown>
): Promise<void> {
  function field<T>(name: string, fallback: T): T {
    if (name in merged) return merged[name] as T;
    if (name in current) return current[name] as T;
    return fallback;
  }

  switch (itemType) {
    case 'movie':
      await upsertSatellite(trx, {
        itemType: 'movie',
        item_id: itemId,
        overview: field<string | null>('overview', null),
        content_rating: field<string | null>('contentRating', null),
        tagline: field<string | null>('tagline', null),
        runtime_ms: field<number | null>('runtimeMs', null),
      });
      return;
    case 'series':
      await upsertSatellite(trx, {
        itemType: 'series',
        item_id: itemId,
        overview: field<string | null>('overview', null),
        content_rating: field<string | null>('contentRating', null),
        status: field<'continuing' | 'ended' | 'cancelled' | null>('status', null),
      });
      return;
    case 'artist':
      await upsertSatellite(trx, { itemType: 'artist', item_id: itemId, overview: field<string | null>('overview', null) });
      return;
    case 'album':
      // album_details has no scalar fields beyond item_id/year, and year
      // lives on catalog_items (already written by upsertCatalogItem
      // above) — this satellite still needs its own row for the FK=PK
      // join, so upsert it with the same resolved year.
      await upsertSatellite(trx, { itemType: 'album', item_id: itemId, year: field<number | null>('year', null) });
      return;
    case 'season':
    case 'episode':
    case 'track':
      return; // unreachable — SUPPORTED_ITEM_TYPES filters these out.
  }
}
