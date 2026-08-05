// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/remote-probes.spec.ts
//
// Live-DB tests for src/query/remote-probes.ts — Loombre Remote's
// one-time-token reachability proof (STATE.md "Loombre Remote — embedded
// WireGuard + three-path wizard + reachability proof + posture card",
// R6/RG6, Lane P1). Same self-sufficient pattern as password-reset.spec.ts:
// resets + reseeds the live DB in beforeAll so `vitest run` alone is
// enough from a fresh database.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { getUserByUsername } from '../src/query/identity.js';
import {
  consumeProbeTokenAndEmit,
  deriveProbeStatus,
  getProbeTokenById,
  mintProbeToken,
} from '../src/query/remote-probes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

let db: Kysely<DB>;
let rawClient: pg.Client;
let adminId: string;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();
  const admin = await getUserByUsername(db, 'admin');
  adminId = admin!.id;
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

interface RawEventRow {
  type: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
}

async function latestEventOfType(type: string): Promise<RawEventRow | undefined> {
  const { rows } = await rawClient.query<RawEventRow>(
    'SELECT type, actor_user_id, payload FROM events WHERE type = $1 ORDER BY id DESC LIMIT 1',
    [type]
  );
  return rows[0];
}

describe('mintProbeToken', () => {
  it('inserts a fresh, unarrived row', async () => {
    const row = await mintProbeToken(db, {
      tokenHash: 'hash-mint-1',
      expectedEndpoint: 'loombre.example.com',
      path: 'direct',
      createdBy: adminId,
      createdAtMs: 1_000,
      expiresAtMs: 1_000 + 15 * 60 * 1000,
    });
    expect(row.token_hash).toBe('hash-mint-1');
    expect(row.expected_endpoint).toBe('loombre.example.com');
    expect(row.path).toBe('direct');
    expect(row.arrived_at_ms).toBeNull();
  });

  it('getProbeTokenById round-trips the same row', async () => {
    const minted = await mintProbeToken(db, {
      tokenHash: 'hash-mint-roundtrip',
      expectedEndpoint: 'tunnel.example.com',
      path: 'tunnel',
      createdBy: adminId,
      createdAtMs: 2_000,
      expiresAtMs: 2_000 + 15 * 60 * 1000,
    });
    const fetched = await getProbeTokenById(db, minted.id);
    expect(fetched).toEqual(minted);
  });

  it('getProbeTokenById returns undefined for an unknown id', async () => {
    const fetched = await getProbeTokenById(db, '018f6f1e-0000-7000-8000-0000000000ff');
    expect(fetched).toBeUndefined();
  });
});

describe('deriveProbeStatus', () => {
  it('pending: not arrived, not yet expired', () => {
    expect(deriveProbeStatus({ arrivedAtMs: null, expiresAtMs: 10_000 }, 5_000)).toBe('pending');
  });
  it('expired: not arrived, expiry passed', () => {
    expect(deriveProbeStatus({ arrivedAtMs: null, expiresAtMs: 10_000 }, 10_000)).toBe('expired');
    expect(deriveProbeStatus({ arrivedAtMs: null, expiresAtMs: 10_000 }, 15_000)).toBe('expired');
  });
  it('arrived wins over expired (arrival in the final second is still a success)', () => {
    expect(deriveProbeStatus({ arrivedAtMs: 9_999, expiresAtMs: 10_000 }, 20_000)).toBe('arrived');
  });
});

describe('consumeProbeTokenAndEmit (R6/RG6/R9 — atomic single-use consume + emit)', () => {
  it('happy path: consumes the token, sets arrived_at_ms, emits probe.arrived with NO token/hash/expectedEndpoint in the payload, actorUserId null', async () => {
    const minted = await mintProbeToken(db, {
      tokenHash: 'hash-consume-happy',
      expectedEndpoint: 'loombre.example.com',
      path: 'direct',
      createdBy: adminId,
      createdAtMs: 10_000,
      expiresAtMs: 10_000 + 15 * 60 * 1000,
    });

    const result = await consumeProbeTokenAndEmit(db, { tokenHash: 'hash-consume-happy', nowMs: 11_000 });
    expect(result).toEqual({ ok: true, row: expect.objectContaining({ id: minted.id, arrived_at_ms: 11_000 }) });

    const event = await latestEventOfType('probe.arrived');
    expect(event).toBeTruthy();
    expect(event!.payload).toEqual({ probeId: minted.id, arrivedAtMs: 11_000 });
    expect(event!.actor_user_id).toBeNull();
    expect(JSON.stringify(event!.payload)).not.toContain('hash-consume-happy');
    expect(JSON.stringify(event!.payload)).not.toContain('loombre.example.com');
  });

  it('replay: using the SAME token twice — second attempt fails (already arrived)', async () => {
    await mintProbeToken(db, {
      tokenHash: 'hash-consume-replay',
      expectedEndpoint: 'loombre.example.com',
      path: 'direct',
      createdBy: adminId,
      createdAtMs: 20_000,
      expiresAtMs: 20_000 + 15 * 60 * 1000,
    });

    const first = await consumeProbeTokenAndEmit(db, { tokenHash: 'hash-consume-replay', nowMs: 21_000 });
    expect(first.ok).toBe(true);

    const second = await consumeProbeTokenAndEmit(db, { tokenHash: 'hash-consume-replay', nowMs: 22_000 });
    expect(second).toEqual({ ok: false });
  });

  it('expired token fails (expires_at_ms <= now)', async () => {
    await mintProbeToken(db, {
      tokenHash: 'hash-consume-expired',
      expectedEndpoint: 'loombre.example.com',
      path: 'direct',
      createdBy: adminId,
      createdAtMs: 30_000,
      expiresAtMs: 30_500,
    });

    const result = await consumeProbeTokenAndEmit(db, { tokenHash: 'hash-consume-expired', nowMs: 31_000 });
    expect(result).toEqual({ ok: false });
  });

  it('garbage/never-issued token hash fails, indistinguishably from expired/used', async () => {
    const result = await consumeProbeTokenAndEmit(db, { tokenHash: 'hash-that-was-never-issued', nowMs: 40_000 });
    expect(result).toEqual({ ok: false });
  });

  it('race: two concurrent consumes of the SAME token — exactly one wins (the atomic UPDATE...WHERE compare-and-swap IS the row lock, no advisory lock needed)', async () => {
    await mintProbeToken(db, {
      tokenHash: 'hash-consume-race',
      expectedEndpoint: 'loombre.example.com',
      path: 'remote',
      createdBy: adminId,
      createdAtMs: 50_000,
      expiresAtMs: 50_000 + 15 * 60 * 1000,
    });

    const [a, b] = await Promise.all([
      consumeProbeTokenAndEmit(db, { tokenHash: 'hash-consume-race', nowMs: 51_000 }),
      consumeProbeTokenAndEmit(db, { tokenHash: 'hash-consume-race', nowMs: 51_000 }),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    // Exactly one probe.arrived event was emitted for this token, not two.
    const { rows } = await rawClient.query(
      `SELECT count(*) AS n FROM events WHERE type = 'probe.arrived' AND payload ->> 'probeId' = $1`,
      [(results.find((r) => r.ok) as { ok: true; row: { id: string } }).row.id]
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
