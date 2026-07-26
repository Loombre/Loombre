// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/cache.spec.ts
//
// Live-DB test for the caching fetch wrapper (P1.11). SELF-SUFFICIENT like
// packages/db/test/*.spec.ts: resets @loombre/db's schema in beforeAll.
// Uses a fake `fetch` (no network) to prove: first call hits the fake
// fetch and writes provider_cache; second call (same url/headers) is
// served from cache without calling fetch again; expired entries are
// refetched.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '@loombre/db';
import { cachedGet, ProviderFetchError } from '../../src/metadata/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, '../../../../packages/db');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: ReturnType<typeof createDb>;

beforeAll(() => {
  run(path.join(DB_PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => body,
  } as Response;
}

describe('cachedGet', () => {
  it('calls fetchImpl once and caches the body on the first request', async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async () => fakeResponse('{"hello":"world"}'));

    const body = await cachedGet(
      { db, provider: 'test-provider-1', fetchImpl, clock: () => clock },
      'https://example.invalid/a',
      { endpointClass: 'details' }
    );

    expect(body).toBe('{"hello":"world"}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serves the second identical request from cache without calling fetchImpl again', async () => {
    let clock = 2_000_000;
    const fetchImpl = vi.fn(async () => fakeResponse('{"v":1}'));
    const deps = { db, provider: 'test-provider-2', fetchImpl, clock: () => clock };

    const first = await cachedGet(deps, 'https://example.invalid/b', { endpointClass: 'search' });
    clock += 1000;
    const second = await cachedGet(deps, 'https://example.invalid/b', { endpointClass: 'search' });

    expect(first).toBe('{"v":1}');
    expect(second).toBe('{"v":1}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cached entry has expired (TTL elapsed)', async () => {
    let clock = 3_000_000;
    const fetchImpl = vi.fn(async () => fakeResponse(`{"at":${clock}}`));
    const deps = { db, provider: 'test-provider-3', fetchImpl, clock: () => clock };

    const first = await cachedGet(deps, 'https://example.invalid/c', { endpointClass: 'search' });
    expect(first).toBe(`{"at":3000000}`);

    // 'search' TTL is 24h — advance well past it.
    clock += 25 * 60 * 60 * 1000;
    const second = await cachedGet(deps, 'https://example.invalid/c', { endpointClass: 'search' });

    expect(second).toBe(`{"at":${clock}}`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('two different endpoint classes for the same url are cached independently by request hash', async () => {
    // Same url, but cache key also depends on provider — different provider
    // names must not collide.
    let clock = 4_000_000;
    const fetchA = vi.fn(async () => fakeResponse('{"provider":"a"}'));
    const fetchB = vi.fn(async () => fakeResponse('{"provider":"b"}'));

    const bodyA = await cachedGet(
      { db, provider: 'provider-a', fetchImpl: fetchA, clock: () => clock },
      'https://example.invalid/shared',
      { endpointClass: 'details' }
    );
    const bodyB = await cachedGet(
      { db, provider: 'provider-b', fetchImpl: fetchB, clock: () => clock },
      'https://example.invalid/shared',
      { endpointClass: 'details' }
    );

    expect(bodyA).toBe('{"provider":"a"}');
    expect(bodyB).toBe('{"provider":"b"}');
  });

  it('includes only cacheKeyHeaderNames-listed headers in the cache key (a rotating auth header does not bust the cache)', async () => {
    let clock = 5_000_000;
    const fetchImpl = vi.fn(async () => fakeResponse('{"ok":true}'));
    const deps = { db, provider: 'test-provider-4', fetchImpl, clock: () => clock };

    await cachedGet(deps, 'https://example.invalid/d', {
      endpointClass: 'details',
      headers: { Authorization: 'Bearer token-1', 'Accept-Language': 'en' },
      cacheKeyHeaderNames: ['Accept-Language'],
    });
    // Same Accept-Language, different (rotated) bearer token — should still
    // be a cache hit.
    await cachedGet(deps, 'https://example.invalid/d', {
      endpointClass: 'details',
      headers: { Authorization: 'Bearer token-2', 'Accept-Language': 'en' },
      cacheKeyHeaderNames: ['Accept-Language'],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a differing cache-key header value is a cache miss', async () => {
    let clock = 6_000_000;
    const fetchImpl = vi.fn(async () => fakeResponse('{"ok":true}'));
    const deps = { db, provider: 'test-provider-5', fetchImpl, clock: () => clock };

    await cachedGet(deps, 'https://example.invalid/e', {
      endpointClass: 'details',
      headers: { 'Accept-Language': 'en' },
      cacheKeyHeaderNames: ['Accept-Language'],
    });
    await cachedGet(deps, 'https://example.invalid/e', {
      endpointClass: 'details',
      headers: { 'Accept-Language': 'fr' },
      cacheKeyHeaderNames: ['Accept-Language'],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws ProviderFetchError and does not cache a non-2xx response', async () => {
    let clock = 7_000_000;
    const fetchImpl = vi.fn(async () => fakeResponse('not found', false, 404));
    const deps = { db, provider: 'test-provider-6', fetchImpl, clock: () => clock };

    await expect(cachedGet(deps, 'https://example.invalid/missing', { endpointClass: 'details' })).rejects.toThrow(
      ProviderFetchError
    );
    // A retry still calls fetchImpl (nothing was cached from the failure).
    await expect(cachedGet(deps, 'https://example.invalid/missing', { endpointClass: 'details' })).rejects.toThrow(
      ProviderFetchError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
