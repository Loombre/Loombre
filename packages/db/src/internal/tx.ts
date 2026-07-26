// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/tx.ts
//
// Transaction-composition helper shared by every writer in this module.
// Every helper accepts `db: Kysely<DB> | Transaction<DB>` (P1.13) so a
// caller composing several writes into one atomic unit can open a
// transaction once and pass its handle through; a caller with no
// transaction of its own gets one opened for it transparently.

import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../types.js';

export type DbOrTx = Kysely<DB> | Transaction<DB>;

/**
 * Runs `fn` inside a transaction. If `db` is already a `Transaction` handle
 * (Kysely instances expose `.isTransaction`), `fn` runs directly against it
 * — no nested transaction is opened, so composed writers share one atomic
 * unit with whatever transaction the caller already started. Otherwise a
 * fresh transaction is opened and committed/rolled back around `fn`.
 */
export async function withTransaction<T>(
  db: DbOrTx,
  fn: (trx: Transaction<DB>) => Promise<T>
): Promise<T> {
  if (db.isTransaction) {
    return fn(db as Transaction<DB>);
  }
  return (db as Kysely<DB>).transaction().execute(fn);
}
