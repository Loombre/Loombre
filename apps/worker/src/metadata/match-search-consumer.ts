// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/match-search-consumer.ts
//
// The 'metadata-search' job handler (Phosphor retheme Wave 2, Lane L2 — Fix
// Match's POST /admin/items/{id}/match-search). CLAUDE.md invariant 6: the
// bounded provider search this handler runs is the exact I/O the mission's
// admin endpoint deliberately keeps OUT of its own request path — the
// endpoint only enqueues (apps/server/src/catalog/admin.controller.ts),
// this handler does the work, and delivers the ranked result over the
// events socket as an admin-only `metadata.match-candidates` outbox event
// (packages/contract/event-schemas/metadata.match-candidates.schema.json) —
// it never writes to the catalog itself.
//
// Deliberately NOT built on top of consumer.ts's resolveViaProviderChain:
// that helper stops at the FIRST provider whose search returns any result
// (the scanner's own automatic best-guess behavior) — Fix Match wants
// EVERY candidate across EVERY enabled provider in the resolved chain,
// ranked by match.ts's scoreCandidate, so the admin can pick a DIFFERENT
// match than the one the scanner would have picked automatically. Reuses
// the exact same chain resolution (resolveProviderChainForLibrary, LPP v1
// Lane W3 — built-ins and registered plugins alike) and the exact same
// per-process plugin-circuit-breaker registry pattern consumer.ts uses.
//
// Never throws out to the job queue on a per-provider search failure — one
// bad provider must not block the rest of the chain (mirrors
// resolveViaProviderChain's own try/continue posture) — and an item that
// no longer exists, or isn't an enrichable type, or whose library vanished
// mid-flight (all ordinary races in an async job queue) resolve to an
// EMPTY candidates array delivered honestly, never a thrown error and
// never a fabricated result (U9).

import { getLibraryById, withTransaction, writeEvent, type DbOrTx } from '@loombre/db/internal';
import type { JobHandler } from '@loombre/jobs';
import { getMetadataSourceItem, type MetadataItemType } from './item-read.js';
import { resolveProviderChainForLibrary } from './chain-resolution.js';
import { scoreCandidate } from './match.js';
import { createPluginBreakerRegistry, type PluginBreakerRegistry } from './plugin-breakers.js';
import type { ProviderRegistry } from './registry.js';
import type { MediaKind, SearchQuery } from './provider.js';
import { redactSecretShapedValues } from '../crash/redact.js';

/** Mirrors consumer.ts's METADATA_ENRICHABLE_TYPES / SUPPORTED_ITEM_TYPES
 *  verbatim — season/episode/track are never independently matched. */
const SUPPORTED_ITEM_TYPES = new Set<MetadataItemType>(['movie', 'series', 'artist', 'album']);

/** Bounds the delivered candidate list (a bounded search, not "every result
 *  every provider ever returns") — each provider's own search already
 *  returns a reasonably small page, this just caps the MERGED, ranked list
 *  the admin actually sees. */
const MAX_CANDIDATES = 8;

export interface MatchCandidate {
  provider: string;
  externalId: string;
  title: string;
  year: number | null;
  confidence: number;
  isBest: boolean;
}

export interface MetadataSearchConsumerDeps {
  db: DbOrTx;
  registry: ProviderRegistry;
  /** Injectable for tests — forwarded to resolveProviderChainForLibrary's
   *  ambiguity/skip logging, exactly like MetadataConsumerDeps.log. */
  log?: (message: string) => void;
  clock?: () => number;
  /** Shares NOTHING with metadataConsumerHandler's own registry by default
   *  (each factory call constructs its own) — apps/worker/src/index.ts
   *  wiring decides whether to share one across both job types; either is
   *  safe (LD8: breaker state is per-plugin, not per-job-type-sensitive). */
  pluginBreakers?: PluginBreakerRegistry;
}

