// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/wg-peers.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R2/R9/RG3/RG9, lane WG2),
// migrations/0030_wg_peers.sql. Lives in the PUBLIC barrel, not
// @loombre/db/internal — same posture as src/query/remote-wireguard.ts's
// own header: instance/device administration authorized by requireAdmin
// (admin-scoped WG2 ops) or self-scope (DELETE /devices/{id}, RG3's gap
// closure) at the apps/server controller layer, never a ViewerContext-
// guarded catalog read.
//
// R9 (no private key, EVER): every function here only ever touches
// public_key/tunnel_ip/device_id/created_at_ms — there is no column, no
// parameter, no return type anywhere in this file that could carry a
// private key. The peer's private key is generated in apps/server
// (packages/wg-native's generateWgKeyPair), embedded ONCE into the
// enrollment response's configText, and never reaches this module at all.
//
// CONCURRENCY (RG9's "lowest-free" allocation, proven by a concurrent-
// enroll test — apps/server/test/remote-wireguard-devices.e2e.spec.ts):
// enrollRemoteWireguardDeviceAndEmit retries its WHOLE transaction (fresh
// read of used tunnel_ips, fresh devices-row insert, fresh wg_peers
// insert) on a 23505 against wg_peers' own tunnel_ip UNIQUE constraint —
// never a retry INSIDE a still-open transaction (Postgres aborts a
// transaction on ANY error until it is rolled back; there is no
// SAVEPOINT machinery in this codebase's withTransaction helper, see
// internal/tx.ts). Retrying the whole transaction is race-safe BECAUSE
// Kysely's `.transaction().execute()` rolls the WHOLE thing back
// automatically when the callback throws — the devices row this attempt
// just inserted is undone along with the failed wg_peers insert, so a
// retried attempt starts from a clean slate every time (no orphaned
// devices row ever committed without its wg_peers row, or vice versa).

import type { Kysely } from 'kysely';
import type { DB } from '../types.js';
import { lowestFreeDeviceIp } from '@loombre/shared';
import { withTransaction, writeEvent } from '../internal/index.js';
import { revokeRefreshTokensForDevice } from './identity.js';
import { decodeCursor, encodeCursor, isCursorRowId } from './cursor.js';

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function pgConstraintName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const constraint = (err as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

const WG_PEERS_TUNNEL_IP_UNIQUE_CONSTRAINT = 'wg_peers_tunnel_ip_key';

/** Thrown when the configured tunnel subnet has no free device addresses
 *  left — a real, user-actionable condition (the admin needs a bigger
 *  subnet or to revoke stale devices), not a bug, so it is its own class
 *  rather than a generic Error a caller would have to string-match. */
export class WgSubnetExhaustedError extends Error {
  constructor(public readonly subnetCidr: string) {
    super(`No free tunnel addresses remain in the configured subnet (${subnetCidr}).`);
    this.name = 'WgSubnetExhaustedError';
  }
}

export interface WgPeerRow {
  deviceId: string;
  publicKey: string;
  tunnelIp: string;
  createdAtMs: number;
}

function mapWgPeerRow(row: { device_id: string; public_key: string; tunnel_ip: string; created_at_ms: number }): WgPeerRow {
  return { deviceId: row.device_id, publicKey: row.public_key, tunnelIp: row.tunnel_ip, createdAtMs: row.created_at_ms };
}

/** Every currently-enrolled peer's public key + tunnel IP — no pagination,
 *  no join: this is RemoteWireguardService.loadPeers()'s boot-resume feed
 *  (WgStart's `peers` field needs every peer re-added on every process
 *  restart, not a page of them). */
export async function listAllWgPeers(db: Kysely<DB>): Promise<WgPeerRow[]> {
  const rows = await db.selectFrom('wg_peers').select(['device_id', 'public_key', 'tunnel_ip', 'created_at_ms']).execute();
  return rows.map(mapWgPeerRow);
}

export async function getWgPeerByDeviceId(db: Kysely<DB>, deviceId: string): Promise<WgPeerRow | undefined> {
  const row = await db.selectFrom('wg_peers').selectAll().where('device_id', '=', deviceId).executeTakeFirst();
  return row ? mapWgPeerRow(row) : undefined;
}

// ============================================================================
// listWgPeers — the admin-facing joined + paginated view
// (listRemoteWireguardDevices, RemoteWireguardDevicePage)
// ============================================================================

export interface WgPeerListRow {
  /** Same id as the underlying devices row (kind='remote') — this IS that
   *  row, not a separate entity (contract RemoteWireguardDevice's own
   *  description). */
  id: string;
  userId: string;
  name: string;
  tunnelIp: string;
  publicKey: string;
  createdAtMs: number;
}

export interface ListWgPeersParams {
  cursor?: string;
  limit?: number;
}

export interface ListWgPeersResult {
  rows: WgPeerListRow[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;

interface WgPeerCursorPayload {
  createdAtMs: number;
  id: string;
}

function isWgPeerCursorPayload(value: unknown): value is WgPeerCursorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).createdAtMs === 'number' &&
    isCursorRowId((value as Record<string, unknown>).id)
  );
}

