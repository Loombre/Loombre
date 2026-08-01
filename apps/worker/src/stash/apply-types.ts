// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/apply-types.ts
//
// Lane C's OWN narrow interface for Lane B's apply.ts (K11, STATE.md
// Stash SQLite metadata sync mission: "B owns apps/worker/src/stash/
// apply.ts exporting applyStashSceneMetadata(trx, deps, input) [name
// frozen now]; C consumes it via injected dependency and may stub until
// integration"). apply.ts does not exist in this worktree (Lane B ships
// it in a parallel worktree) — nothing in this lane imports it. sync-
// consumer.ts takes an `ApplyStashSceneMetadataFn` as an injected
// constructor dependency; apps/worker/src/index.ts wires
// createStubApplyStashSceneMetadata() below for now (the "apply STUBBED"
// caveat this lane's report records for the 33k scale proof, deliverable
// 8) — swapping in the real export from apply.ts at integration is a
// one-line change at that single call site.
//
// SIGNATURE FROZEN by the orchestrator's mid-run B/C seam update (post-B
// landing) — this file mirrors it byte-for-byte, not this lane's own
// earlier guess:
//   applyStashSceneMetadata(trx: DbOrTx, deps: ApplyStashSceneMetadataDeps,
//     input: ApplyStashSceneMetadataInput): Promise<{changedFields: string[]}>
//
//   - `trx: DbOrTx` (not a narrower structurally-extracted Transaction
//     type) — apply.ts "opens its own withTransaction (joins an active
//     one) and enqueues image jobs only after commit", so it may be
//     called with a plain db handle OR inside a caller's own transaction,
//     either composes correctly (packages/db/src/internal/tx.ts's
//     withTransaction: `if (db.isTransaction) return fn(db)` — no nested
//     transaction opened). sync-consumer.ts still wraps each scene's
//     apply call in its OWN withTransaction (per-scene atomicity, mirrors
//     apps/worker/src/metadata/consumer.ts's per-item convention) — that
//     composes with apply.ts's own join-if-already-a-transaction behavior
//     for free.
//   - `deps: {getBlob, enqueueImageJob, clock?}` — getBlob is Lane B's own
//     addition (cover/avatar/studio/tag image bytes, read-model.ts's
//     getBlob bound to the CURRENTLY-OPEN Stash connection by
//     sync-consumer.ts's applyOneScene, since apply.ts itself never opens
//     a Stash connection).
//   - `input`: StashSceneBundle ({scene, files (primary-first, read-model's
//     own getSceneFiles ordering), performers, studioChain, tags, markers})
//     & {libraryId, itemId, stashSceneId, genreTagNames}. `studioChain` is
//     the RESOLVED studio ancestor chain ([0] = the scene's own studio,
//     [1] = its parent, ...), walked via read-model.getStudio's parentId —
//     sync-consumer.ts's resolveStudioChain does this walk BEFORE calling
//     apply (apply.ts itself never touches the open Stash connection).
//   - Result `{changedFields: string[]}` (not a bare boolean) — this
//     lane's updated/skipped count law reads `changedFields.length > 0`.

import type { JobPayloads } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import type {
  StashScene,
  StashSceneFile,
  StashPerformer,
  StashStudio,
  StashTag,
  StashSceneMarker,
  StashBlob,
} from './read-model.js';

export interface ApplyStashSceneMetadataDeps {
  /** Bound to the currently-open Stash connection by sync-consumer.ts's
   *  applyOneScene (read-model.ts's getBlob, curried) — apply.ts never
   *  opens a Stash connection itself. */
  getBlob: (checksum: string) => StashBlob | null;
  enqueueImageJob: (payload: JobPayloads['image']) => Promise<unknown>;
  /** Defaults to Date.now — injectable for deterministic tests. */
  clock?: () => number;
}

export interface StashSceneBundle {
  scene: StashScene;
  /** Primary-first (read-model.ts's own getSceneFiles ordering). */
  files: StashSceneFile[];
  performers: StashPerformer[];
  /** Resolved studio ancestor chain: [0] = the scene's own studio (or
   *  absent — empty array — when scene.studioId is null), [1] = its
   *  parent, and so on, walked via read-model.getStudio's parentId. */
  studioChain: StashStudio[];
  tags: StashTag[];
  markers: StashSceneMarker[];
}

export type ApplyStashSceneMetadataInput = StashSceneBundle & {
  libraryId: string;
  /** The ALREADY-matched Loombre catalog item (S4 matching has already
   *  run by the time apply is called — apply.ts maps/writes, it never
   *  matches). */
  itemId: string;
  stashSceneId: string;
  /** K15: NULL = B's documented genre-tag-name heuristic; an explicit
   *  array replaces it wholesale. Mirrors
   *  library_stash_connections.genre_tag_names verbatim. */
  genreTagNames: string[] | null;
};

export interface ApplyStashSceneMetadataResult {
  /** Field names apply actually wrote (S5's metadata_lock/precedence
   *  engine may no-op a field-locked item, or a re-applied scene whose
   *  mapped fields are byte-identical to what's already stored) — EMPTY
   *  means no-op. sync-consumer.ts uses `changedFields.length > 0` to
   *  pick updatedCount vs skippedCount (S8's five-bucket
   *  "no-silent-anything" count law). */
  changedFields: string[];
}

/** The exact shape Lane B's apply.ts exports as `applyStashSceneMetadata`
 *  (name + signature frozen). */
export type ApplyStashSceneMetadataFn = (
  trx: DbOrTx,
  deps: ApplyStashSceneMetadataDeps,
  input: ApplyStashSceneMetadataInput
) => Promise<ApplyStashSceneMetadataResult>;

/**
 * Honest no-op stand-in for Lane B's real apply — writes NOTHING (a stub
 * that fabricated a non-empty changedFields would make updatedCount lie
 * about work that never happened). Used as apps/worker/src/index.ts's
 * production wiring until Lane B's apply.ts lands (deliverable 8's "apply
 * STUBBED" scale-proof caveat) and as the default test double in this
 * lane's own unit tests — tests that need to observe a "changed" branch
 * inject their own fake returning `{ changedFields: [...] }` instead.
 */
export function createStubApplyStashSceneMetadata(): ApplyStashSceneMetadataFn {
  return async () => ({ changedFields: [] });
}
