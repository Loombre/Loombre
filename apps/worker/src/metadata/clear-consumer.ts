// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/metadata/clear-consumer.ts
//
// The 'metadata-clear' job (owner ruling 2026-09-07: "allow the user to
// clear the metadata on wrong matches via the UI"). Undoes what a provider
// match wrote to an item so the admin can Fix Match it to the right
// candidate — or leave it as the scan saw it:
//   - provider_ids rows (the item is unmatched again, Dashboard-wise),
//   - metadata_provenance rows (the next enrichment merges from scratch),
//   - item_tags / item_people (provider-sourced by construction: the
//     scanner writes neither; an NFO's would be re-read by the next scan),
//   - images with source 'provider' (rows + files; folder art and embedded
//     covers, sources 'local'/'embedded', stay),
//   - the satellite fields a provider fills (overview, tagline, runtime,
//     content rating, series status), set back to null,
//   - title / sort title / year re-derived from the first present file's
//     path with the scanner's own parser (movie/series; artist/album keep
//     the folder-derived title they already carry),
//   - catalog_items.metadata_auto_match = false, so the automatic unmatched
//     sweep leaves the item alone until a forced match sets it true.
// Emits item.updated so open pages refresh. Runs in the worker (invariant
// 6: never inline in the admin request) — the parser and the file unlinks
// both live here.

import { unlink } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { JobHandler } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import {
  deleteImagesForEntity,
  deleteProviderIdsForItem,
  deleteProvenanceForItem,
  getLibraryById,
  listMediaFilesForItem,
  replaceItemPeople,
  replaceItemTags,
  resetCatalogItemIdentity,
  setCatalogItemAutoMatch,
  upsertSatellite,
  withTransaction,
  writeEvent,
} from '@loombre/db/internal';
import { getMetadataSourceItem, type MetadataItemType } from './item-read.js';
import { parseMoviePath } from '../scan/parse/movie.js';
import { parseTvPath } from '../scan/parse/tv.js';

export interface MetadataClearConsumerDeps {
  db: DbOrTx;
  clock?: () => number;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to fs.unlink (best-effort, errors logged). */
  unlinkFile?: (path: string) => Promise<void>;
}

/** The scanner's own posix-relative path for a file under one of the
 *  library's roots, or null when the file sits under none of them. */
function libraryRelativePath(absPath: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const rel = relative(root, absPath);
    if (rel && !rel.startsWith('..') && !rel.startsWith(sep)) return rel.split(sep).join('/');
  }
  return null;
}

/** What the scan would have called this item, from its first present file. */
function scannedIdentity(itemType: MetadataItemType, relPath: string | null): { title: string; year: number | null } | null {
  if (!relPath) return null;
  if (itemType === 'movie') {
    const guess = parseMoviePath(relPath);
    return guess ? { title: guess.title, year: guess.year } : null;
  }
  if (itemType === 'series') {
    const guess = parseTvPath(relPath);
    return guess ? { title: guess.seriesTitle, year: null } : null;
  }
  return null; // artist/album: the folder-derived title on the row is already the scan's
}

export function sortTitleFor(title: string): string {
  const m = /^(the|a|an)\s+(.+)$/i.exec(title.trim());
  return m ? `${m[2]}, ${m[1]}` : title.trim();
}

export async function runMetadataClear(deps: MetadataClearConsumerDeps, itemId: string): Promise<{ cleared: boolean; imagesRemoved: number }> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.clock ?? (() => Date.now());
  const unlinkFile = deps.unlinkFile ?? ((path: string) => unlink(path));

  const item = await getMetadataSourceItem(deps.db, itemId);
  if (!item) return { cleared: false, imagesRemoved: 0 };

  const library = await getLibraryById(deps.db, item.libraryId);
  const files = await listMediaFilesForItem(deps.db, itemId);
  const present = files.find((f) => f.missing_since_ms === null) ?? files[0];
  const identity = scannedIdentity(item.itemType, present && library ? libraryRelativePath(present.path, library.paths) : null);

  const nowMs = now();
  const removedPaths = await withTransaction(deps.db, async (trx) => {
    await deleteProviderIdsForItem(trx, itemId);
    await deleteProvenanceForItem(trx, itemId);
    await replaceItemTags(trx, itemId, []);
    await replaceItemPeople(trx, itemId, []);
    const paths = await deleteImagesForEntity(trx, 'catalog_item', itemId, ['provider']);
    switch (item.itemType) {
      case 'movie':
        await upsertSatellite(trx, { itemType: 'movie', item_id: itemId, overview: null, content_rating: null, tagline: null, runtime_ms: null });
        break;
      case 'series':
        await upsertSatellite(trx, { itemType: 'series', item_id: itemId, overview: null, content_rating: null, status: null });
        break;
      case 'artist':
        await upsertSatellite(trx, { itemType: 'artist', item_id: itemId, overview: null });
        break;
      case 'album':
        break; // album_details carries only the year, which stays with the row
    }
    if (identity) {
      await resetCatalogItemIdentity(trx, { itemId, title: identity.title, sortTitle: sortTitleFor(identity.title), year: identity.year, nowMs });
    } else {
      await resetCatalogItemIdentity(trx, { itemId, title: item.title, sortTitle: item.sortTitle, year: item.year, nowMs });
    }
    await setCatalogItemAutoMatch(trx, itemId, false);
    await writeEvent(trx, {
      type: 'item.updated',
      tsMs: nowMs,
      payload: {
        itemId,
        libraryId: item.libraryId,
        itemType: item.itemType,
        contentClass: item.contentClass,
        changedFields: ['title', 'year', 'overview', 'genres', 'tags', 'people', 'images', 'providerIds'],
        updatedAtMs: nowMs,
      },
    });
    return paths;
  });

  for (const path of removedPaths) {
    try {
      await unlinkFile(path);
    } catch (err) {
      log(`metadata clear: could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`metadata clear: item ${itemId} reset to its scanned identity${identity ? ` ("${identity.title}"${identity.year !== null ? ` ${identity.year}` : ''})` : ''}; ${removedPaths.length} provider image file(s) removed; automatic matching off until Fix Match`);
  return { cleared: true, imagesRemoved: removedPaths.length };
}

export function metadataClearConsumerHandler(deps: MetadataClearConsumerDeps): JobHandler<'metadata-clear'> {
  return async (payload) => {
    await runMetadataClear(deps, payload.itemId);
  };
}
