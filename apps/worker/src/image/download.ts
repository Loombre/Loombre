// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/download.ts
//
// Resolves an image job's `sourcePath` (P1.8) to a local file:
//   - `url:<http(s) url>` — downloaded via `fetchImpl` (real `fetch` by
//     default, injectable for tests) streamed straight to a temp file, no
//     whole-body buffering (docs/PLAN.md §9.2 "streams everywhere").
//   - anything else — treated as an already-local filesystem path, used
//     as-is (no copy).
//
// This module does NOT go through the metadata provider_cache
// (@loombre/db's provider_cache table is TEXT-bodied, sized for JSON API
// responses, not binary image bytes — CLAUDE.md invariant 3's JSONB
// whitelist reasoning applies by extension). A re-run simply re-downloads;
// idempotent since the pipeline overwrites the same output files either way.

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashString } from './variant-job.js';

const URL_PREFIX = 'url:';

export type FetchLike = (url: string) => Promise<Response>;

export interface ResolvedSource {
  /** Local filesystem path the pipeline should read from. */
  path: string;
  /** True if `path` is a temp file this module created and the caller
   *  should delete once done with it (cleanupSource does this). */
  isTemp: boolean;
}

export function isRemoteSource(sourcePath: string): boolean {
  return sourcePath.startsWith(URL_PREFIX);
}

export class ImageDownloadError extends Error {
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number, statusText: string) {
    super(`image download failed: ${status} ${statusText} (${url})`);
    this.name = 'ImageDownloadError';
    this.url = url;
    this.status = status;
  }
}

/** Resolves `sourcePath` to a local file, downloading it first if it's a
 *  `url:`-prefixed remote source. Callers MUST call cleanupSource() when
 *  done (a no-op for local, non-temp sources). */
export async function resolveSource(sourcePath: string, fetchImpl: FetchLike = fetch): Promise<ResolvedSource> {
  if (!isRemoteSource(sourcePath)) {
    return { path: sourcePath, isTemp: false };
  }

  const url = sourcePath.slice(URL_PREFIX.length);
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) {
    throw new ImageDownloadError(url, res.status, res.statusText);
  }

  const dir = await mkdtemp(join(tmpdir(), 'loombre-image-'));
  const filePath = join(dir, hashString(url));

  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(filePath));

  return { path: filePath, isTemp: true };
}

export async function cleanupSource(resolved: ResolvedSource): Promise<void> {
  if (!resolved.isTemp) return;
  await rm(join(resolved.path, '..'), { recursive: true, force: true });
}
