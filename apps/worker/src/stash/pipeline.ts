// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/pipeline.ts
//
// Shared inventory + matching pass orchestration (STATE.md S4/K10, Lane C
// sync engine) used by BOTH the 'stash-inventory' job consumer
// (inventory-consumer.ts, bounded: adapter -> read-model -> upsert links,
// nothing else) and 'stash-sync's inventory/match phases
// (sync-consumer.ts) — one implementation so the two job types can never
// drift on what "run inventory" or "run matching" means. Neither function
// here touches pg-boss/jobs — pure DB+Stash orchestration, unit-testable
// without a real queue (test/stash/pipeline.spec.ts, which counts real
// file reads to hold runMatchingPass to S4's lazy-oshash bound).

import type { DbOrTx } from '@loombre/db/internal';
import {
  applyStashSceneMatchResults,
  getLibraryPathMappings,
  listCandidateMediaFilesForLibrary,
  upsertStashSceneLinksFromInventory,
} from '@loombre/db';
import { listScenesForInventory, type SqliteReadable, type StashInventoryScene } from './read-model.js';
import { matchStashScenes, type LoombreFileCandidate, type StashSceneMatchInput, type StashSceneMatchResult } from './matching.js';
import { computeOshashForFile } from './oshash.js';

export interface RunInventoryPassResult {
  scenes: StashInventoryScene[];
}

/** The 'stash-inventory' job's entire job, and stash-sync full mode's
 *  phase 1 (K10): reads every scene's primary-file identity facts off the
 *  OPEN Stash connection and bulk-upserts them into stash_scene_links —
 *  bounded (one SELECT + a batched upsert), never touches item_id/
 *  matched_by (S4's separate matching pass owns that). */
export async function runInventoryPass(db: DbOrTx, stashDb: SqliteReadable, libraryId: string, nowMs: number): Promise<RunInventoryPassResult> {
  const scenes = listScenesForInventory(stashDb);
  await upsertStashSceneLinksFromInventory(
    db,
    libraryId,
    scenes.map((s) => ({
      stashSceneId: s.stashSceneId,
      stashPath: s.path ?? '',
      stashSizeBytes: s.sizeBytes,
      stashOshash: s.oshash,
      stashUpdatedAtMs: s.updatedAtMs,
    })),
    nowMs
  );
  return { scenes };
}

/** Incremental variant of runInventoryPass: upserts ONLY the given subset
 *  of scenes (S8: "touch ONLY changed/new/vanished") — same upsert call,
 *  just not fed the full inventory. Kept as a separate export (rather
 *  than an optional-subset parameter on runInventoryPass) so it is
 *  obvious at each call site which mode is in play. */
export async function upsertInventorySubset(db: DbOrTx, libraryId: string, scenes: readonly StashInventoryScene[], nowMs: number): Promise<void> {
  if (scenes.length === 0) return;
  await upsertStashSceneLinksFromInventory(
    db,
    libraryId,
    scenes.map((s) => ({
      stashSceneId: s.stashSceneId,
      stashPath: s.path ?? '',
      stashSizeBytes: s.sizeBytes,
      stashOshash: s.oshash,
      stashUpdatedAtMs: s.updatedAtMs,
    })),
    nowMs
  );
}

export interface RunMatchingPassResult {
  results: StashSceneMatchResult[];
}

