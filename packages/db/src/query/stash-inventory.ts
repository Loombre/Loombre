// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/stash-inventory.ts
//
// Writers/readers for migrations/0018_stash_provider_core.sql's
// stash_scene_links table (STATE.md S4/K10), plus computePathMappingMatchPreview
// — the K10 admin "N of M matched" preview, kept "pure SQL over stored
// Stash paths x candidate mappings x media_files.path" in the sense that
// runs entirely against Postgres (the server NEVER opens the Stash SQLite
// file, K10) while doing the actual path REWRITE step through
// packages/shared's canonical `rewriteStashPath` in application code
// rather than reimplementing the longest-prefix-wins/trailing-slash/case
// rules as a second, SQL-string-function version of the same algorithm —
// a duplicate implementation is exactly the kind of drift class this
// avoids by construction (the preview and the real matcher,
// apps/worker/src/stash/matching.ts, both call the SAME function).
//
// Lives in the PUBLIC barrel (src/index.ts), not src/internal/, and takes
// NO ViewerContext — same justification as stash-connections.ts's header:
// apps/worker (writing inventory/match results) and a future apps/server
// admin surface (reading the preview) are both fenced off from
// @loombre/db/internal by dependency-cruiser, and this data is admin
// operational/diagnostic bookkeeping, not a viewer-scoped catalog browse
// surface (mirrors src/internal/jobs.ts's "writes are not viewer-scoped"
// reasoning, extended here to an admin-only READ too). The HTTP layer
// (Lane D) is responsible for gating this behind an admin-only route.

import type { Kysely, Selectable } from 'kysely';
import type { DB, StashSceneLinksTable } from '../types.js';
import { canonicalizePathForMatch, rewriteStashPath, type StashPathMapping } from '@loombre/shared/stash-path-mapping';
import { getLibraryPathMappings } from './stash-connections.js';

export type StashSceneLinkRow = Selectable<StashSceneLinksTable>;

// ============================================================================
// inventory writer (K10 — populated by the worker's Stash adapter/
// read-model, never by a live server-side SQLite read)
// ============================================================================

export interface UpsertStashInventorySceneInput {
  stashSceneId: string;
  /** The scene's raw (unmapped) Stash-reported path. Empty string for the
   *  rare Stash scene that has NO linked file at all (an orphaned/broken
   *  Stash-side state, not something to skip — the row must still exist
   *  so the scene is visible, S4) — column is NOT NULL (migration), and
   *  an empty string can never collide with a real rewritten path (S4's
   *  matcher never treats "" as a match). */
  stashPath: string;
  stashSizeBytes: number | null;
  stashOshash: string | null;
  stashUpdatedAtMs: number | null;
}

/**
 * Bulk-upserts raw Stash facts (path/size/oshash/updated_at) for every
 * scene the inventory pass saw — NEVER touches `item_id`/`matched_by`
 * (that is applyStashSceneMatchResults's job, run as a separate pass), so
 * re-running inventory never clobbers an existing match. Unconditionally
 * clears `stale` back to FALSE: seeing a scene again in a fresh inventory
 * is itself proof it has not been deleted from Stash (S8's staleness
 * semantics — Lane C's sync engine — build on top of this, not the other
 * way around).
 */
export async function upsertStashSceneLinksFromInventory(
  db: Kysely<DB>,
  libraryId: string,
  scenes: readonly UpsertStashInventorySceneInput[],
  nowMs: number
): Promise<void> {
  for (const scene of scenes) {
    await db
      .insertInto('stash_scene_links')
      .values({
        library_id: libraryId,
        stash_scene_id: scene.stashSceneId,
        stash_path: scene.stashPath,
        stash_oshash: scene.stashOshash,
        stash_size_bytes: scene.stashSizeBytes,
        stash_updated_at_ms: scene.stashUpdatedAtMs,
        stale: false,
        last_synced_at_ms: nowMs,
      })
      .onConflict((oc) =>
        oc.columns(['library_id', 'stash_scene_id']).doUpdateSet({
          stash_path: (eb) => eb.ref('excluded.stash_path'),
          stash_oshash: (eb) => eb.ref('excluded.stash_oshash'),
          stash_size_bytes: (eb) => eb.ref('excluded.stash_size_bytes'),
          stash_updated_at_ms: (eb) => eb.ref('excluded.stash_updated_at_ms'),
          stale: (eb) => eb.ref('excluded.stale'),
          last_synced_at_ms: (eb) => eb.ref('excluded.last_synced_at_ms'),
        })
      )
      .execute();
  }
}

export async function listStashSceneLinksForLibrary(db: Kysely<DB>, libraryId: string): Promise<StashSceneLinkRow[]> {
  return db.selectFrom('stash_scene_links').selectAll().where('library_id', '=', libraryId).orderBy('stash_scene_id', 'asc').execute();
}

// ============================================================================
// match-result writer (S4 — the actual matching decision, computed by
// apps/worker/src/stash/matching.ts's matchStashScenes against candidates
// this module's listCandidateMediaFilesForLibrary supplies)
// ============================================================================

export interface StashSceneMatchResultInput {
  stashSceneId: string;
  itemId: string | null;
  matchedBy: 'path' | 'oshash' | null;
}

export async function applyStashSceneMatchResults(
  db: Kysely<DB>,
  libraryId: string,
  results: readonly StashSceneMatchResultInput[],
  nowMs: number
): Promise<void> {
  for (const result of results) {
    await db
      .updateTable('stash_scene_links')
      .set({ item_id: result.itemId, matched_by: result.matchedBy, last_synced_at_ms: nowMs })
      .where('library_id', '=', libraryId)
      .where('stash_scene_id', '=', result.stashSceneId)
      .execute();
  }
}