function toConfidence(score: number): number {
  // score is titleSimilarity (0..1) minus a year penalty (0..0.5) — clamp
  // before scaling so a heavily year-penalized match never reports a
  // negative confidence, and round to one decimal (the UI's confidence bar
  // never needs sub-0.1% precision).
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 10;
}

async function emitMatchCandidates(
  db: DbOrTx,
  input: { itemId: string; jobId: string; candidates: MatchCandidate[]; searchedAtMs: number }
): Promise<void> {
  await withTransaction(db, async (trx) => {
    await writeEvent(trx, {
      type: 'metadata.match-candidates',
      tsMs: input.searchedAtMs,
      actorUserId: null,
      payload: {
        itemId: input.itemId,
        jobId: input.jobId,
        candidates: input.candidates,
        searchedAtMs: input.searchedAtMs,
      },
    });
  });
}

export function metadataSearchConsumerHandler(deps: MetadataSearchConsumerDeps): JobHandler<'metadata-search'> {
  const clock = deps.clock ?? (() => Date.now());
  // AUD-A7c-002: same logging-boundary fix as consumer.ts's own `log` —
  // this handler's per-provider catch block below forwards a failed
  // provider's err.message (which, for TMDB, carries `?api_key=<secret>`
  // in the request URL a ProviderFetchError wraps — cache.ts) straight
  // into log(); redact every message this closure emits, not just that
  // one branch.
  const sink = deps.log ?? ((message: string) => console.warn(message));
  const log = (message: string) => sink(redactSecretShapedValues(message));
  const pluginBreakers = deps.pluginBreakers ?? createPluginBreakerRegistry();

  return async (payload, meta) => {
    const item = await getMetadataSourceItem(deps.db, payload.itemId);
    if (!item || !SUPPORTED_ITEM_TYPES.has(item.itemType)) {
      await emitMatchCandidates(deps.db, { itemId: payload.itemId, jobId: meta.jobId, candidates: [], searchedAtMs: clock() });
      return;
    }

    const library = await getLibraryById(deps.db, item.libraryId);
    if (!library) {
      await emitMatchCandidates(deps.db, { itemId: payload.itemId, jobId: meta.jobId, candidates: [], searchedAtMs: clock() });
      return;
    }

    const mediaKind: MediaKind = library.media_kind;
    const entityKind = item.itemType === 'artist' ? 'artist' : item.itemType === 'album' ? 'album' : undefined;
    const query: SearchQuery = {
      mediaKind,
      title: item.title,
      ...(item.year != null ? { year: item.year } : {}),
      ...(entityKind ? { entityKind } : {}),
    };

    const chain = await resolveProviderChainForLibrary(deps.db, item.libraryId, mediaKind, item.contentClass, {
      registry: deps.registry,
      getBreaker: (pluginId) => pluginBreakers.getBreaker(pluginId),
      clock,
      log,
    });

    const scored: { provider: string; externalId: string; title: string; year: number | null; score: number }[] = [];
    for (const providerName of chain) {
      const provider = deps.registry.get(providerName);
      if (!provider || !provider.enabled) continue;
      try {
        const results = await deps.registry.search(providerName, item.contentClass, query);
        for (const result of results) {
          scored.push({
            provider: providerName,
            externalId: result.ref.externalId,
            title: result.title,
            year: result.year ?? null,
            score: scoreCandidate(query, result),
          });
        }
      } catch (err) {
        log(
          `metadata-search: provider "${providerName}" failed, continuing with the rest of the chain: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const candidates: MatchCandidate[] = scored.slice(0, MAX_CANDIDATES).map((c, i) => ({
      provider: c.provider,
      externalId: c.externalId,
      title: c.title,
      year: c.year,
      confidence: toConfidence(c.score),
      isBest: i === 0,
    }));

    await emitMatchCandidates(deps.db, { itemId: payload.itemId, jobId: meta.jobId, candidates, searchedAtMs: clock() });
  };
}