/**
 * S4's two-pass lazy-oshash matching loop (matching.ts's own header:
 * "Lane C's sync engine owns wiring that loop against real DB candidate
 * queries + real files"), persisted via applyStashSceneMatchResults.
 * `scenes` is normally the FULL inventory set (full sync) or just the
 * touched subset (incremental sync).
 *
 * Pass 1 resolves every path-tier match for free (no I/O). Pass 2 lazily
 * computes Loombre-side oshash ONLY for candidates that are BOTH (a) not
 * already claimed by a pass-1 path match and (b) the same size as a
 * still-unmatched scene's oshash target — bounded far below the full
 * candidate list at scale, matching S4's explicit "lazily... only for
 * unmatched candidates" requirement.
 *
 * Condition (a) is load-bearing in both directions, and was missing until
 * the R2 audit (test/stash/pipeline.spec.ts's "an ALREADY PATH-MATCHED
 * candidate is never hashed" case is its fail-first pin):
 *   - PERFORMANCE, which is what S4's wording is about: without it, every
 *     path-matched file whose byte count happens to collide with an
 *     unmatched scene's gets opened and hashed for nothing. At the owner's
 *     33k scale a common encode size makes that collision the rule, not
 *     the exception.
 *   - CORRECTNESS, as a free consequence: a candidate already claimed by
 *     one scene's path match can no longer be handed to a DIFFERENT scene
 *     by the oshash tier, so two Stash scenes can never silently link to
 *     the same Loombre item (which would leave both scenes applying
 *     conflicting metadata to it, last writer winning). The second scene
 *     instead stays unmatched — VISIBLE in the sync report's unmatched
 *     list, which is exactly where S4/H3 want a situation a human needs
 *     to look at.
 */
export async function runMatchingPass(db: DbOrTx, libraryId: string, scenes: readonly StashSceneMatchInput[], nowMs: number): Promise<RunMatchingPassResult> {
  if (scenes.length === 0) return { results: [] };

  const [mappingRows, candidateRows] = await Promise.all([
    getLibraryPathMappings(db, libraryId),
    listCandidateMediaFilesForLibrary(db, libraryId),
  ]);
  const mappings = mappingRows.map((m) => ({ stashPrefix: m.stash_prefix, loombrePrefix: m.loombre_prefix }));

  const candidatesNoOshash: LoombreFileCandidate[] = candidateRows.map((c) => ({ ...c, oshash: null }));
  const pass1 = matchStashScenes(scenes, mappings, candidatesNoOshash);

  const stillUnmatchedIds = new Set(pass1.filter((r) => r.matchedBy === null).map((r) => r.stashSceneId));
  const targetSizes = new Set(
    scenes
      .filter((s) => stillUnmatchedIds.has(s.stashSceneId) && s.stashOshash != null && s.stashSizeBytes != null)
      .map((s) => s.stashSizeBytes as number)
  );

  if (targetSizes.size === 0) {
    await applyStashSceneMatchResults(db, libraryId, pass1, nowMs);
    return { results: pass1 };
  }

  // S4's "for UNMATCHED candidates only" — a candidate a pass-1 path match
  // already claimed is out of scope for the oshash tier entirely (see this
  // function's doc comment for both halves of why).
  const claimedMediaFileIds = new Set(pass1.map((r) => r.mediaFileId).filter((id): id is string => id != null));

  const candidatesWithOshash: LoombreFileCandidate[] = await Promise.all(
    candidateRows.map(async (c) => ({
      ...c,
      // Never throws the whole pass over one unreadable/missing candidate
      // file (a stale media_files row pointing at a since-deleted file is
      // a real, unremarkable state) — just leaves that one candidate's
      // oshash null, same as "not computed".
      oshash:
        !claimedMediaFileIds.has(c.mediaFileId) && c.sizeBytes != null && targetSizes.has(c.sizeBytes)
          ? await computeOshashForFile(c.path).catch(() => null)
          : null,
    }))
  );
  const pass2 = matchStashScenes(scenes, mappings, candidatesWithOshash);
  await applyStashSceneMatchResults(db, libraryId, pass2, nowMs);
  return { results: pass2 };
}

/** Converts a raw inventory scene row into matching.ts's input shape —
 *  small mapping used at every full/incremental call site so the field
 *  rename (path/oshash naming already matches; stashPath needs the ''
 *  default for a fileless scene) lives in exactly one place. */
export function toMatchInput(scene: StashInventoryScene): StashSceneMatchInput {
  return { stashSceneId: scene.stashSceneId, stashPath: scene.path ?? '', stashSizeBytes: scene.sizeBytes, stashOshash: scene.oshash };
}
