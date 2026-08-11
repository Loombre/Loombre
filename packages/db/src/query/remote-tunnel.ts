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
import { withRemotePathEnableGuard } from './remote-path-guard.js';

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
 *
 * LD-9: that verification is no longer taken on trust. The write runs
 * inside withRemotePathEnableGuard, which re-reads all three subsystems'
 * `enabled` bits under a shared advisory lock IN THIS TRANSACTION and
 * throws RemotePathConflictError (nothing written, nothing emitted) if any
 * other path is enabled — closing the window between the service's own
 * pre-check and this commit, which for the Tunnel path spans a
 * multi-second Cloudflare provisioning call. previousPath:'none' below is
 * therefore now GUARANTEED correct, not merely expected. See
 * src/query/remote-path-guard.ts's design note.
 */
export async function enableTunnelStateAndEmit(db: Kysely<DB>, input: EnableTunnelStateInput): Promise<RemoteTunnelStateRow> {
  return withRemotePathEnableGuard(db, 'tunnel', async (trx) => {
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

// ============================================================================
// recordTunnelConnectorStateEvent (WG3, R4/RG7 gap closure)
// ============================================================================
//
// STATE.md "Loombre Remote ..." — T2's own report flagged the gap: "the
// frozen event schema is emitted by NO ONE" (packages/contract/event-
// schemas/tunnel.connector.state.schema.json, frozen at Wave 0). Same shape
// as remote-posture.ts's own recordPostureRegressedEvent/
// recordPostureRecoveredEvent (see that file's header for the full
// reasoning this borrows): a NARROW, system-generated (no admin actor —
// ACTOR_FIELD_MAP maps this type to `[]`, actorUserId is always null here)
// writer with no associated row to update — the connector's own state is
// process-lifetime-only (RG7: never persisted), so there is nothing to
// diff against in a transaction the way setPluginHealthAndEmit diffs a
// `plugins` row; the CALLER (apps/server/src/remote/tunnel/tunnel-
// connector-state-event.service.ts, subscribed via ConnectorManager.
// onStateChange) is what already knows a real transition just happened and
// calls this exactly once per transition.
//
// Values arrive in the CONTRACT's own vocabulary (`stopped|starting|
// running|degraded|error`), already translated by the caller via
// remote-tunnel.service.ts's mapConnectorStateToContract — this function
// never sees ConnectorManager's internal `stopped|starting|healthy|
// unhealthy|backoff` vocabulary at all, matching exactly what the frozen
// JSON Schema's own enum requires.

export interface RecordTunnelConnectorStateEventInput {
  previousState: 'stopped' | 'starting' | 'running' | 'degraded' | 'error';
  newState: 'stopped' | 'starting' | 'running' | 'degraded' | 'error';
  changedAtMs: number;
}

/** Writes ONE `tunnel.connector.state` admin-only event with no actor —
 *  see this section's header. */
export async function recordTunnelConnectorStateEvent(db: Kysely<DB>, input: RecordTunnelConnectorStateEventInput): Promise<void> {
  await withTransaction(db, async (trx) => {
    await writeEvent(trx, {
      type: 'tunnel.connector.state',
      tsMs: input.changedAtMs,
      actorUserId: null,
      payload: {
        previousState: input.previousState,
        newState: input.newState,
        changedAtMs: input.changedAtMs,
      },
    });
  });
}
