// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/metadata-refresh.ts
//
// Worker-only reads/writes behind the 'metadata-refresh' fan-out job
// (apps/worker/src/metadata/refresh-consumer.ts) and the worker's boot-time
// "did a keyed provider just become enabled" check (apps/worker/src/
// index.ts). Internal (no ViewerContext) by design: the fan-out is a
// system action over the whole catalog, not a viewer's slice of it — the
// same posture as the scanner's own writes. Nothing here is reachable from
// a request path.

import type { ContentClass, ItemType } from '../types.js';
import type { DbOrTx } from './tx.js';

/** The item types the metadata consumer enriches — the same closed set as
 *  apps/worker/src/scan/scanner.ts's METADATA_ENRICHABLE_TYPES and
 *  src/query/admin.ts's ENRICHABLE_ITEM_TYPES (the Dashboard's unmatched
 *  list), kept literally identical so "unmatched" means one thing. */
export const METADATA_ENRICHABLE_ITEM_TYPES: readonly ItemType[] = ['movie', 'series', 'artist', 'album'];

export interface RefreshableItemRow {
  id: string;
  libraryId: string;
  itemType: ItemType;
  contentClass: ContentClass;
  /** Every provider_ids row the item carries (empty = unmatched). */
  providerIds: { provider: string; externalId: string }[];
}

export interface ListRefreshableItemsParams {
  libraryId: string;
  /** true = only items with NO provider_ids row at all (the Dashboard's
   *  unmatched definition); false = every enrichable item. */
  unmatchedOnly: boolean;
  /** Keyset: ids strictly greater than this (UUIDv7 = insertion order). */
  afterId: string | null;
  limit: number;
}

/** One id-ordered page of enrichable items in a library, each with its
 *  provider_ids rows (batched in a second query, never N+1). */
export async function listRefreshableItems(db: DbOrTx, params: ListRefreshableItemsParams): Promise<RefreshableItemRow[]> {
  let query = db
    .selectFrom('catalog_items')
    .select(['id', 'library_id', 'item_type', 'content_class'])
    .where('library_id', '=', params.libraryId)
    .where('item_type', 'in', METADATA_ENRICHABLE_ITEM_TYPES as ItemType[])
    .orderBy('id', 'asc')
    .limit(params.limit);

  if (params.unmatchedOnly) {
    query = query
      .where((eb) =>
        eb.not(eb.exists(eb.selectFrom('provider_ids').select('provider_ids.id').whereRef('provider_ids.item_id', '=', 'catalog_items.id')))
      )
      // An admin who cleared a wrong match (migrations/0049) does not want
      // the sweep to re-pick it; Fix Match turns the flag back on.
      .where('metadata_auto_match', '=', true);
  }
  if (params.afterId !== null) {
    query = query.where('id', '>', params.afterId);
  }

  const items = await query.execute();
  if (items.length === 0) return [];

  const idRows = params.unmatchedOnly
    ? []
    : await db
        .selectFrom('provider_ids')
        .select(['item_id', 'provider', 'external_id'])
        .where('item_id', 'in', items.map((i) => i.id))
        .execute();
  const byItem = new Map<string, { provider: string; externalId: string }[]>();
  for (const row of idRows) {
    const arr = byItem.get(row.item_id) ?? [];
    arr.push({ provider: row.provider, externalId: row.external_id });
    byItem.set(row.item_id, arr);
  }

  return items.map((item) => ({
    id: item.id,
    libraryId: item.library_id,
    itemType: item.item_type,
    contentClass: item.content_class,
    providerIds: byItem.get(item.id) ?? [],
  }));
}

export interface MetadataProviderStateRow {
  provider: string;
  enabled: boolean;
  observedAtMs: number;
}

export async function getMetadataProviderState(db: DbOrTx, provider: string): Promise<MetadataProviderStateRow | undefined> {
  const row = await db.selectFrom('metadata_provider_state').selectAll().where('provider', '=', provider).executeTakeFirst();
  return row ? { provider: row.provider, enabled: row.enabled, observedAtMs: Number(row.observed_at_ms) } : undefined;
}

export async function upsertMetadataProviderState(db: DbOrTx, input: MetadataProviderStateRow): Promise<void> {
  await db
    .insertInto('metadata_provider_state')
    .values({ provider: input.provider, enabled: input.enabled, observed_at_ms: input.observedAtMs })
    .onConflict((oc) =>
      oc.column('provider').doUpdateSet({
        enabled: (eb) => eb.ref('excluded.enabled'),
        observed_at_ms: (eb) => eb.ref('excluded.observed_at_ms'),
      })
    )
    .execute();
}
