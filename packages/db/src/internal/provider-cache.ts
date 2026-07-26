// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/provider-cache.ts
//
// provider_cache writer/reader (P1.11, migrations/0002_phase1_catalog.sql).
// `body` is a serialized-JSON string by design — see the migration's
// comment on the table.

import type { Selectable } from 'kysely';
import type { ProviderCacheTable } from '../types.js';
import type { DbOrTx } from './tx.js';

export type ProviderCacheRow = Selectable<ProviderCacheTable>;

export interface UpsertProviderCacheEntryInput {
  provider: string;
  requestHash: string;
  body: string;
  fetchedAtMs: number;
  expiresAtMs: number;
}

export async function upsertProviderCacheEntry(
  db: DbOrTx,
  input: UpsertProviderCacheEntryInput
): Promise<ProviderCacheRow> {
  return db
    .insertInto('provider_cache')
    .values({
      provider: input.provider,
      request_hash: input.requestHash,
      body: input.body,
      fetched_at_ms: input.fetchedAtMs,
      expires_at_ms: input.expiresAtMs,
    })
    .onConflict((oc) =>
      oc.columns(['provider', 'request_hash']).doUpdateSet({
        body: (eb) => eb.ref('excluded.body'),
        fetched_at_ms: (eb) => eb.ref('excluded.fetched_at_ms'),
        expires_at_ms: (eb) => eb.ref('excluded.expires_at_ms'),
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Returns the cache entry only if it has not expired as of `nowMs`
 * (`expires_at_ms > nowMs`); an expired or absent entry both return
 * `undefined` so callers can't accidentally tell the two apart and skip a
 * fresh provider fetch.
 */
export async function getProviderCacheEntry(
  db: DbOrTx,
  provider: string,
  requestHash: string,
  nowMs: number
): Promise<ProviderCacheRow | undefined> {
  return db
    .selectFrom('provider_cache')
    .selectAll()
    .where('provider', '=', provider)
    .where('request_hash', '=', requestHash)
    .where('expires_at_ms', '>', nowMs)
    .executeTakeFirst();
}