export interface CandidateMediaFile {
  mediaFileId: string;
  itemId: string;
  path: string;
  sizeBytes: number | null;
}

/** Every media_files row belonging to `libraryId` (via catalog_items),
 *  shaped as S4 matching candidates — the caller (a matching-pass
 *  orchestrator) lazily attaches a computed oshash per
 *  apps/worker/src/stash/matching.ts's own header before calling
 *  matchStashScenes with these. */
export async function listCandidateMediaFilesForLibrary(db: Kysely<DB>, libraryId: string): Promise<CandidateMediaFile[]> {
  const rows = await db
    .selectFrom('media_files')
    .innerJoin('catalog_items', 'catalog_items.id', 'media_files.item_id')
    .select(['media_files.id as media_file_id', 'catalog_items.id as item_id', 'media_files.path as path', 'media_files.size_bytes as size_bytes'])
    .where('catalog_items.library_id', '=', libraryId)
    .execute();
  return rows.map((r) => ({ mediaFileId: r.media_file_id, itemId: r.item_id, path: r.path, sizeBytes: r.size_bytes }));
}

// ============================================================================
// computePathMappingMatchPreview (K10)
// ============================================================================

export interface PathMappingPreviewUnmatchedScene {
  stashSceneId: string;
  stashPath: string;
  /** null when NO configured mapping's prefix matches this scene's raw
   *  Stash path at all (a path-mapping configuration gap, distinct from
   *  "mapped correctly but no such Loombre file exists yet"). */
  rewrittenPath: string | null;
}

export interface PathMappingMatchPreview {
  totalStashScenes: number;
  /** Scenes whose rewritten Stash path currently matches an existing
   *  media_files.path in this library. Reflects the LAST inventory/sync
   *  snapshot's stash_path values against the CURRENT path-mapping
   *  configuration — editing a mapping changes this preview immediately,
   *  without needing a fresh inventory pass (K10). */
  candidateMatchCount: number;
  unmatchedCount: number;
  /** Capped list for admin display (mirrors scan.completed's own
   *  "count authoritative, list capped" convention) — `unmatchedCount`
   *  above is always the true total, regardless of this cap. */
  unmatchedScenes: PathMappingPreviewUnmatchedScene[];
}

const UNMATCHED_SCENES_PREVIEW_CAP = 200;

/**
 * `mappingsOverride` (STATE.md Stash run, Lane D's admin surface —
 * POST /admin/libraries/{id}/stash-path-mappings/preview): when supplied,
 * the preview reflects THESE candidate (not-yet-saved) mappings instead of
 * the library's currently-stored `library_path_mappings` rows — an admin
 * drafting a new mapping set can see its match counts before committing it
 * via PUT. Omitted (the original, still-tested behavior): the currently
 * saved mappings, unchanged. Either way this stays "pure SQL over the last
 * inventory/sync snapshot's stored Stash paths" (K10) — only WHICH mapping
 * set is applied to those stored paths changes, never where the paths
 * themselves come from.
 */
export async function computePathMappingMatchPreview(
  db: Kysely<DB>,
  libraryId: string,
  mappingsOverride?: readonly StashPathMapping[]
): Promise<PathMappingMatchPreview> {
  const [mappingRows, sceneLinks, candidateFiles] = await Promise.all([
    mappingsOverride === undefined ? getLibraryPathMappings(db, libraryId) : Promise.resolve(undefined),
    listStashSceneLinksForLibrary(db, libraryId),
    listCandidateMediaFilesForLibrary(db, libraryId),
  ]);

  const mappings: StashPathMapping[] =
    mappingsOverride !== undefined
      ? [...mappingsOverride]
      : (mappingRows ?? []).map((m) => ({ stashPrefix: m.stash_prefix, loombrePrefix: m.loombre_prefix }));
  // Canonicalize the candidate side so a Windows-native '\'-separated
  // media_files.path still matches rewriteStashPath's always-'/'-separated
  // output (see canonicalizePathForMatch's header) — otherwise a correctly-
  // configured mapping reports zero matches on a Windows Loombre server.
  const candidatePaths = new Set(candidateFiles.map((f) => canonicalizePathForMatch(f.path)));

  let candidateMatchCount = 0;
  const unmatchedScenes: PathMappingPreviewUnmatchedScene[] = [];

  for (const scene of sceneLinks) {
    const rewritten = rewriteStashPath(scene.stash_path, mappings);
    // rewritten is already '/'-normalized; canonicalize the lookup too so
    // both sides meet by construction. The unmatched-scene report below keeps
    // the raw rewrite (rewrittenPath) — that is admin-facing display, not a
    // comparison key.
    const matched = rewritten != null && candidatePaths.has(canonicalizePathForMatch(rewritten));
    if (matched) {
      candidateMatchCount += 1;
    } else if (unmatchedScenes.length < UNMATCHED_SCENES_PREVIEW_CAP) {
      unmatchedScenes.push({ stashSceneId: scene.stash_scene_id, stashPath: scene.stash_path, rewrittenPath: rewritten });
    }
  }

  return {
    totalStashScenes: sceneLinks.length,
    candidateMatchCount,
    unmatchedCount: sceneLinks.length - candidateMatchCount,
    unmatchedScenes,
  };
}
