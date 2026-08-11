// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/remote-path-enable-serialization.spec.ts
//
// LD-9 (STATE.md "an upstream media server-study IMPLEMENTATION run" LD register; closes
// the Loombre Remote OPEN-ledger item V-SEC F2). The MECHANISM-level
// checks for src/query/remote-path-guard.ts — the HTTP-level behaviour
// this produces is pinned separately by apps/server/test/
// remote-enable-race.e2e.spec.ts.
//
// Four properties, each mapping to a paragraph of that module's design
// note:
//
//  1. §2 The race is closed. N concurrent enables of DIFFERENT paths
//     resolve to exactly one winner; the losers reject with
//     RemotePathConflictError. RED before the guard is wired in: all three
//     transactions touch different rows, never block each other, and all
//     three commit — after which resolveActivePath() throws the RG15
//     invariant violation, which is precisely the 500 V-SEC F2 described.
//  2. Over-locking check. Concurrent enables of the SAME path stay legal
//     (idempotent re-enable is contractual), so the guard rejects on
//     "another path", never on "an enable is in flight".
//  3. §3 The release guarantee, mechanically. A guarded body that THROWS
//     leaves zero advisory locks held in this database, and the next
//     enable proceeds immediately. This is the "no permanent-lockout mode
//     exists, by construction" claim, checked rather than asserted.
//  4. §7 Disable and recovery can never be blocked. An independent session
//     holds the guard's own advisory lock for the whole duration while all
//     three disable functions AND resolveActivePath are exercised — they
//     must all complete. If any of them ever took this lock, this test
//     would hang until the suite timeout.
//
// Connection: DATABASE_URL env var (rewritten to the `_test` sibling by
// resolveTestDatabaseUrl), default
//   postgres://loombre:loombre@localhost:5442/loombre_test

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { resolveActivePath, RemoteActivePathInvariantViolationError } from '../src/query/remote-active-path.js';
import {
  RemotePathConflictError,
  REMOTE_PATH_ENABLE_LOCK_KEY_FOR_TESTS,
  withRemotePathEnableGuard,
} from '../src/query/remote-path-guard.js';
import { enableRemoteWireguardAndEmit, disableRemoteWireguardAndEmit } from '../src/query/remote-wireguard.js';
import { enableTunnelStateAndEmit, disableTunnelStateAndEmit } from '../src/query/remote-tunnel.js';
import { enableRemoteDirectStateAndEmit, disableRemoteDirectStateAndEmit } from '../src/query/remote-direct.js';
import { getUserByUsername } from '../src/query/identity.js';
import { resolveTestDatabaseUrl } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = resolveTestDatabaseUrl();

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: PKG_ROOT, env: { ...process.env, DATABASE_URL }, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;
let adminId: string;
const nowMs = 1_700_000_000_000;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  const admin = await getUserByUsername(db, 'admin');
  if (!admin) throw new Error('seed did not create the admin user');
  adminId = admin.id;
});

afterAll(async () => {
  await db?.destroy();
});

/** Leaves every path off, whatever the previous test did — uses the
 *  disable functions, which take no lock (property 4). */
async function disableEverything(): Promise<void> {
  await disableRemoteWireguardAndEmit(db, { actorUserId: adminId, nowMs });
  await disableTunnelStateAndEmit(db, { actorUserId: adminId, nowMs });
  await disableRemoteDirectStateAndEmit(db, { actorUserId: adminId, nowMs });
}

beforeEach(disableEverything);

function enableRemote(suffix: string) {
  return enableRemoteWireguardAndEmit(db, { serverPublicKey: `serialization-${suffix}`, actorUserId: adminId, nowMs });
}
function enableTunnel(suffix: string) {
  return enableTunnelStateAndEmit(db, {
    hostname: 'media.example.com',
    tunnelId: `serialization-tunnel-${suffix}`,
    accountId: 'acct-1',
    zoneId: 'zone-1',
    dnsRecordId: 'record-1',
    actorUserId: adminId,
    nowMs,
  });
}
function enableDirect() {
  return enableRemoteDirectStateAndEmit(db, {
    mode: 'reverse-proxy',
    preEnableTlsMode: 'off',
    preEnableTrustProxy: '',
    previousActivePath: 'none',
    actorUserId: adminId,
    nowMs,
  });
}

/** Advisory locks currently held IN THIS DATABASE. Scoped by database oid so
 *  a concurrent suite in a sibling `_test` database can never make this
 *  flake (pg_locks is cluster-wide). */
async function advisoryLockCount(): Promise<number> {
  const row = await sql<{ n: number }>`
    SELECT count(*)::int AS n
      FROM pg_locks
     WHERE locktype = 'advisory'
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `.execute(db);
  return row.rows[0]!.n;
}

