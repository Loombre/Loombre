// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/cache.ts
//
// Caching fetch wrapper (P1.11). Every HTTP GET a provider makes goes
// through `cachedGet`, backed by the `provider_cache` table via
// @loombre/db/internal's upsertProviderCacheEntry/getProviderCacheEntry.
// Cache key = (provider, sha256(url + relevant header values)) — "relevant"
// headers are ones that change what the response body *means* (e.g.
// Accept-Language); volatile auth artifacts (a rotating bearer token) are
// deliberately excluded from the key so a token refresh doesn't bust an
// otherwise-identical cached response (see providers/tvdb.ts).

import { createHash } from 'node:crypto';
import { getProviderCacheEntry, upsertProviderCacheEntry, type DbOrTx } from '@loombre/db/internal';

export type EndpointClass = 'search' | 'details' | 'images';

/** TTL per endpoint class (P1.11): search results churn fastest, details and
 *  image refs are comparatively stable. */
export const CACHE_TTL_MS: Record<EndpointClass, number> = {
  search: 24 * 60 * 60 * 1000,
  details: 7 * 24 * 60 * 60 * 1000,
  images: 7 * 24 * 60 * 60 * 1000,
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CachingFetchDeps {
  db: DbOrTx;
  provider: string;
  fetchImpl: FetchLike;
  clock?: () => number;
}

export interface CachedGetOptions {
  endpointClass: EndpointClass;
  /** Headers actually sent with the request. */
  headers?: Record<string, string>;
  /** Subset of `headers` (by key) that participates in the cache key. Keys
   *  not listed here (e.g. a rotating Authorization bearer token) are sent
   *  but not hashed. Defaults to hashing none of the headers (url-only key). */
  cacheKeyHeaderNames?: string[];
}

function requestHash(url: string, headers: Record<string, string> | undefined, keyHeaderNames: string[] | undefined): string {
  const relevant = (keyHeaderNames ?? [])
    .slice()
    .sort()
    .map((name) => `${name.toLowerCase()}=${headers?.[name] ?? ''}`)
    .join('&');
  return createHash('sha256').update(`${url}|${relevant}`).digest('hex');
}

export class ProviderFetchError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number, statusText: string) {
    super(`provider fetch failed: ${status} ${statusText} (${url})`);
    this.name = 'ProviderFetchError';
    this.status = status;
    this.url = url;
  }
}

/**
 * Fetches `url` through the provider_cache: a fresh (non-expired) cache hit
 * returns the cached body without touching `fetchImpl`; otherwise `fetchImpl`
 * is called and the result cached with a TTL keyed on `endpointClass` before
 * being returned. Non-2xx responses are never cached and throw
 * ProviderFetchError.
 */
export async function cachedGet(deps: CachingFetchDeps, url: string, opts: CachedGetOptions): Promise<string> {
  const now = (deps.clock ?? Date.now)();
  const hash = requestHash(url, opts.headers, opts.cacheKeyHeaderNames);

  const cached = await getProviderCacheEntry(deps.db, deps.provider, hash, now);
  if (cached) {
    return cached.body;
  }

  const res = await deps.fetchImpl(url, opts.headers ? { headers: opts.headers } : undefined);
  if (!res.ok) {
    throw new ProviderFetchError(url, res.status, res.statusText);
  }
  const body = await res.text();

  await upsertProviderCacheEntry(deps.db, {
    provider: deps.provider,
    requestHash: hash,
    body,
    fetchedAtMs: now,
    expiresAtMs: now + CACHE_TTL_MS[opts.endpointClass],
  });

  return body;
}
