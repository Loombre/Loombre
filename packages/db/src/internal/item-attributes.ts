// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/item-attributes.ts
//
// item_attributes writer (migrations/0001_init.sql — the table has existed
// since Phase 1, but no internal writer module for it existed until the
// Stash mission, STATE.md S5/K11: "item_attributes namespace `stash` —
// e.g. stash scene id, stash rating raw"). Mirrors provenance.ts's shape
// exactly (upsert on a unique key, DbOrTx-accepting, Selectable row type).
//
// core code never reads this table (0001_init.sql's own COMMENT ON TABLE)
// — only the namespaced feature that owns a namespace does (here,
// apps/worker/src/stash/apply.ts under namespace 'stash'). This module
// itself is namespace-agnostic (any caller may use any namespace), same as
// person-attributes.ts.

import type { Selectable } from 'kysely';
import type { ItemAttributesTable } from '../types.js';
import type { DbOrTx } from './tx.js';

export type ItemAttributeRow = Selectable<ItemAttributesTable>;

export interface UpsertItemAttributeInput {
  itemId: string;
  namespace: string;
  key: string;
  value: Record<string, unknown>;
}

/** Upsert on (item_id, namespace, key) — the same one-row-per-key sandbox
 *  shape as person-attributes.ts's upsertPersonAttribute. */
export async function upsertItemAttribute(db: DbOrTx, input: UpsertItemAttributeInput): Promise<ItemAttributeRow> {
  return db
    .insertInto('item_attributes')
    .values({ item_id: input.itemId, namespace: input.namespace, key: input.key, value: input.value })
    .onConflict((oc) => oc.columns(['item_id', 'namespace', 'key']).doUpdateSet({ value: (eb) => eb.ref('excluded.value') }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getItemAttributes(db: DbOrTx, itemId: string, namespace: string): Promise<ItemAttributeRow[]> {
  return db.selectFrom('item_attributes').selectAll().where('item_id', '=', itemId).where('namespace', '=', namespace).execute();
}
