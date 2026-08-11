// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/remote-tunnel.spec.ts
//
// Live-DB tests for src/query/remote-tunnel.ts — the Tunnel path's
// singleton state row (STATE.md R4/R9/RG7, lane T1, migrations/
// 0032_remote_tunnel_state.sql). Same self-sufficient pattern as
// email-collision-notice.spec.ts: resets + reseeds the live DB in
// beforeAll so `vitest run` alone is enough from a fresh database.
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
import { disableTunnelStateAndEmit, enableTunnelStateAndEmit, getRemoteTunnelState, recordTunnelConnectorStateEvent } from '../src/query/remote-tunnel.js';
import { getUserByUsername } from '../src/query/identity.js';
import { readUnprocessedEvents } from '../src/query/events.js';
import { resolveTestDatabaseUrl } from '../src/testing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const DATABASE_URL = resolveTestDatabaseUrl();

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
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

describe('getRemoteTunnelState', () => {
  it('the singleton row always exists, seeded disabled', async () => {
    const row = await getRemoteTunnelState(db);
    expect(row).toMatchObject({ enabled: false, hostname: null, tunnel_id: null, account_id: null, zone_id: null, dns_record_id: null, enabled_at_ms: null });
  });
});

describe('enableTunnelStateAndEmit', () => {
  it('sets the row enabled with all five provisioning identifiers, and emits remote.enabled + remote.path.changed (tunnel) in the same transaction', async () => {
    const nowMs = 1_700_000_000_000;
    const row = await enableTunnelStateAndEmit(db, {
      hostname: 'media.example.com',
      tunnelId: 'tunnel-abc',
      accountId: 'acct-1',
      zoneId: 'zone-1',
      dnsRecordId: 'record-1',
      actorUserId: adminId,
      nowMs,
    });
    expect(row).toMatchObject({
      enabled: true,
      hostname: 'media.example.com',
      tunnel_id: 'tunnel-abc',
      account_id: 'acct-1',
      zone_id: 'zone-1',
      dns_record_id: 'record-1',
      enabled_at_ms: nowMs,
    });

    const persisted = await getRemoteTunnelState(db);
    expect(persisted).toEqual(row);

    const events = await readUnprocessedEvents(db, 500);
    const enabled = events.find((e) => e.type === 'remote.enabled');
    const pathChanged = events.filter((e) => e.type === 'remote.path.changed');
    expect(enabled).toBeDefined();
    expect(enabled!.payload).toEqual({ enabledAtMs: nowMs });
    expect(enabled!.actor_user_id).toBe(adminId);

    const tunnelPathChange = pathChanged.find((e) => (e.payload as { newPath?: string }).newPath === 'tunnel');
    expect(tunnelPathChange).toBeDefined();
    expect(tunnelPathChange!.payload).toEqual({ previousPath: 'none', newPath: 'tunnel', changedAtMs: nowMs });

    // R9: no secrets in any payload — the token/connector credentials
    // never touch this table or these events at all.
    for (const e of [enabled, tunnelPathChange]) {
      expect(JSON.stringify(e!.payload)).not.toMatch(/token|secret|credential/i);
    }
  });
});

describe('disableTunnelStateAndEmit', () => {
  it('clears all five identifiers together and emits remote.disabled + remote.path.changed (none)', async () => {
    const nowMs = 1_700_000_100_000;
    const row = await disableTunnelStateAndEmit(db, { actorUserId: adminId, nowMs });
    expect(row).toEqual({
      id: 1,
      enabled: false,
      hostname: null,
      tunnel_id: null,
      account_id: null,
      zone_id: null,
      dns_record_id: null,
      enabled_at_ms: null,
    });

    const events = await readUnprocessedEvents(db, 500);
    const disabled = events.find((e) => e.type === 'remote.disabled' && (e.payload as { disabledAtMs?: number }).disabledAtMs === nowMs);
    const pathChanged = events.find(
      (e) =>
        e.type === 'remote.path.changed' &&
        (e.payload as { previousPath?: string; newPath?: string }).previousPath === 'tunnel' &&
        (e.payload as { newPath?: string }).newPath === 'none',
    );
    expect(disabled).toBeDefined();
    expect(pathChanged).toBeDefined();
  });

  it('is idempotent — calling again on an already-disabled row is a true no-op (no new events)', async () => {
    const before = await readUnprocessedEvents(db, 1000);
    const row = await disableTunnelStateAndEmit(db, { actorUserId: adminId, nowMs: 1_700_000_200_000 });
    expect(row.enabled).toBe(false);
    const after = await readUnprocessedEvents(db, 1000);
    expect(after.length).toBe(before.length);
  });
});

describe('recordTunnelConnectorStateEvent (WG3, R4/RG7 gap closure)', () => {
  it('writes a tunnel.connector.state event with no actor and the exact frozen payload shape', async () => {
    const nowMs = 1_700_000_500_000;
    await recordTunnelConnectorStateEvent(db, { previousState: 'starting', newState: 'running', changedAtMs: nowMs });

    const events = await readUnprocessedEvents(db, 1000);
    const event = events.find((e) => e.type === 'tunnel.connector.state' && (e.payload as { changedAtMs?: number }).changedAtMs === nowMs);
    expect(event).toBeDefined();
    expect(event!.actor_user_id).toBeNull();
    expect(event!.payload).toEqual({ previousState: 'starting', newState: 'running', changedAtMs: nowMs });
    // R9: no secrets — this payload is exhaustively three fields, verified
    // structurally too (additionalProperties:false at the schema level).
    // Key ORDER is not asserted here — Postgres JSONB round-tripping does
    // not guarantee insertion order is preserved (the `.toEqual` object
    // match above already pins the exact three keys and values).
    expect(Object.keys(event!.payload as object).sort()).toEqual(['changedAtMs', 'newState', 'previousState']);
  });

  it('every frozen contract state value round-trips (stopped|starting|running|degraded|error)', async () => {
    const states = ['stopped', 'starting', 'running', 'degraded', 'error'] as const;
    for (let i = 0; i < states.length - 1; i++) {
      const nowMs = 1_700_000_600_000 + i;
      await recordTunnelConnectorStateEvent(db, { previousState: states[i]!, newState: states[i + 1]!, changedAtMs: nowMs });
      const events = await readUnprocessedEvents(db, 2000);
      const event = events.find((e) => e.type === 'tunnel.connector.state' && (e.payload as { changedAtMs?: number }).changedAtMs === nowMs);
      expect(event!.payload).toEqual({ previousState: states[i], newState: states[i + 1], changedAtMs: nowMs });
    }
  });
});

describe('the CHECK constraint (enabled OR all-identifiers-null)', () => {
  it('enableTunnelStateAndEmit followed by disableTunnelStateAndEmit never leaves a disabled row with a leftover identifier', async () => {
    await enableTunnelStateAndEmit(db, {
      hostname: 'second.example.com',
      tunnelId: 'tunnel-def',
      accountId: 'acct-2',
      zoneId: 'zone-2',
      dnsRecordId: 'record-2',
      actorUserId: adminId,
      nowMs: 1_700_000_300_000,
    });
    const disabled = await disableTunnelStateAndEmit(db, { actorUserId: adminId, nowMs: 1_700_000_400_000 });
    expect(disabled.hostname).toBeNull();
    expect(disabled.tunnel_id).toBeNull();
    expect(disabled.account_id).toBeNull();
    expect(disabled.zone_id).toBeNull();
    expect(disabled.dns_record_id).toBeNull();
  });
});