export async function listWgPeers(db: Kysely<DB>, params: ListWgPeersParams = {}): Promise<ListWgPeersResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  let query = db
    .selectFrom('wg_peers')
    .innerJoin('devices', 'devices.id', 'wg_peers.device_id')
    .select([
      'devices.id as id',
      'devices.user_id as user_id',
      'devices.name as name',
      'wg_peers.tunnel_ip as tunnel_ip',
      'wg_peers.public_key as public_key',
      'wg_peers.created_at_ms as created_at_ms',
    ]);

  if (params.cursor) {
    const { createdAtMs, id } = decodeCursor(params.cursor, isWgPeerCursorPayload);
    query = query.where((eb) =>
      eb.or([
        eb('wg_peers.created_at_ms', '<', createdAtMs),
        eb.and([eb('wg_peers.created_at_ms', '=', createdAtMs), eb('devices.id', '<', id)]),
      ]),
    );
  }

  const rows = await query.orderBy('wg_peers.created_at_ms', 'desc').orderBy('devices.id', 'desc').limit(limit).execute();
  const last = rows[rows.length - 1];
  const nextCursor = rows.length === limit && last ? encodeCursor({ createdAtMs: last.created_at_ms, id: last.id }) : null;

  return {
    rows: rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name, tunnelIp: r.tunnel_ip, publicKey: r.public_key, createdAtMs: r.created_at_ms })),
    nextCursor,
  };
}

// ============================================================================
// enrollRemoteWireguardDeviceAndEmit
// ============================================================================

const MAX_ALLOCATION_ATTEMPTS = 20;

export interface EnrollRemoteWireguardDeviceInput {
  userId: string;
  name: string;
  publicKey: string;
  subnetCidr: string;
  actorUserId: string;
  nowMs: number;
}

export interface EnrollRemoteWireguardDeviceResult {
  deviceId: string;
  userId: string;
  name: string;
  tunnelIp: string;
  publicKey: string;
  createdAtMs: number;
}

/**
 * ONE transaction per attempt: insert the devices row (kind='remote', NOT
 * the login-driven createDevice path — RG3), allocate + insert the
 * wg_peers row (RG9's lowest-free IP), and emit `remote.device.enrolled` —
 * all together, or none of it (a failed attempt rolls back completely,
 * see this file's header for why that makes the retry loop below safe).
 * Retried up to MAX_ALLOCATION_ATTEMPTS times on a tunnel_ip race lost to
 * a concurrent enrollment; any OTHER error (including a subnet-exhausted
 * WgSubnetExhaustedError, or a public_key/device_id collision — neither of
 * which a different IP candidate could ever fix) propagates immediately.
 */
