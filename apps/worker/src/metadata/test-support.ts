// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/test-support.ts
//
// FakeProvider (P1.6): the deterministic in-memory MetadataProvider test
// workhorse. Every non-contract test that needs a MetadataProvider uses
// this instead of hitting a real provider or hand-rolling a mock. Supports
// both content classes (pass `contentClass: 'restricted'`), configurable
// results/latency/failures.
//
// Lives in src/ (not test/) so it is an ordinary importable module — the
// "test-support barrel" the mission spec calls for — while never being
// wired into any production code path (nothing outside test/ imports it).

import type {
  ContentClass,
  MediaKind,
  MetadataProvider,
  ProviderDetails,
  ProviderImageRef,
  ProviderRef,
  ProviderSearchResult,
  SearchQuery,
} from './provider.js';

export interface FakeProviderOptions {
  name?: string;
  contentClass?: ContentClass;
  kinds?: MediaKind[];
  enabled?: boolean;
  disabledReason?: string;

  /** Overrides the default single-candidate search response. */
  searchResults?: ProviderSearchResult[];
  /** Overrides the default synthesized details. Required if a test calls
   *  fetchDetails() and cares about the shape returned. */
  details?: ProviderDetails;
  /** Overrides the default empty image list. */
  images?: ProviderImageRef[];

  /** Simulated network latency applied to every method call, ms. */
  latencyMs?: number;

  /** When true (or an Error), the corresponding method rejects. */
  failSearch?: boolean | Error;
  failDetails?: boolean | Error;
  failImages?: boolean | Error;
}

function toRejection(flag: boolean | Error | undefined, methodName: string): Error | null {
  if (!flag) return null;
  if (flag instanceof Error) return flag;
  return new Error(`FakeProvider: ${methodName} configured to fail`);
}

async function delay(ms: number | undefined): Promise<void> {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds a fully in-memory, deterministic MetadataProvider for tests. */
export function makeFakeProvider(opts: FakeProviderOptions = {}): MetadataProvider {
  const name = opts.name ?? 'fake';
  const contentClass = opts.contentClass ?? 'general';
  const kinds = opts.kinds ?? ['movie', 'tv', 'music'];
  const enabled = opts.enabled ?? true;

  const provider: MetadataProvider = {
    name,
    contentClass,
    kinds,
    enabled,
    ...(opts.disabledReason !== undefined ? { disabledReason: opts.disabledReason } : {}),

    async search(query: SearchQuery): Promise<ProviderSearchResult[]> {
      await delay(opts.latencyMs);
      const failure = toRejection(opts.failSearch, 'search');
      if (failure) throw failure;

      if (opts.searchResults) return opts.searchResults;

      return [
        {
          ref: { provider: name, externalId: '1', mediaKind: query.mediaKind },
          title: query.title,
          ...(query.year !== undefined ? { year: query.year } : {}),
        },
      ];
    },

    async fetchDetails(ref: ProviderRef): Promise<ProviderDetails> {
      await delay(opts.latencyMs);
      const failure = toRejection(opts.failDetails, 'fetchDetails');
      if (failure) throw failure;

      if (opts.details) return opts.details;

      return {
        itemType: 'movie',
        title: 'Fake Title',
        sortTitle: 'Fake Title',
        year: null,
        overview: null,
        communityRating: null,
        contentRating: null,
        genres: [],
        tags: [],
        people: [],
        providerIds: { [name]: ref.externalId },
        tagline: null,
        runtimeMs: null,
      };
    },

    async fetchImages(_ref: ProviderRef): Promise<ProviderImageRef[]> {
      await delay(opts.latencyMs);
      const failure = toRejection(opts.failImages, 'fetchImages');
      if (failure) throw failure;
      return opts.images ?? [];
    },
  };

  return provider;
}
