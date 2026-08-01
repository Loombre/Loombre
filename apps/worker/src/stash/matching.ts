// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/matching.ts
//
// STATE.md S4's matching algorithm. `matchStashScenes` is the PURE
// decision core (no I/O, no DB) — deliberately mirrors
// packages/playback-engine's "clock is an argument" purity discipline so
// the tier-selection logic (path first, oshash fallback, unmatched stays
// visible) is unit-testable with zero setup. The two real-world
// complications S4 calls out both live OUTSIDE this function, by design:
//
//   - "compute oshash on Loombre's side LAZILY only for unmatched
//     candidates" is a caller responsibility: `LoombreFileCandidate.oshash`
//     is whatever the caller has ALREADY computed and handed in — this
//     module never opens a file. The intended two-pass caller shape is:
//     (1) call this function with every candidate's oshash left `null`
//     to resolve every PATH-tier match for free; (2) for scenes that are
//     still unmatched AND carry a stashOshash, find same-size Loombre
//     candidates and lazily compute oshash.ts's computeOshashForFile
//     ONLY for those; (3) call this function again with the now-populated
//     oshash values to resolve the OSHASH tier. Lane C's sync engine owns
//     wiring that loop against real DB candidate queries + real files.
//   - "unmatched Loombre files land visibly" (the other half of S4) is a
//     plain set-difference the caller can compute directly from this
//     function's output (every `mediaFileId` this function claims minus
//     the full candidate list — see matching.spec.ts's own test for the
//     one-liner) — there's nothing this module needs to do differently to
//     support it, so it isn't a separate exported function.

import { rewriteStashPath, type StashPathMapping } from '@loombre/shared/stash-path-mapping';

export interface StashSceneMatchInput {
  stashSceneId: string;
  stashPath: string;
  stashSizeBytes: number | null;
  stashOshash: string | null;
}

export interface LoombreFileCandidate {
  mediaFileId: string;
  itemId: string;
  path: string;
  sizeBytes: number | null;
  /** Lazily computed by the caller (see this file's header) — null means
   *  "not computed [yet]", not "known to have no hash". */
  oshash: string | null;
}

export interface StashSceneMatchResult {
  stashSceneId: string;
  itemId: string | null;
  mediaFileId: string | null;
  matchedBy: 'path' | 'oshash' | null;
}

export function matchStashScenes(
  scenes: readonly StashSceneMatchInput[],
  mappings: readonly StashPathMapping[],
  candidates: readonly LoombreFileCandidate[]
): StashSceneMatchResult[] {
  const byPath = new Map<string, LoombreFileCandidate>();
  const bySize = new Map<number, LoombreFileCandidate[]>();
  for (const candidate of candidates) {
    byPath.set(candidate.path, candidate);
    if (candidate.sizeBytes != null) {
      const bucket = bySize.get(candidate.sizeBytes);
      if (bucket) bucket.push(candidate);
      else bySize.set(candidate.sizeBytes, [candidate]);
    }
  }

  return scenes.map((scene) => {
    // Tier 1: path-mapped exact match (primary, S4).
    const rewritten = rewriteStashPath(scene.stashPath, mappings);
    if (rewritten) {
      const match = byPath.get(rewritten);
      if (match) {
        return { stashSceneId: scene.stashSceneId, itemId: match.itemId, mediaFileId: match.mediaFileId, matchedBy: 'path' as const };
      }
    }

    // Tier 2: size + oshash fallback (secondary, S4) — only considered
    // when the scene actually carries both facts to compare against.
    if (scene.stashOshash != null && scene.stashSizeBytes != null) {
      const sizeMatches = bySize.get(scene.stashSizeBytes) ?? [];
      const match = sizeMatches.find((c) => c.oshash != null && c.oshash === scene.stashOshash);
      if (match) {
        return { stashSceneId: scene.stashSceneId, itemId: match.itemId, mediaFileId: match.mediaFileId, matchedBy: 'oshash' as const };
      }
    }

    // Unmatched — visible by construction (S4), never dropped from the
    // result set.
    return { stashSceneId: scene.stashSceneId, itemId: null, mediaFileId: null, matchedBy: null };
  });
}
