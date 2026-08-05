// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/remote-tunnel.ts
//
// Loombre Remote — Tunnel path (STATE.md R4/R9/RG7, lane T1),
// migrations/0032_remote_tunnel_state.sql's singleton row. Lives in the
// PUBLIC barrel (src/index.ts), not @loombre/db/internal — same reasoning
// src/query/notices.ts's own header gives at length: this is instance-
// administration state, not viewer-scoped catalog data, and authorization
// (isAdmin) is entirely the apps/server controller/service layer's job via
// requireAdmin/requireLiveAdmin (A10), never a ViewerContext guard.
//
// R8 "verified teardown": disableTunnelStateAndEmit does NOT itself call
// Cloudflare — apps/server/src/remote/tunnel/remote-tunnel.service.ts calls
// TunnelProvider.deprovisionTunnel/removeDnsRoute and ConnectorManager.stop
// FIRST, and only calls this module's disable function once every one of
// those has independently succeeded. That ordering (not this module) is
// what makes teardown "verified" rather than "assumed" — this module's own
// job is just the one atomic state-row-plus-events write, same shape as
// every other *AndEmit function in this package.
//
// All timestamps arrive as an explicit `nowMs: number` argument — this
// module never calls Date.now() itself (house style; every other query
// module in this package follows the same rule).

import type { Kysely, Selectable } from 'kysely';
import type { DB, RemoteTunnelStateTable } from '../types.js';
import { withTransaction, writeEvent } from '../internal/index.js';

export type RemoteTunnelStateRow = Selectable<RemoteTunnelStateTable>;

/** The singleton row always exists (seeded by the migration itself) —
 *  callers never need to handle "no row yet". */
export async function getRemoteTunnelState(db: Kysely<DB>): Promise<RemoteTunnelStateRow> {
  const row = await db.selectFrom('remote_tunnel_state').selectAll().where('id', '=', 1).executeTakeFirst();
  if (!row) {
    throw new Error(
      'getRemoteTunnelState: the remote_tunnel_state singleton row is missing — migrations/0032_remote_tunnel_state.sql should have seeded it; this should be impossible.'
    );
  }
  return row;
}

// ============================================================================
// enableTunnelStateAndEmit
// ============================================================================

export interface EnableTunnelStateInput {
  hostname: string;
  tunnelId: string;
  accountId: string;
  zoneId: string;
  dnsRecordId: string;
  actorUserId: string;
  nowMs: number;
}

/**
 * ONE transaction: (1) UPDATE the singleton row to enabled=true with the
 * freshly-provisioned identifiers; (2) emit `remote.enabled` (payload
 * `{enabledAtMs}` — packages/contract/event-schemas/remote.enabled.
 * schema.json's frozen Wave-0 shape has no `path` field, deliberately: the
 * SAME-trx `remote.path.changed` event below is what tells a consumer WHICH
 * path just came up); (3) emit `remote.path.changed` with previousPath
 * ALWAYS 'none' — by the time apps/server's RemoteTunnelService calls this,
 * it has already verified (via RemoteActivePathReader + this row's own
 * prior `enabled` value) that no path, including tunnel itself, was active,
 * so 'none' is the only value that can ever be correct here, not an
 * assumption this function makes independently.
 */
export async function enableTunnelStateAndEmit(db: Kysely<DB>, input: EnableTunnelStateInput): Promise<RemoteTunnelStateRow> {
  return withTransaction(db, async (trx) => {
    const row = await trx
      .updateTable('remote_tunnel_state')
      .set({
        enabled: true,
        hostname: input.hostname,
        tunnel_id: input.tunnelId,
        account_id: input.accountId,
        zone_id: input.zoneId,
        dns_record_id: input.dnsRecordId,
        enabled_at_ms: input.nowMs,
      })
      .where('id', '=', 1)
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
      payload: { previousPath: 'none', newPath: 'tunnel', changedAtMs: input.nowMs },
    });

    return row;
  });
}

// ============================================================================
// disableTunnelStateAndEmit
// ============================================================================

export interface DisableTunnelStateInput {
  actorUserId: string;
  nowMs: number;
}

/**
 * Idempotent (same posture as WireGuard's disableRemoteWireguard, RG15):
 * when the row is already disabled this is a true no-op — no write, no
 * events — and returns the current (already-disabled) row. Otherwise
 * clears all five provisioning identifiers together (the migration's own
 * CHECK enforces this at the storage layer too) and emits `remote.disabled`
 * + `remote.path.changed` (tunnel -> none) in the SAME transaction as the
 * clear.
 */
export async function disableTunnelStateAndEmit(db: Kysely<DB>, input: DisableTunnelStateInput): Promise<RemoteTunnelStateRow> {
  return withTransaction(db, async (trx) => {
    const current = await trx.selectFrom('remote_tunnel_state').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    if (!current.enabled) {
      return current;
    }

    const row = await trx
      .updateTable('remote_tunnel_state')
      .set({
        enabled: false,
        hostname: null,
        tunnel_id: null,
        account_id: null,
        zone_id: null,
        dns_record_id: null,
        enabled_at_ms: null,
      })
      .where('id', '=', 1)
      .returningAll()
      .executeTakeFirstOrThrow();

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
      payload: { previousPath: 'tunnel', newPath: 'none', changedAtMs: input.nowMs },
    });

    return row;
  });
}