describe('LD-9 §2 — concurrent enables of DIFFERENT paths cannot both land', () => {
  it('3-way race: exactly ONE enable commits, the other two reject with RemotePathConflictError, and the resolver stays healthy', async () => {
    const results = await Promise.allSettled([enableRemote('race-a'), enableTunnel('race-a'), enableDirect()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(RemotePathConflictError);
      // The 409 the boundary renders must name the path that actually won.
      expect(['remote', 'tunnel', 'direct']).toContain((r.reason as RemotePathConflictError).activePath);
    }

    // The whole point: the RG15 invariant throw (a 500 on every subsequent
    // remote read) is now unreachable through the enable functions.
    await expect(resolveActivePath(db)).resolves.not.toBe('none');
    await expect(resolveActivePath(db)).resolves.toMatch(/^(remote|tunnel|direct)$/);
  });

  it('2-way race, every ordered pair of distinct paths: still exactly one winner', async () => {
    const pairs: Array<[() => Promise<unknown>, () => Promise<unknown>]> = [
      [() => enableRemote('pair-rt'), () => enableTunnel('pair-rt')],
      [() => enableTunnel('pair-tr'), () => enableRemote('pair-tr')],
      [() => enableRemote('pair-rd'), enableDirect],
      [enableDirect, () => enableRemote('pair-dr')],
      [() => enableTunnel('pair-td'), enableDirect],
      [enableDirect, () => enableTunnel('pair-dt')],
    ];

    for (const [first, second] of pairs) {
      await disableEverything();
      const results = await Promise.allSettled([first(), second()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect(loser.reason).toBeInstanceOf(RemotePathConflictError);
      await expect(resolveActivePath(db)).resolves.not.toBe('none');
    }
  });

  it('the guard rejects on ANOTHER path only — a sequential enable of an already-active DIFFERENT path is the same rejection', async () => {
    await enableRemote('sequential');
    await expect(enableTunnel('sequential')).rejects.toBeInstanceOf(RemotePathConflictError);
    await expect(enableTunnel('sequential')).rejects.toMatchObject({ activePath: 'remote', attemptedPath: 'tunnel' });
    expect(await resolveActivePath(db)).toBe('remote');
  });
});

describe('LD-9 — the guard does not over-lock', () => {
  it('concurrent enables of the SAME path both succeed (idempotent re-enable stays contractual)', async () => {
    const results = await Promise.allSettled([enableRemote('same-1'), enableRemote('same-2')]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await resolveActivePath(db)).toBe('remote');
  });
});

describe('LD-9 §3 — release guarantee: a thrown body can never leave the lock held', () => {
  it('a guarded body that throws releases the advisory lock (PostgreSQL rolls it back), and the NEXT enable proceeds', async () => {
    const boom = new Error('simulated external side effect blowing up inside the guarded region');
    await expect(withRemotePathEnableGuard(db, 'tunnel', async () => Promise.reject(boom))).rejects.toBe(boom);

    // Nothing is holding the lock any more — checked, not assumed.
    expect(await advisoryLockCount()).toBe(0);

    // ...and the next enable is not blocked by the corpse of the last one.
    await enableRemote('after-throw');
    expect(await resolveActivePath(db)).toBe('remote');
    expect(await advisoryLockCount()).toBe(0);
  });

  it('a guarded body that REJECTS with the conflict error also leaves nothing held, and the winner is untouched', async () => {
    await enableDirect();
    await expect(enableTunnel('conflict-release')).rejects.toBeInstanceOf(RemotePathConflictError);
    expect(await advisoryLockCount()).toBe(0);
    expect(await resolveActivePath(db)).toBe('direct');

    // Recovery is immediate: disable the winner, the loser's path enables.
    await disableRemoteDirectStateAndEmit(db, { actorUserId: adminId, nowMs });
    await enableTunnel('conflict-release-retry');
    expect(await resolveActivePath(db)).toBe('tunnel');
  });
});

describe('LD-9 §7 — disable and recovery can never be blocked by the enable lock', () => {
  it('while an INDEPENDENT session holds the guard lock, all three disables and resolveActivePath still complete', async () => {
    await enableRemote('disable-under-lock');

    const holder = createDb(DATABASE_URL);
    try {
      await holder.transaction().execute(async (trx) => {
        // The exact lock withRemotePathEnableGuard takes, held for the whole
        // callback by a session this test controls.
        await sql`SELECT pg_advisory_xact_lock(hashtext(${REMOTE_PATH_ENABLE_LOCK_KEY_FOR_TESTS})::bigint)`.execute(trx);
        expect(await advisoryLockCount()).toBeGreaterThan(0);

        // Reads: never guarded.
        expect(await resolveActivePath(db)).toBe('remote');

        // Recovery: every disable path, on a separate pool connection, with
        // the lock demonstrably held. Any lock acquisition here would block
        // until this transaction commits — i.e. forever, from this test's
        // point of view, and the suite timeout would fire.
        await disableRemoteWireguardAndEmit(db, { actorUserId: adminId, nowMs });
        await disableTunnelStateAndEmit(db, { actorUserId: adminId, nowMs });
        await disableRemoteDirectStateAndEmit(db, { actorUserId: adminId, nowMs });

        expect(await resolveActivePath(db)).toBe('none');
      });
    } finally {
      await holder.destroy();
    }

    expect(await advisoryLockCount()).toBe(0);
  });
});

describe('LD-9 §9 — the RG15 invariant throw survives as defense-in-depth', () => {
  it('is still reachable when a writer BYPASSES this package entirely (raw SQL), proving it was not deleted along with the race', async () => {
    // Deliberately NOT via the enable functions — the guard makes that
    // impossible now, which is the whole point. This is the "direct SQL /
    // restored inconsistent backup / future fourth path" case the design
    // note §9 names as the only remaining way in.
    await enableRemote('invariant-defense');
    await sql`UPDATE remote_tunnel_state SET enabled = true WHERE id = 1`.execute(db);

    await expect(resolveActivePath(db)).rejects.toBeInstanceOf(RemoteActivePathInvariantViolationError);

    await sql`UPDATE remote_tunnel_state SET enabled = false WHERE id = 1`.execute(db);
    await disableRemoteWireguardAndEmit(db, { actorUserId: adminId, nowMs });
    expect(await resolveActivePath(db)).toBe('none');
  });
});
