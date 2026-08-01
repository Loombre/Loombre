// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/stash/inventory-consumer.ts
//
// The 'stash-inventory' job consumer (STATE.md K10) —
// `stashInventoryConsumerHandler(deps)` factory, same convention as every
// other consumer in this worker (metadataConsumerHandler, etc.). Deliberately
// bounded and simple: open the Stash connection, run the ONE cheap
// inventory pass (adapter -> read-model.listScenesForInventory -> Lane A's
// upsertStashSceneLinksFromInventory, shared with stash-sync's full-mode
// phase 1 via ./pipeline.ts's runInventoryPass), close, done. No matching,
// no apply, no report row, no events — this job exists purely so
// stash_scene_links stays fresh for the admin path-mapping preview (K10)
// between full syncs, at a cost cheap enough to run on connection save
// without the weight of a real sync.
//
// No checkpointing: packages/jobs/src/types.ts registers 'stash-inventory'
// at BOUNDED_EXPIRE_SECONDS (1h) — a single SELECT-then-upsert pass, even
// at 33k scenes, comfortably finishes well inside that window, so this job
// type has no partial-progress state worth preserving across a crash (a
// retry just re-runs the whole (idempotent) pass from scratch).

import type { JobHandler } from '@loombre/jobs';
import type { DbOrTx } from '@loombre/db/internal';
import { connectToStashLibrary } from './connect.js';
import { runInventoryPass } from './pipeline.js';

export interface StashInventoryConsumerDeps {
  db: DbOrTx;
  /** Defaults to Date.now — injectable for deterministic tests. */
  clock?: () => number;
}

export function stashInventoryConsumerHandler(deps: StashInventoryConsumerDeps): JobHandler<'stash-inventory'> {
  const clock = deps.clock ?? Date.now;

  return async (payload) => {
    const connectResult = await connectToStashLibrary({ db: deps.db, clock }, payload.libraryId);
    if (connectResult.status !== 'ok') {
      const reason = connectResult.status === 'unreachable' ? connectResult.reason : connectResult.notice;
      throw new Error(`stash-inventory: cannot open Stash connection for library ${payload.libraryId} (${connectResult.status}): ${reason}`);
    }

    try {
      await runInventoryPass(deps.db, connectResult.connection.db, payload.libraryId, clock());
    } finally {
      connectResult.connection.close();
    }
  };
}
