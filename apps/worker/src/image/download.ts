// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/image/download.ts
//
// Resolves an image job's `sourcePath` (P1.8) to a local file:
//   - `url:<http(s) url>` — downloaded via `fetchImpl` (real `fetch` by
//     default, injectable for tests) streamed straight to a temp file, no
//     whole-body buffering (docs/PLAN.md §9.2 "streams everywhere").
//   - `local-temp:<path>` (Stash mission, STATE.md S5/K11 addition) — a
//     file THIS PROCESS already staged (e.g. apps/worker/src/stash/
//     apply.ts writing Stash blob bytes it read via read-model.ts's
//     getBlob — Stash never hands back a fetchable URL, only in-SQLite
//     bytes) — used as-is, same as a bare local path, but marked
//     `isTemp: true` so cleanupSource deletes it once the pipeline has
//     read it. Distinct from a bare local path specifically so a
//     scanner-owned local-art file (e.g. folder.jpg) is never deleted.
//   - anything else — treated as an already-local, PERMANENT filesystem
//     path (scanner-found local art), used as-is (no copy, never deleted).
//
// This module does NOT go through the metadata provider_cache
// (@loombre/db's provider_cache table is TEXT-bodied, sized for JSON API
// responses, not binary image bytes — CLAUDE.md invariant 3's JSONB
// whitelist reasoning applies by extension). A re-run simply re-downloads;
// idempotent since the pipeline overwrites the same output files either way.

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashString } from './variant-job.js';

const URL_PREFIX = 'url:';
const LOCAL_TEMP_PREFIX = 'local-temp:';

export type FetchLike = (url: string) => Promise<Response>;

export interface ResolvedSource {
  /** Local filesystem path the pipeline should read from. */
  path: string;
  /** True if `path` is a temp file this module created (or was told was
   *  disposable via `local-temp:`) and the caller should delete once done
   *  with it (cleanupSource does this). */
  isTemp: boolean;
}

export function isRemoteSource(sourcePath: string): boolean {
  return sourcePath.startsWith(URL_PREFIX);
}

/** True for a `local-temp:`-prefixed sourcePath — bytes THIS process
 *  staged from a non-URL provider source (Stash's in-SQLite blobs today),
 *  disposable once the pipeline has read them. */
export function isLocalTempSource(sourcePath: string): boolean {
  return sourcePath.startsWith(LOCAL_TEMP_PREFIX);
}

/** True for any source whose BYTES originated from a metadata provider
 *  (a remote `url:` fetch, or a provider's own bytes staged locally via
 *  `local-temp:`) as opposed to a bare filesystem path pointing at
 *  scanner-owned local art. image/consumer.ts's `sourceFor` uses this to
 *  decide the images.source column ('provider' vs 'local'). */
export function isProviderSource(sourcePath: string): boolean {
  return isRemoteSource(sourcePath) || isLocalTempSource(sourcePath);
}

/**
 * Stages `bytes` to a fresh temp file and returns a `local-temp:`-prefixed
 * sourcePath ready to hand to an 'image' job payload — the write-side
 * counterpart of resolveSource's `local-temp:` handling. Each call gets
 * its OWN temp directory (mirrors the `url:` download path below) so
 * cleanupSource's "delete the parent dir" never touches a sibling job's
 * staged file. `filenameHint` only affects the on-disk basename (never
 * read back by the pipeline, which addresses the file by full path).
 */
export async function stageLocalTempBlob(bytes: Buffer, filenameHint: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loombre-stash-blob-'));
  const filePath = join(dir, hashString(filenameHint));
  await writeFile(filePath, bytes);
  return `${LOCAL_TEMP_PREFIX}${filePath}`;
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
  if (isLocalTempSource(sourcePath)) {
    return { path: sourcePath.slice(LOCAL_TEMP_PREFIX.length), isTemp: true };
  }

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
