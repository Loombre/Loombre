// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/events.ts
//
// writeEvent deliberately takes a `Transaction<DB>`, not the wider
// `DbOrTx` every other helper in this module accepts: the outbox pattern
// only holds (docs/PLAN.md §4.3) if the event row is written in the SAME
// transaction as the state change it describes, so the type signature
// makes "write an event outside a transaction" a compile error instead of
// a runtime foot-gun.

import type { Selectable, Transaction } from 'kysely';
import type { DB, EventsTable } from '../types.js';

export type EventRow = Selectable<EventsTable>;

export interface WriteEventInput {
  type: string;
  tsMs: number;
  actorUserId?: string | null;
  payload: Record<string, unknown>;
}

export async function writeEvent(trx: Transaction<DB>, input: WriteEventInput): Promise<EventRow> {
  return trx
    .insertInto('events')
    .values({
      type: input.type,
      ts_ms: input.tsMs,
      actor_user_id: input.actorUserId ?? null,
      payload: input.payload,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
