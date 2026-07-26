// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/image/download.spec.ts

import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cleanupSource, isRemoteSource, resolveSource, ImageDownloadError } from '../../src/image/download.js';

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
