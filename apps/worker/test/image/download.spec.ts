// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/download.spec.ts

import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
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
    const resolved = await resolveSource('url:https://example.invalid/poster.jpg', fakeFetch('fake-image-bytes'));
    expect(resolved.isTemp).toBe(true);

    const contents = await readFile(resolved.path, 'utf8');
    expect(contents).toBe('fake-image-bytes');

    await cleanupSource(resolved);
    await expect(stat(resolved.path)).rejects.toThrow();
  });

  it('throws ImageDownloadError for a non-2xx response', async () => {
    await expect(resolveSource('url:https://example.invalid/missing.jpg', fakeFetch('', false, 404))).rejects.toThrow(ImageDownloadError);
  });

  it('cleanupSource is a no-op for a non-temp (local) source', async () => {
    const resolved = { path: '/some/local/file.jpg', isTemp: false } as const;
    await expect(cleanupSource(resolved)).resolves.toBeUndefined();
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
