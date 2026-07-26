// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/import-target-state.ts
//
// Data-freedom import addition (apps/worker/src/import — deliverable E).
// One purpose-built read the import consumer's mode/emptiness decision
// needs and nothing pre-existing provides cheaply: "is this target database
// empty enough to run the ID-preservation restore path" (see the import
// consumer's module header for the exact rule, including the P4.10
// wizard-bootstrap tolerance for a single already-existing admin row).
// EXISTS-style single-row probes for libraries/catalog_items/progress
// (only a boolean is needed, never a count) plus the full username list
// (users is a small, admin-scale table everywhere this matters — the same
// assumption src/internal/jobs.ts's hasQueuedOrActiveJobOfType-style
// existence checks already make for other tables).

import type { DbOrTx } from './tx.js';

export interface ImportTargetState {
  hasLibraries: boolean;
  hasCatalogItems: boolean;
  hasProgress: boolean;
  /** Every current users.username, for the wizard-bootstrap tolerance rule
   *  (see the import consumer's module header). */
  existingUsernames: string[];
}

export async function getImportTargetState(db: DbOrTx): Promise<ImportTargetState> {
  const [libraryRow, itemRow, progressRow, userRows] = await Promise.all([
    db.selectFrom('libraries').select('id').limit(1).executeTakeFirst(),
    db.selectFrom('catalog_items').select('id').limit(1).executeTakeFirst(),
    db.selectFrom('progress').select('user_id').limit(1).executeTakeFirst(),
    db.selectFrom('users').select('username').execute(),
  ]);

  return {
    hasLibraries: libraryRow !== undefined,
    hasCatalogItems: itemRow !== undefined,
    hasProgress: progressRow !== undefined,
    existingUsernames: userRows.map((u) => u.username),
  };
}