export async function enrollRemoteWireguardDeviceAndEmit(
  db: Kysely<DB>,
  input: EnrollRemoteWireguardDeviceInput,
): Promise<EnrollRemoteWireguardDeviceResult> {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    try {
      return await withTransaction(db, async (trx) => {
        const usedRows = await trx.selectFrom('wg_peers').select('tunnel_ip').execute();
        const candidate = lowestFreeDeviceIp(input.subnetCidr, usedRows.map((r) => r.tunnel_ip));
        if (candidate === null) {
          throw new WgSubnetExhaustedError(input.subnetCidr);
        }

        const device = await trx
          .insertInto('devices')
          .values({
            user_id: input.userId,
            name: input.name,
            platform: null,
            profile: {},
            kind: 'remote',
            last_seen_ms: null,
            created_at_ms: input.nowMs,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const peer = await trx
          .insertInto('wg_peers')
          .values({
            device_id: device.id,
            public_key: input.publicKey,
            tunnel_ip: candidate,
            created_at_ms: input.nowMs,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeEvent(trx, {
          type: 'remote.device.enrolled',
          tsMs: input.nowMs,
          actorUserId: input.actorUserId,
          payload: { deviceId: device.id, userId: input.userId, name: input.name, enrolledAtMs: input.nowMs },
        });

        return {
          deviceId: device.id,
          userId: input.userId,
          name: input.name,
          tunnelIp: peer.tunnel_ip,
          publicKey: peer.public_key,
          createdAtMs: peer.created_at_ms,
        };
      });
    } catch (err) {
      if (isPgUniqueViolation(err) && pgConstraintName(err) === WG_PEERS_TUNNEL_IP_UNIQUE_CONSTRAINT) {
        continue; // raced with a concurrent enrollment for the same candidate address — retry the WHOLE attempt
      }
      throw err;
    }
  }
  throw new Error(
    `enrollRemoteWireguardDeviceAndEmit: exceeded ${MAX_ALLOCATION_ATTEMPTS} allocation attempts for subnet ${input.subnetCidr} — high contention or a near-exhausted pool.`,
  );
}

// ============================================================================
// revokeRemoteWireguardDeviceAndEmit
// ============================================================================

export interface RevokeRemoteWireguardDeviceInput {
  deviceId: string;
  actorUserId: string;
  nowMs: number;
}

export interface RevokeRemoteWireguardDeviceResult {
  deviceId: string;
  userId: string;
  refreshTokensRevoked: number;
}

/**
 * Deletes the devices row (CASCADE deletes its wg_peers row,
 * migrations/0030's ON DELETE CASCADE — see that migration's own COMMENT
 * ON TABLE), revokes every outstanding refresh token for it (RG3's
 * pre-existing-gap closure), and emits `remote.device.revoked` — all ONE
 * transaction. Returns undefined (a true no-op, never an error) when the
 * device does not exist — same idempotent-nonexistence posture every other
 * revoke-shaped write in this package uses.
 *
 * ORDERING (crash-safety, R9/RG3): callers (apps/server/src/remote/
 * wireguard/remote-wireguard.service.ts's revokeDevice) MUST remove the
 * LIVE WG peer (packages/wg-native WgRemovePeer) BEFORE calling this
 * function, never after — see that method's own header for the full
 * rationale (a crash between live removal and this DB write leaves a peer
 * that's already unreachable on the wire but still has DB rows, which is
 * recoverable by simply re-running revoke; the REVERSE order risks a
 * device the DB calls "revoked" that can still complete a live WireGuard
 * handshake — a security hole, not merely an inconsistency).
 */
export async function revokeRemoteWireguardDeviceAndEmit(
  db: Kysely<DB>,
  input: RevokeRemoteWireguardDeviceInput,
): Promise<RevokeRemoteWireguardDeviceResult | undefined> {
  return withTransaction(db, async (trx) => {
    const device = await trx.selectFrom('devices').select(['id', 'user_id']).where('id', '=', input.deviceId).executeTakeFirst();
    if (!device) return undefined;

    const refreshTokensRevoked = await revokeRefreshTokensForDevice(trx, device.user_id, device.id, input.nowMs);

    await trx.deleteFrom('devices').where('id', '=', input.deviceId).execute();

    await writeEvent(trx, {
      type: 'remote.device.revoked',
      tsMs: input.nowMs,
      actorUserId: input.actorUserId,
      payload: { deviceId: device.id, userId: device.user_id, revokedAtMs: input.nowMs },
    });

    return { deviceId: device.id, userId: device.user_id, refreshTokensRevoked };
  });
}
