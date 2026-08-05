// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/wg-peers.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R2/R9/RG3/RG9, lane WG2). Live-DB
// tests for src/query/wg-peers.ts — self-sufficient, resets+reseeds in
// beforeAll, same convention as remote-direct.spec.ts/remote-tunnel.spec.ts.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { getUserByUsername } from '../src/query/identity.js';
import { insertRefreshToken, findRefreshTokenByHash } from '../src/query/identity.js';
import { readUnprocessedEvents } from '../src/query/events.js';
import {
  WgSubnetExhaustedError,
  listAllWgPeers,
  getWgPeerByDeviceId,
  listWgPeers,
  enrollRemoteWireguardDeviceAndEmit,
  revokeRemoteWireguardDeviceAndEmit,
} from '../src/query/wg-peers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: PKG_ROOT, env: { ...process.env, DATABASE_URL }, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;
let adminId: string;
let casualId: string;
let nextKey = 0;

/** Deterministic, distinct-per-call fake public keys — this file never
 *  touches packages/wg-native (pure DB-layer coverage), so a real X25519
 *  keypair is unnecessary; only uniqueness matters for these tests. */
function fakePublicKey(): string {
  nextKey += 1;
  return `fake-public-key-${String(nextKey).padStart(4, '0')}=====================`.slice(0, 44);
}

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  const admin = await getUserByUsername(db, 'admin');
  if (!admin) throw new Error('seed did not create the admin user');
  adminId = admin.id;
  const casual = await getUserByUsername(db, 'casual');
  if (!casual) throw new Error('seed did not create the casual user');
  casualId = casual.id;
});

afterAll(async () => {
  await db?.destroy();
});

describe('enrollRemoteWireguardDeviceAndEmit', () => {
  it('inserts a kind=remote devices row + a wg_peers row with the lowest-free tunnel IP, and emits remote.device.enrolled', async () => {
    const nowMs = 1_700_000_000_000;
    const publicKey = fakePublicKey();

    const result = await enrollRemoteWireguardDeviceAndEmit(db, {
      userId: casualId,
      name: "Casual's phone",
      publicKey,
      subnetCidr: '10.90.1.0/24',
      actorUserId: adminId,
      nowMs,
    });

    expect(result.tunnelIp).toBe('10.90.1.2');
    expect(result.publicKey).toBe(publicKey);
    expect(result.userId).toBe(casualId);
    expect(result.name).toBe("Casual's phone");
    expect(result.createdAtMs).toBe(nowMs);

    const deviceRow = await db.selectFrom('devices').selectAll().where('id', '=', result.deviceId).executeTakeFirstOrThrow();
    expect(deviceRow.kind).toBe('remote');
    expect(deviceRow.user_id).toBe(casualId);
    expect(deviceRow.name).toBe("Casual's phone");

    const peer = await getWgPeerByDeviceId(db, result.deviceId);
    expect(peer).toEqual({ deviceId: result.deviceId, publicKey, tunnelIp: '10.90.1.2', createdAtMs: nowMs });

    const events = await readUnprocessedEvents(db, 1000);
    const enrolled = events.find((e) => e.type === 'remote.device.enrolled' && (e.payload as { deviceId?: string }).deviceId === result.deviceId);
    expect(enrolled).toBeDefined();
    expect(enrolled!.payload).toEqual({ deviceId: result.deviceId, userId: casualId, name: "Casual's phone", enrolledAtMs: nowMs });
    expect(enrolled!.actor_user_id).toBe(adminId);
  });

  it('allocates the NEXT lowest-free IP for a second enrollment in the SAME subnet', async () => {
    const nowMs = 1_700_000_001_000;
    const result = await enrollRemoteWireguardDeviceAndEmit(db, {
      userId: casualId,
      name: "Casual's laptop",
      publicKey: fakePublicKey(),
      subnetCidr: '10.90.1.0/24',
      actorUserId: adminId,
      nowMs,
    });
    expect(result.tunnelIp).toBe('10.90.1.3');
  });

  it('throws WgSubnetExhaustedError when the configured subnet has no free device addresses left (a /30 has exactly one)', async () => {
    const nowMs = 1_700_000_002_000;
    const first = await enrollRemoteWireguardDeviceAndEmit(db, {
      userId: casualId,
      name: 'Exhaustion probe 1',
      publicKey: fakePublicKey(),
      subnetCidr: '10.90.2.0/30',
      actorUserId: adminId,
      nowMs,
    });
    expect(first.tunnelIp).toBe('10.90.2.2');

    await expect(
      enrollRemoteWireguardDeviceAndEmit(db, {
        userId: casualId,
        name: 'Exhaustion probe 2',
        publicKey: fakePublicKey(),
        subnetCidr: '10.90.2.0/30',
        actorUserId: adminId,
        nowMs,
      }),
    ).rejects.toThrow(WgSubnetExhaustedError);
  });

  it('CONCURRENT ENROLLMENT: N parallel enrollments into the same fresh subnet each get a distinct, sequential tunnel IP — no collisions, no lost writes', async () => {
    const nowMs = 1_700_000_003_000;
    const subnetCidr = '10.90.3.0/24';
    const N = 12;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        enrollRemoteWireguardDeviceAndEmit(db, {
          userId: casualId,
          name: `Concurrent device ${i}`,
          publicKey: fakePublicKey(),
          subnetCidr,
          actorUserId: adminId,
          nowMs,
        }),
      ),
    );

    const tunnelIps = results.map((r) => r.tunnelIp);
    const uniqueIps = new Set(tunnelIps);
    expect(uniqueIps.size).toBe(N); // every peer got a DISTINCT address

    const expected = Array.from({ length: N }, (_, i) => `10.90.3.${i + 2}`).sort();
    expect([...uniqueIps].sort()).toEqual(expected); // exactly .2..(N+1), no gaps, no duplicates

    // Every device row really was created (no lost writes under the race).
    const deviceIds = results.map((r) => r.deviceId);
    expect(new Set(deviceIds).size).toBe(N);
    const rows = await db.selectFrom('wg_peers').select('device_id').where('device_id', 'in', deviceIds).execute();
    expect(rows.length).toBe(N);
  });
});

