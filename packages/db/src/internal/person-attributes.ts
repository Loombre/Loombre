// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/person-attributes.ts
//
// person_attributes writer (migrations/0019_restricted_editorial_schema.sql
// — K3: the person-scoped twin of item_attributes, for S5's performer
// metadata Loombre's typed `people` schema has no column for: aliases,
// birthdate, country, measurements, under a `stash` namespace). Mirrors
// item-attributes.ts's shape exactly, which itself mirrors provenance.ts.
//
// Same law as item_attributes: core code never reads this table, only the
// namespaced feature that owns a namespace does (apps/worker/src/stash/
// apply.ts, namespace 'stash'). person_attributes carries no content_class
// column of its own — the owning person's content_class (people.
// content_class) already scopes guard visibility (0019's table comment).

import type { Selectable } from 'kysely';
import type { PersonAttributesTable } from '../types.js';
import type { DbOrTx } from './tx.js';

export type PersonAttributeRow = Selectable<PersonAttributesTable>;

export interface UpsertPersonAttributeInput {
  personId: string;
  namespace: string;
  key: string;
  value: Record<string, unknown>;
}

/** Upsert on (person_id, namespace, key). */
export async function upsertPersonAttribute(db: DbOrTx, input: UpsertPersonAttributeInput): Promise<PersonAttributeRow> {
  return db
    .insertInto('person_attributes')
    .values({ person_id: input.personId, namespace: input.namespace, key: input.key, value: input.value })
    .onConflict((oc) => oc.columns(['person_id', 'namespace', 'key']).doUpdateSet({ value: (eb) => eb.ref('excluded.value') }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getPersonAttributes(db: DbOrTx, personId: string, namespace: string): Promise<PersonAttributeRow[]> {
  return db.selectFrom('person_attributes').selectAll().where('person_id', '=', personId).where('namespace', '=', namespace).execute();
}
