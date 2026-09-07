// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/refresh-consumer.ts
//
// The 'metadata-refresh' fan-out (packages/jobs MetadataRefreshJobPayload
// documents the three triggers). This handler walks libraries and enqueues
// ONE 'metadata' job per item; it never talks to a provider itself. Why a
// job and not an inline loop in the server: a large library is tens of
// thousands of ledger inserts, which has no place in a PUT /admin/
// provider-keys request (CLAUDE.md invariant 6 — long-running work goes
// through the queue), and the worker is the only process that can answer
// "does this library's chain include the provider" (chain-resolution.ts,
// plugin adapters included) and "is the provider enabled now".
//
// Provider-scoped runs (`payload.provider`): the provider must be enabled
// at the moment of the run — refreshAll() re-reads its key first — else
// the job logs and returns without enqueueing anything; and the run
// records metadata_provider_state.enabled = true so the next worker boot
// does not fan out a second time for the same key.

import type { JobHandler, JobPayloads } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import { getLibraryById, listLibraries, listRefreshableItems, upsertMetadataProviderState, type LibraryRow } from '@loombre/db/internal';
import { resolveProviderChainForLibrary, type ResolveProviderChainForLibraryDeps } from './chain-resolution.js';
import { createPluginBreakerRegistry, type PluginBreakerRegistry } from './plugin-breakers.js';
import type { ProviderRegistry } from './registry.js';

export interface MetadataRefreshConsumerDeps {
  db: DbOrTx;
  registry: ProviderRegistry;
  enqueueMetadataJob: (payload: JobPayloads['metadata'], opts: { subjectItemId: string }) => Promise<unknown>;
  clock?: () => number;
  log?: (message: string) => void;
  pluginBreakers?: PluginBreakerRegistry;
  /** Items per DB page during the walk. */
  pageSize?: number;
}

export interface MetadataRefreshSummary {
  librariesVisited: number;
  librariesSkipped: number;
  itemsEnqueued: number;
}

function mediaKindForLibrary(kind: LibraryRow['media_kind']): JobPayloads['metadata']['mediaKind'] {
  return kind;
}

/** Exported for tests — the handler's whole body, returning what it did. */
export async function runMetadataRefresh(deps: MetadataRefreshConsumerDeps, payload: JobPayloads['metadata-refresh']): Promise<MetadataRefreshSummary> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const clock = deps.clock ?? (() => Date.now());
  const pageSize = deps.pageSize ?? 500;
  const pluginBreakers = deps.pluginBreakers ?? createPluginBreakerRegistry();
  const summary: MetadataRefreshSummary = { librariesVisited: 0, librariesSkipped: 0, itemsEnqueued: 0 };

  if (payload.provider !== null) {
    await deps.registry.refreshAll();
    const provider = deps.registry.get(payload.provider);
    if (!provider || !provider.enabled) {
      log(`metadata refresh: provider "${payload.provider}" is not enabled (${provider?.disabledReason ?? 'not registered'}) — nothing enqueued`);
      return summary;
    }
    await upsertMetadataProviderState(deps.db, { provider: payload.provider, enabled: true, observedAtMs: clock() });
  }

  const libraries: LibraryRow[] = payload.libraryId !== null
    ? [await getLibraryById(deps.db, payload.libraryId)].filter((l): l is LibraryRow => l !== undefined)
    : await listLibraries(deps.db);

  const lppDeps: ResolveProviderChainForLibraryDeps = {
    registry: deps.registry,
    getBreaker: (pluginId, seed) => pluginBreakers.getBreaker(pluginId, seed),
    clock,
    log,
  };

  for (const library of libraries) {
    const mediaKind = mediaKindForLibrary(library.media_kind);
    const chain = await resolveProviderChainForLibrary(deps.db, library.id, mediaKind, library.content_class, lppDeps);
    if (payload.provider !== null && !chain.includes(payload.provider)) {
      summary.librariesSkipped += 1;
      continue;
    }
    summary.librariesVisited += 1;

    let afterId: string | null = null;
    for (;;) {
      const page = await listRefreshableItems(deps.db, { libraryId: library.id, unmatchedOnly: payload.scope === 'unmatched', afterId, limit: pageSize });
      if (page.length === 0) break;
      for (const item of page) {
        // 'all' keeps an existing match: the first chain provider the item
        // already has an id for becomes forceRef, so a Refresh re-fetches
        // details/images for the SAME candidate an admin (or the chain)
        // chose rather than re-running search and maybe picking another.
        const known = chain.map((name) => item.providerIds.find((p) => p.provider === name)).find((p) => p !== undefined);
        await deps.enqueueMetadataJob(
          {
            itemId: item.id,
            mediaKind,
            contentClass: item.contentClass,
            ...(known ? { forceRef: { provider: known.provider, externalId: known.externalId } } : {}),
          },
          { subjectItemId: item.id }
        );
        summary.itemsEnqueued += 1;
      }
      afterId = page[page.length - 1]!.id;
      if (page.length < pageSize) break;
    }
  }

  log(
    `metadata refresh (${payload.provider !== null ? `provider ${payload.provider}` : `library ${payload.libraryId}`}, scope ${payload.scope}): ` +
      `${summary.itemsEnqueued} metadata job(s) enqueued across ${summary.librariesVisited} librar${summary.librariesVisited === 1 ? 'y' : 'ies'}` +
      (summary.librariesSkipped > 0 ? `, ${summary.librariesSkipped} skipped (chain does not include the provider)` : '')
  );
  return summary;
}

export function metadataRefreshConsumerHandler(deps: MetadataRefreshConsumerDeps): JobHandler<'metadata-refresh'> {
  return async (payload) => {
    await runMetadataRefresh(deps, payload);
  };
}

/**
 * Worker boot: compare each keyed provider's enabled state with what the
 * last boot recorded (metadata_provider_state) and fan out once when it
 * flipped to enabled — the env-var path (an operator adds
 * LOOMBRE_TMDB_API_KEY to loombre.env and restarts), which the server's
 * key-save hook never sees. Returns the providers it enqueued for.
 */
export async function enqueueRefreshForNewlyEnabledProviders(
  db: DbOrTx,
  registry: ProviderRegistry,
  providers: readonly string[],
  enqueue: (payload: JobPayloads['metadata-refresh']) => Promise<unknown>,
  read: (db: DbOrTx, provider: string) => Promise<{ enabled: boolean } | undefined>,
  clock: () => number = () => Date.now(),
): Promise<string[]> {
  const enqueued: string[] = [];
  for (const name of providers) {
    const enabledNow = registry.get(name)?.enabled === true;
    const last = await read(db, name);
    if (enabledNow && !(last?.enabled ?? false)) {
      await enqueue({ libraryId: null, provider: name, scope: 'unmatched' });
      enqueued.push(name);
    }
    await upsertMetadataProviderState(db, { provider: name, enabled: enabledNow, observedAtMs: clock() });
  }
  return enqueued;
}