describe('listAllWgPeers / listWgPeers', () => {
  it('listAllWgPeers returns every peer, unpaginated (the boot-resume feed)', async () => {
    const all = await listAllWgPeers(db);
    expect(all.length).toBeGreaterThanOrEqual(3); // at least the three non-exhaustion-probe rows above
    for (const peer of all) {
      expect(typeof peer.publicKey).toBe('string');
      expect(typeof peer.tunnelIp).toBe('string');
    }
  });

  it('listWgPeers joins devices for userId/name and paginates newest-first', async () => {
    const page = await listWgPeers(db, { limit: 2 });
    expect(page.rows.length).toBe(2);
    for (const row of page.rows) {
      expect(row.userId).toBe(casualId);
      expect(typeof row.name).toBe('string');
      expect(typeof row.tunnelIp).toBe('string');
      expect(typeof row.publicKey).toBe('string');
    }
    // Descending by createdAtMs (ties broken by id desc) — the second row's
    // timestamp must not be AFTER the first's.
    expect(page.rows[1]!.createdAtMs).toBeLessThanOrEqual(page.rows[0]!.createdAtMs);
  });
});

describe('revokeRemoteWireguardDeviceAndEmit', () => {
  it('deletes the devices row (cascading its wg_peers row), revokes outstanding refresh tokens, and emits remote.device.revoked', async () => {
    const nowMs = 1_700_000_004_000;
    const enrolled = await enrollRemoteWireguardDeviceAndEmit(db, {
      userId: casualId,
      name: 'Revocation target',
      publicKey: fakePublicKey(),
      subnetCidr: '10.90.4.0/24',
      actorUserId: adminId,
      nowMs,
    });

    // Prove there IS an outstanding refresh token to revoke — the whole
    // point of RG3's gap closure.
    const refreshToken = await insertRefreshToken(db, {
      userId: casualId,
      deviceId: enrolled.deviceId,
      tokenHash: `wg-peers-spec-token-${enrolled.deviceId}`,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 1_000_000,
      rotatedFrom: null,
    });
    expect(refreshToken.revoked_at_ms).toBeNull();

    const result = await revokeRemoteWireguardDeviceAndEmit(db, { deviceId: enrolled.deviceId, actorUserId: adminId, nowMs: nowMs + 500 });
    expect(result).toEqual({ deviceId: enrolled.deviceId, userId: casualId, refreshTokensRevoked: 1 });

    const deviceRow = await db.selectFrom('devices').selectAll().where('id', '=', enrolled.deviceId).executeTakeFirst();
    expect(deviceRow).toBeUndefined();

    const peerRow = await getWgPeerByDeviceId(db, enrolled.deviceId);
    expect(peerRow).toBeUndefined(); // cascaded away with the device

    const reread = await findRefreshTokenByHash(db, `wg-peers-spec-token-${enrolled.deviceId}`);
    expect(reread!.revoked_at_ms).toBe(nowMs + 500);

    const events = await readUnprocessedEvents(db, 1000);
    const revoked = events.find((e) => e.type === 'remote.device.revoked' && (e.payload as { deviceId?: string }).deviceId === enrolled.deviceId);
    expect(revoked).toBeDefined();
    expect(revoked!.payload).toEqual({ deviceId: enrolled.deviceId, userId: casualId, revokedAtMs: nowMs + 500 });
  });

  it('returns undefined (idempotent no-op) for a device id that does not exist', async () => {
    const result = await revokeRemoteWireguardDeviceAndEmit(db, {
      deviceId: '00000000-0000-4000-8000-000000000000',
      actorUserId: adminId,
      nowMs: Date.now(),
    });
    expect(result).toBeUndefined();
  });
});
