// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/remote-direct.spec.ts
//
// Live-DB tests for src/query/remote-direct.ts (STATE.md "Loombre
// Remote..." R5/R8/RG15) — self-sufficient, resets+reseeds in beforeAll,
// same convention as settings.spec.ts/notices.spec.ts.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { getUserByUsername } from '../src/query/identity.js';
import {
  REMOTE_DIRECT_DISABLED_STATE,
  disableRemoteDirectStateAndEmit,
  enableRemoteDirectStateAndEmit,
  getRemoteDirectInternalState,
} from '../src/query/remote-direct.js';
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
let rawClient: pg.Client;
let adminUserId: string;

async function latestPathChangedEvent(): Promise<{ payload: Record<string, unknown> } | undefined> {
  const { rows } = await rawClient.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events WHERE type = 'remote.path.changed' ORDER BY ts_ms DESC, id DESC LIMIT 1`,
  );
  return rows[0];
}

async function countEventsByType(type: string): Promise<number> {
  const { rows } = await rawClient.query<{ count: string }>(`SELECT COUNT(*) FROM events WHERE type = $1`, [type]);
  return Number(rows[0]!.count);
}

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();
  const admin = await getUserByUsername(db, 'admin');
  if (!admin) throw new Error('seed did not create the expected admin user');
  adminUserId = admin.id;
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

describe('getRemoteDirectInternalState', () => {
  it('returns REMOTE_DIRECT_DISABLED_STATE when no row has ever been written', async () => {
    const state = await getRemoteDirectInternalState(db);
    expect(state).toEqual(REMOTE_DIRECT_DISABLED_STATE);
  });
});

describe('enableRemoteDirectStateAndEmit / disableRemoteDirectStateAndEmit', () => {
  afterEach(async () => {
    // Leave a clean slate for later tests/files sharing this DB.
    await disableRemoteDirectStateAndEmit(db, { actorUserId: adminUserId, nowMs: Date.now() });
  });

  it('enable persists enabled:true + mode + the pre-enable snapshot, in ONE transaction with exactly one remote.path.changed event', async () => {
    const before = await countEventsByType('remote.path.changed');
    const nowMs = Date.now();

    await enableRemoteDirectStateAndEmit(db, {
      mode: 'acme',
      preEnableTlsMode: 'off',
      preEnableTrustProxy: '',
      previousActivePath: 'none',
      actorUserId: adminUserId,
      nowMs,
    });

    const state = await getRemoteDirectInternalState(db);
    expect(state).toEqual({ enabled: true, mode: 'acme', preEnableTlsMode: 'off', preEnableTrustProxy: '' });

    const after = await countEventsByType('remote.path.changed');
    expect(after).toBe(before + 1);

    const event = await latestPathChangedEvent();
    expect(event!.payload).toEqual({ previousPath: 'none', newPath: 'direct', changedAtMs: nowMs });
  });

  it('a second enable call (re-entry) upserts in place — no duplicate row, exactly one MORE event', async () => {
    await enableRemoteDirectStateAndEmit(db, {
      mode: 'acme',
      preEnableTlsMode: 'off',
      preEnableTrustProxy: '',
      previousActivePath: 'none',
      actorUserId: adminUserId,
      nowMs: Date.now(),
    });
    const before = await countEventsByType('remote.path.changed');

    await enableRemoteDirectStateAndEmit(db, {
      mode: 'reverse-proxy',
      preEnableTlsMode: 'off',
      preEnableTrustProxy: '',
      previousActivePath: 'direct',
      actorUserId: adminUserId,
      nowMs: Date.now(),
    });

    const state = await getRemoteDirectInternalState(db);
    expect(state.mode).toBe('reverse-proxy');
    expect(await countEventsByType('remote.path.changed')).toBe(before + 1);
  });

  it('disable reverts to REMOTE_DIRECT_DISABLED_STATE and emits direct -> none', async () => {
    await enableRemoteDirectStateAndEmit(db, {
      mode: 'reverse-proxy',
      preEnableTlsMode: 'off',
      preEnableTrustProxy: 'loopback',
      previousActivePath: 'none',
      actorUserId: adminUserId,
      nowMs: Date.now(),
    });

    const nowMs = Date.now();
    await disableRemoteDirectStateAndEmit(db, { actorUserId: adminUserId, nowMs });

    const state = await getRemoteDirectInternalState(db);
    expect(state).toEqual(REMOTE_DIRECT_DISABLED_STATE);

    const event = await latestPathChangedEvent();
    expect(event!.payload).toEqual({ previousPath: 'direct', newPath: 'none', changedAtMs: nowMs });
  });

  it('disabling when already disabled is still a well-formed write (idempotent at the STATE layer — the controller layer is what skips the call entirely when already disabled)', async () => {
    await disableRemoteDirectStateAndEmit(db, { actorUserId: adminUserId, nowMs: Date.now() });
    const state = await getRemoteDirectInternalState(db);
    expect(state).toEqual(REMOTE_DIRECT_DISABLED_STATE);
  });
});

// isRemoteWireguardActive's own describe block (D1's WG-only, defensively-
// raw-SQL "simulate WG1 having landed" tests) REMOVED by WG2: the function
// itself is gone (see src/query/remote-direct.ts's own note at the spot it
// used to live) — superseded by packages/db/test/remote-active-path.spec.ts,
// which tests the REAL canonical resolveActivePath() against the REAL
// remote_wireguard_state/remote_tunnel_state tables now that both actually
// exist on this integrated branch (a raw `CREATE TABLE remote_wireguard_state`
// here would now collide with the real one from migrations/0029).
