// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/remote-active-path.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, lane WG2). Truth-table coverage
// for src/query/remote-active-path.ts — the canonical resolveActivePath()
// every sibling lane's own isolated seam now delegates to (see that file's
// own header for the full list).
//
// deriveActivePath (pure, 8 combinations of the three subsystems' own
// `enabled` booleans) needs no DB; resolveActivePath (the live composition
// across all three real tables/rows) uses the same self-sufficient
// reset+reseed pattern as remote-tunnel.spec.ts/remote-direct.spec.ts.
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
import {
  deriveActivePath,
  resolveActivePath,
  RemoteActivePathInvariantViolationError,
  type RemoteActivePathFlags,
} from '../src/query/remote-active-path.js';
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

describe('deriveActivePath — pure truth table (8 combinations)', () => {
  const cases: Array<{ flags: RemoteActivePathFlags; expected: 'none' | 'remote' | 'tunnel' | 'direct' | 'throws' }> = [
    { flags: { remote: false, tunnel: false, direct: false }, expected: 'none' },
    { flags: { remote: true, tunnel: false, direct: false }, expected: 'remote' },
    { flags: { remote: false, tunnel: true, direct: false }, expected: 'tunnel' },
    { flags: { remote: false, tunnel: false, direct: true }, expected: 'direct' },
    { flags: { remote: true, tunnel: true, direct: false }, expected: 'throws' },
    { flags: { remote: true, tunnel: false, direct: true }, expected: 'throws' },
    { flags: { remote: false, tunnel: true, direct: true }, expected: 'throws' },
    { flags: { remote: true, tunnel: true, direct: true }, expected: 'throws' },
  ];

  for (const { flags, expected } of cases) {
    it(`remote=${flags.remote} tunnel=${flags.tunnel} direct=${flags.direct} -> ${expected}`, () => {
      if (expected === 'throws') {
        expect(() => deriveActivePath(flags)).toThrow(RemoteActivePathInvariantViolationError);
      } else {
        expect(deriveActivePath(flags)).toBe(expected);
      }
    });
  }
});

describe('resolveActivePath — live composition across remote_wireguard_state/remote_tunnel_state/Direct internal state', () => {
  const nowMs = 1_700_000_000_000;

  it("fresh reseeded DB: 'none' (nothing enabled anywhere)", async () => {
    expect(await resolveActivePath(db)).toBe('none');
  });

  it('WireGuard enabled -> remote; disabled again -> none', async () => {
    await enableRemoteWireguardAndEmit(db, { serverPublicKey: 'test-active-path-key-1', actorUserId: adminId, nowMs });
    expect(await resolveActivePath(db)).toBe('remote');
    await disableRemoteWireguardAndEmit(db, { actorUserId: adminId, nowMs });
    expect(await resolveActivePath(db)).toBe('none');
  });

  it('Tunnel enabled -> tunnel; disabled again -> none', async () => {
    await enableTunnelStateAndEmit(db, {
      hostname: 'media.example.com',
      tunnelId: 'active-path-tunnel-1',
      accountId: 'acct-1',
      zoneId: 'zone-1',
      dnsRecordId: 'record-1',
      actorUserId: adminId,
      nowMs,
    });
    expect(await resolveActivePath(db)).toBe('tunnel');
    await disableTunnelStateAndEmit(db, { actorUserId: adminId, nowMs });
    expect(await resolveActivePath(db)).toBe('none');
  });

  it('Direct enabled -> direct; disabled again -> none', async () => {
    await enableRemoteDirectStateAndEmit(db, {
      mode: 'reverse-proxy',
      preEnableTlsMode: 'off',
      preEnableTrustProxy: '',
      previousActivePath: 'none',
      actorUserId: adminId,
      nowMs,
    });
    expect(await resolveActivePath(db)).toBe('direct');
    await disableRemoteDirectStateAndEmit(db, { actorUserId: adminId, nowMs });
    expect(await resolveActivePath(db)).toBe('none');
  });

  it('INVARIANT VIOLATION: two subsystems observed enabled simultaneously throws loudly rather than picking one (proves the safety net — the real staged enable flows are what should make this unreachable in production)', async () => {
    await enableRemoteWireguardAndEmit(db, { serverPublicKey: 'test-active-path-key-2', actorUserId: adminId, nowMs });
    await enableTunnelStateAndEmit(db, {
      hostname: 'media.example.com',
      tunnelId: 'active-path-tunnel-2',
      accountId: 'acct-2',
      zoneId: 'zone-2',
      dnsRecordId: 'record-2',
      actorUserId: adminId,
      nowMs,
    });

    await expect(resolveActivePath(db)).rejects.toThrow(RemoteActivePathInvariantViolationError);

    await disableRemoteWireguardAndEmit(db, { actorUserId: adminId, nowMs });
    await disableTunnelStateAndEmit(db, { actorUserId: adminId, nowMs });
    expect(await resolveActivePath(db)).toBe('none');
  });
});
