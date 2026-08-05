// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/remote-wireguard.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card", lane WG1 (R1/R2/R9),
// migrations/0029_remote_wireguard_state.sql. Lives in the PUBLIC barrel
// (src/index.ts), not @loombre/db/internal — same reasoning src/query/
// notices.ts's own header carries at length: this is instance-
// administration state, not viewer-scoped catalog data (authorization is
// requireAdmin/requireLiveAdmin at the apps/server controller layer, A10
// pattern, not a ViewerContext-guarded catalog read — there is no item/
// library association to gate on at all).
//
// The PRIVATE key is NEVER read or written here (R9): this module only
// ever touches server_public_key. RemoteWireguardService (apps/server)
// resolves the private key through packages/secrets separately.

import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';

export interface RemoteWireguardStateRow {
  serverPublicKey: string | null;
  enabled: boolean;
  enabledAtMs: number | null;
  updatedAtMs: number | null;
}

/** The all-disabled default — see migrations/0029's own COMMENT ON TABLE:
 *  no row exists until the first ever enable(), and "no row" is a legal
 *  reading of "not enabled" (this table is never migration-seeded, unlike
 *  every OTHER singleton-shaped concept in this repo having to pick
 *  between seeding and a default — the boolean-PK CHECK pattern here makes
 *  "absent" itself the well-defined default state). */
const DEFAULT_STATE: RemoteWireguardStateRow = {
  serverPublicKey: null,
  enabled: false,
  enabledAtMs: null,
  updatedAtMs: null,
};

function mapRow(row: {
  server_public_key: string | null;
  enabled: boolean;
  enabled_at_ms: number | null;
  updated_at_ms: number;
}): RemoteWireguardStateRow {
  return {
    serverPublicKey: row.server_public_key,
    enabled: row.enabled,
    enabledAtMs: row.enabled_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export async function getRemoteWireguardState(db: Kysely<DB>): Promise<RemoteWireguardStateRow> {
  const row = await db.selectFrom('remote_wireguard_state').selectAll().where('id', '=', true).executeTakeFirst();
  return row ? mapRow(row) : DEFAULT_STATE;
}

export interface EnableRemoteWireguardInput {
  serverPublicKey: string;
  actorUserId: string;
  nowMs: number;
}

/**
 * Upserts the singleton row to enabled=true with a FRESH server public key
 * (R2: "server WG keypair generated at enable") and, in the SAME
 * transaction, emits `remote.enabled` ({enabledAtMs} — R9's no-secrets
 * payload, packages/contract/event-schemas/remote.enabled.schema.json,
 * additionalProperties:false) and `remote.path.changed` ({previousPath:
 * 'none', newPath:'remote', changedAtMs} — RG15/the schema's own
 * "including to/from 'none'" wording). Both events carry the acting admin
 * as the envelope actorUserId, never in the payload (ACTOR_FIELD_MAP maps
 * both types to `[]` — ids/timestamps only, matching remote.enabled's own
 * additionalProperties:false).
 */
export async function enableRemoteWireguardAndEmit(db: Kysely<DB>, input: EnableRemoteWireguardInput): Promise<RemoteWireguardStateRow> {
  return withTransaction(db, async (trx: Transaction<DB>) => {
    const row = await trx
      .insertInto('remote_wireguard_state')
      .values({
        id: true,
        server_public_key: input.serverPublicKey,
        enabled: true,
        enabled_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          server_public_key: input.serverPublicKey,
          enabled: true,
          enabled_at_ms: input.nowMs,
          updated_at_ms: input.nowMs,
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeEvent(trx, {
      type: 'remote.enabled',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { enabledAtMs: input.nowMs },
    });
    await writeEvent(trx, {
      type: 'remote.path.changed',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { previousPath: 'none', newPath: 'remote', changedAtMs: input.nowMs },
    });

    return mapRow(row);
  });
}

export interface DisableRemoteWireguardInput {
  actorUserId: string;
  nowMs: number;
}

/**
 * Conditional UPDATE (only when currently enabled — same CAS-then-check
 * shape src/query/notices.ts's cancelNoticeAndEmit uses): flips enabled to
 * false and, ONLY if this call actually changed something, emits
 * `remote.disabled` + `remote.path.changed` ({previousPath:'remote',
 * newPath:'none'}) in the same transaction. A no-op call (already
 * disabled, or never enabled) returns the CURRENT state and emits
 * NOTHING — disableRemoteWireguard is contractually idempotent
 * ("disabling an already-disabled listener still returns 200 with the
 * status", openapi.yaml) and idempotence must not manufacture duplicate
 * audit events.
 */
export async function disableRemoteWireguardAndEmit(db: Kysely<DB>, input: DisableRemoteWireguardInput): Promise<RemoteWireguardStateRow> {
  return withTransaction(db, async (trx: Transaction<DB>) => {
    const updated = await trx
      .updateTable('remote_wireguard_state')
      .set({ enabled: false, updated_at_ms: input.nowMs })
      .where('id', '=', true)
      .where('enabled', '=', true)
      .returningAll()
      .executeTakeFirst();

    if (!updated) {
      const current = await trx.selectFrom('remote_wireguard_state').selectAll().where('id', '=', true).executeTakeFirst();
      return current ? mapRow(current) : DEFAULT_STATE;
    }

    await writeEvent(trx, {
      type: 'remote.disabled',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { disabledAtMs: input.nowMs },
    });
    await writeEvent(trx, {
      type: 'remote.path.changed',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { previousPath: 'remote', newPath: 'none', changedAtMs: input.nowMs },
    });

    return mapRow(updated);
  });
}
