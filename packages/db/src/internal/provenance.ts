// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/provenance.ts
//
// metadata_provenance writer/reader (P1.7, migrations/0002_phase1_catalog.sql).
// Lock enforcement (skip a provider/scanner overwrite of a field the user
// has locked) is a caller policy decision, not this module's job: callers
// that care read getProvenanceForItem() first and decide whether to call
// upsertMetadataProvenance() for a given field at all.

import type { Selectable } from 'kysely';
import type { MetadataProvenanceTable } from '../types.js';
import type { DbOrTx } from './tx.js';

export type MetadataProvenanceRow = Selectable<MetadataProvenanceTable>;

export interface UpsertMetadataProvenanceInput {
  itemId: string;
  field: string;
  source: string;
  locked?: boolean;
  updatedAtMs: number;
}

export async function upsertMetadataProvenance(
  db: DbOrTx,
  input: UpsertMetadataProvenanceInput
): Promise<MetadataProvenanceRow> {
  return db
    .insertInto('metadata_provenance')
    .values({
      item_id: input.itemId,
      field: input.field,
      source: input.source,
      ...(input.locked !== undefined ? { locked: input.locked } : {}),
      updated_at_ms: input.updatedAtMs,
    })
    .onConflict((oc) =>
      oc.columns(['item_id', 'field']).doUpdateSet({
        source: (eb) => eb.ref('excluded.source'),
        locked: (eb) => eb.ref('excluded.locked'),
        updated_at_ms: (eb) => eb.ref('excluded.updated_at_ms'),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getProvenanceForItem(
  db: DbOrTx,
  itemId: string
): Promise<MetadataProvenanceRow[]> {
  return db.selectFrom('metadata_provenance').selectAll().where('item_id', '=', itemId).execute();
}
