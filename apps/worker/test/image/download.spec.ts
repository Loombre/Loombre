// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/download.spec.ts

import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { HardenedFetchError } from '@loombre/plugin-host';
import {
  cleanupSource,
  isLocalTempSource,
  isProviderSource,
  isRemoteSource,
  resolveSource,
  stageLocalTempBlob,
  ImageDownloadError,
} from '../../src/image/download.js';

function fakeFetch(body: string, ok = true, status = 200) {
  return async (): Promise<Response> => {
    const stream = Readable.toWeb(Readable.from([Buffer.from(body)])) as unknown as ReadableStream;
    return { ok, status, statusText: ok ? 'OK' : 'Not Found', body: stream } as Response;
  };
}

/** A fetchImpl that records whether/how many times it was called — used to
 *  prove a rejection happened BEFORE any network call, not just that the
 *  call eventually failed. */
function spyFetch(response: () => Response) {
  let calls = 0;
  const fn = async (): Promise<Response> => {
    calls += 1;
    return response();
  };
  return { fn, callCount: () => calls };
}

describe('isRemoteSource', () => {
  it('is true only for url:-prefixed sources', () => {
    expect(isRemoteSource('url:https://example.invalid/a.jpg')).toBe(true);
    expect(isRemoteSource('/local/path/a.jpg')).toBe(false);
    expect(isRemoteSource('C:\\local\\path\\a.jpg')).toBe(false);
  });
});

describe('resolveSource', () => {
  it('returns the path as-is (isTemp:false) for a local path', async () => {
    const resolved = await resolveSource('/some/local/file.jpg');
    expect(resolved).toEqual({ path: '/some/local/file.jpg', isTemp: false });
  });

  it('downloads a url: source to a temp file and marks it isTemp:true', async () => {
    // 93.184.216.34 (this codebase's own convention for "an allowed
    // public IPv4 literal" — packages/plugin-host/test/ssrf.spec.ts) is
    // used here, not a hostname, so this test exercises the fetchImpl
    // override path without depending on real DNS: the guard's IP-literal
    // fast path never calls out to a resolver at all.
    const resolved = await resolveSource('url:https://93.184.216.34/poster.jpg', fakeFetch('fake-image-bytes'));
    expect(resolved.isTemp).toBe(true);

    const contents = await readFile(resolved.path, 'utf8');
    expect(contents).toBe('fake-image-bytes');

    await cleanupSource(resolved);
    await expect(stat(resolved.path)).rejects.toThrow();
  });

  it('throws ImageDownloadError for a non-2xx response', async () => {
    await expect(resolveSource('url:https://93.184.216.34/missing.jpg', fakeFetch('', false, 404))).rejects.toThrow(ImageDownloadError);
  });

  it('cleanupSource is a no-op for a non-temp (local) source', async () => {
    const resolved = { path: '/some/local/file.jpg', isTemp: false } as const;
    await expect(cleanupSource(resolved)).resolves.toBeUndefined();
  });
});

// AUD-A7c-001: a plugin-supplied metadata-provider image URL is untrusted
// input (metadata/consumer.ts forwards `image.url` verbatim from the
// provider's response, LPP providers included), so resolveSource must
// route every `url:` fetch through @loombre/plugin-host's SSRF guard —
// the SAME guard every other outbound plugin call already uses, never a
// second one — refusing loopback/private/link-local targets and never
// auto-following a redirect off an initially-allowed host.
describe('resolveSource routes url: fetches through the SSRF guard (AUD-A7c-001)', () => {
  it.each([
    ['http://127.0.0.1:9999/x.jpg', 'loopback'],
    ['http://10.0.0.5/x.jpg', 'private 10/8'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local / cloud metadata endpoint'],
  ])('refuses a %s target (%s) before any network call', async (target) => {
    const spy = spyFetch(() => {
      throw new Error('fetchImpl must never be invoked for a disallowed target');
    });

    await expect(resolveSource(`url:${target}`, spy.fn)).rejects.toMatchObject({
      reason: 'disallowed-address',
    });
    expect(spy.callCount()).toBe(0);
  });

  it('rejects with the guard-typed HardenedFetchError, not a generic Error', async () => {
    const spy = spyFetch(() => {
      throw new Error('must not be called');
    });
    await expect(resolveSource('url:http://127.0.0.1/x.jpg', spy.fn)).rejects.toBeInstanceOf(HardenedFetchError);
  });

  it('does not follow a redirect off an initially-allowed host to a private target', async () => {
    // 93.184.216.34 is a real, publicly-routable IPv4 literal (this
    // codebase's own convention for "an allowed test address" —
    // packages/plugin-host/test/ssrf.spec.ts) — the guard lets the INITIAL
    // request through; the point of this test is that the 302 response is
    // never chased to wherever `Location` points.
    const spy = spyFetch(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }));

    await expect(resolveSource('url:http://93.184.216.34/poster.jpg', spy.fn)).rejects.toMatchObject({
      reason: 'redirect-not-followed',
    });
    // Exactly one call: the guard surfaces the 3xx as a typed rejection
    // instead of dialing the Location target — proving no auto-follow.
    expect(spy.callCount()).toBe(1);
  });
});

// Stash mission (STATE.md S5/K11): apps/worker/src/stash/apply.ts stages
// Stash blob bytes (read via read-model.ts's getBlob — Stash never hands
// back a fetchable URL) to a local temp file and must pass a sourcePath
// the pipeline both reads AND cleans up afterward, unlike a bare local
// path (scanner-owned local art, never deleted).
describe('local-temp: sources (Stash blob staging)', () => {
  it('isLocalTempSource is true only for local-temp:-prefixed sources', () => {
    expect(isLocalTempSource('local-temp:/tmp/x/blob')).toBe(true);
    expect(isLocalTempSource('/local/path/a.jpg')).toBe(false);
    expect(isLocalTempSource('url:https://example.invalid/a.jpg')).toBe(false);
  });

  it('isProviderSource is true for both url: and local-temp: sources, false for a bare local path', () => {
    expect(isProviderSource('url:https://example.invalid/a.jpg')).toBe(true);
    expect(isProviderSource('local-temp:/tmp/x/blob')).toBe(true);
    expect(isProviderSource('/local/path/a.jpg')).toBe(false);
  });

  it('stageLocalTempBlob writes bytes to a fresh temp file and returns a local-temp:-prefixed path', async () => {
    const sourcePath = await stageLocalTempBlob(Buffer.from('stash-blob-bytes'), 'checksum-abc');
    expect(isLocalTempSource(sourcePath)).toBe(true);

    const resolved = await resolveSource(sourcePath);
    expect(resolved.isTemp).toBe(true);
    const contents = await readFile(resolved.path, 'utf8');
    expect(contents).toBe('stash-blob-bytes');

    await cleanupSource(resolved);
    await expect(stat(resolved.path)).rejects.toThrow();
  });

  it('resolveSource marks a local-temp: source isTemp:true so cleanupSource deletes it', async () => {
    const sourcePath = await stageLocalTempBlob(Buffer.from('bytes'), 'hint');
    const resolved = await resolveSource(sourcePath);
    expect(resolved.isTemp).toBe(true);
  });

  it('two stageLocalTempBlob calls get independent temp dirs — cleaning up one never deletes the other', async () => {
    const a = await stageLocalTempBlob(Buffer.from('a-bytes'), 'a');
    const b = await stageLocalTempBlob(Buffer.from('b-bytes'), 'b');

    const resolvedA = await resolveSource(a);
    const resolvedB = await resolveSource(b);
    await cleanupSource(resolvedA);

    // b's file must still be readable — proves the two staged blobs did
    // not share a parent temp directory (cleanupSource deletes the whole
    // parent dir of whatever it's given).
    const contents = await readFile(resolvedB.path, 'utf8');
    expect(contents).toBe('b-bytes');
    await cleanupSource(resolvedB);
  });
});
