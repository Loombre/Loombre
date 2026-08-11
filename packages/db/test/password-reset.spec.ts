// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/password-reset.spec.ts
//
// Live-DB tests for src/query/password-reset.ts — self-service password
// recovery, email tier (E3b/M15, STATE.md "Optional mail transport +
// invitation & reset flows"). Same self-sufficient pattern as
// identity.spec.ts: resets + reseeds the live DB in beforeAll so
// `vitest run` alone is enough from a fresh database.
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
import {
  createDevice,
  findRefreshTokenByHash,
  getUserByUsername,
  insertRefreshToken,
} from '../src/query/identity.js';
import {
  invalidateUnusedPasswordResetTokens,
  issuePasswordResetToken,
  resetPasswordViaTokenAndEmit,
} from '../src/query/password-reset.js';
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
    throw new Error(
      `${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

let db: Kysely<DB>;
let rawClient: pg.Client;

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

async function latestUserEvent(
  type: string,
  userId: string
): Promise<{ payload: Record<string, unknown>; actor_user_id: string | null } | undefined> {
  const { rows } = await rawClient.query<{ payload: Record<string, unknown>; actor_user_id: string | null }>(
    `SELECT payload, actor_user_id FROM events WHERE type = $1 AND payload ->> 'userId' = $2 ORDER BY ts_ms DESC LIMIT 1`,
    [type, userId]
  );
  return rows[0];
}

// packages/db/src/db.ts registers a process-wide pg type parser for OID 20
// (int8/BIGINT) that returns a JS `number` (not the pg-driver default
// string) — imported transitively via `createDb` above, so these BIGINT
// columns come back as numbers here too, same as through the Kysely handle.
async function findTokenRow(tokenHash: string) {
  const { rows } = await rawClient.query(
    `SELECT id, user_id, token_hash, created_at_ms, expires_at_ms, used_at_ms FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  return rows[0] as
    | { id: string; user_id: string; token_hash: string; created_at_ms: number; expires_at_ms: number; used_at_ms: number | null }
    | undefined;
}

describe('issuePasswordResetToken (E3b/M15)', () => {
  it('inserts a fresh, unused token row', async () => {
    const casual = await getUserByUsername(db, 'casual');
    const row = await issuePasswordResetToken(db, {
      userId: casual!.id,
      tokenHash: 'hash-issue-1',
      createdAtMs: 1_000,
      expiresAtMs: 1_000 + 30 * 60 * 1000,
    });
    expect(row.user_id).toBe(casual!.id);
    expect(row.token_hash).toBe('hash-issue-1');
    expect(row.used_at_ms).toBeNull();
  });

  it('invalidates every previously-issued unused token for the SAME user when a new one is issued, and (F10, fix wave) opportunistically PURGES it in the same pass', async () => {
    const casual = await getUserByUsername(db, 'casual');
    const userId = casual!.id;

    await issuePasswordResetToken(db, {
      userId,
      tokenHash: 'hash-supersede-old',
      createdAtMs: 2_000,
      expiresAtMs: 2_000 + 30 * 60 * 1000,
    });
    await issuePasswordResetToken(db, {
      userId,
      tokenHash: 'hash-supersede-new',
      createdAtMs: 3_000,
      expiresAtMs: 3_000 + 30 * 60 * 1000,
    });

    // F10: invalidateUnusedPasswordResetTokens marks the old row used, and
    // purgeExpiredOrUsedPasswordResetTokens (same transaction, same call)
    // deletes it in that same pass — the row doesn't linger as a
    // used-but-present row the way it used to; it's gone outright.
    const oldRow = await findTokenRow('hash-supersede-old');
    const newRow = await findTokenRow('hash-supersede-new');
    expect(oldRow).toBeUndefined();
    expect(newRow?.used_at_ms).toBeNull();
  });

  it('does NOT touch a DIFFERENT user\'s tokens', async () => {
    const casual = await getUserByUsername(db, 'casual');
    const admin = await getUserByUsername(db, 'admin');

    await issuePasswordResetToken(db, {
      userId: admin!.id,
      tokenHash: 'hash-cross-user-admin',
      createdAtMs: 4_000,
      expiresAtMs: 4_000 + 30 * 60 * 1000,
    });
    await issuePasswordResetToken(db, {
      userId: casual!.id,
      tokenHash: 'hash-cross-user-casual',
      createdAtMs: 5_000,
      expiresAtMs: 5_000 + 30 * 60 * 1000,
    });

    const adminRow = await findTokenRow('hash-cross-user-admin');
    expect(adminRow?.used_at_ms).toBeNull();
  });
});

describe('invalidateUnusedPasswordResetTokens (anti-timing dummy-branch reuse — apps/server/src/session/auth.controller.ts forgotPassword)', () => {
  it('a real UPDATE against a nonexistent user id matches zero rows without throwing', async () => {
    await expect(
      invalidateUnusedPasswordResetTokens(db, '018f6f1e-0000-7000-8000-0000000000ff', 6_000)
    ).resolves.toBeUndefined();
  });
});

describe('resetPasswordViaTokenAndEmit (E3b/M15/M12 — atomic consume + password set + revoke + emit)', () => {
  it('happy path: consumes the token, sets the password, revokes every refresh token, clears must_change_password, emits user.password-reset (actor: self-service)', async () => {
    const casual = await getUserByUsername(db, 'casual');
    const userId = casual!.id;
    const device = await createDevice(db, {
      userId,
      name: 'Pre-Self-Reset Device',
      platform: 'web',
      profile: {},
      nowMs: 10_000,
    });
    await insertRefreshToken(db, {
      userId,
      deviceId: device.id,
      tokenHash: 'hash-self-reset-refresh',
      issuedAtMs: 10_000,
      expiresAtMs: 10_000 + 1000,
      rotatedFrom: null,
    });
    await issuePasswordResetToken(db, {
      userId,
      tokenHash: 'hash-self-reset-token',
      createdAtMs: 10_000,
      expiresAtMs: 10_000 + 30 * 60 * 1000,
    });

    const result = await resetPasswordViaTokenAndEmit(db, {
      tokenHash: 'hash-self-reset-token',
      passwordHash: 'new-fake-hash',
      nowMs: 11_000,
    });
    expect(result).toEqual({ ok: true, userId });

    const updated = await getUserByUsername(db, 'casual');
    expect(updated?.password_hash).toBe('new-fake-hash');
    expect(updated?.must_change_password).toBe(false);
    // R-F7 (opus adversarial review, fix wave): the credentials-changed
    // epoch — apps/server/src/gateway/auth.guard.ts's verifyAndAttach.
    expect(updated?.password_changed_at_ms).toBe(11_000);

    const refreshRow = await findRefreshTokenByHash(db, 'hash-self-reset-refresh');
    expect(refreshRow?.revoked_at_ms).toBe(11_000);

    const tokenRow = await findTokenRow('hash-self-reset-token');
    expect(tokenRow?.used_at_ms).toBe(11_000);

    const event = await latestUserEvent('user.password-reset', userId);
    expect(event!.payload).toEqual({ userId, username: 'casual', actor: 'self-service' });
    expect(event!.actor_user_id).toBe(userId);
    expect(JSON.stringify(event!.payload)).not.toContain('new-fake-hash');
  });

  it('replay: using the SAME token a second time fails (already used)', async () => {
    const casual = await getUserByUsername(db, 'casual');
    await issuePasswordResetToken(db, {
      userId: casual!.id,
      tokenHash: 'hash-replay-token',
      createdAtMs: 20_000,
      expiresAtMs: 20_000 + 30 * 60 * 1000,
    });

    const first = await resetPasswordViaTokenAndEmit(db, {
      tokenHash: 'hash-replay-token',
      passwordHash: 'replay-hash-1',
      nowMs: 21_000,
    });
    expect(first.ok).toBe(true);

    const second = await resetPasswordViaTokenAndEmit(db, {
      tokenHash: 'hash-replay-token',
      passwordHash: 'replay-hash-2',
      nowMs: 22_000,
    });
    expect(second).toEqual({ ok: false });
  });

  it('expired token fails (expires_at_ms <= now)', async () => {
    const casual = await getUserByUsername(db, 'casual');
    await issuePasswordResetToken(db, {
      userId: casual!.id,
      tokenHash: 'hash-expired-token',
      createdAtMs: 30_000,
      expiresAtMs: 30_500,
    });

    const result = await resetPasswordViaTokenAndEmit(db, {
      tokenHash: 'hash-expired-token',
      passwordHash: 'expired-hash',
      nowMs: 31_000, // past expires_at_ms
    });
    expect(result).toEqual({ ok: false });
  });

  it('garbage/unknown token hash fails, indistinguishably from expired/used (M12)', async () => {
    const result = await resetPasswordViaTokenAndEmit(db, {
      tokenHash: 'hash-that-was-never-issued',
      passwordHash: 'garbage-hash',
      nowMs: 40_000,
    });
    expect(result).toEqual({ ok: false });
  });

  it('a superseded (invalidated-by-a-newer-request) token also fails, same as used/expired/garbage', async () => {
    const casual = await getUserByUsername(db, 'casual');
    const userId = casual!.id;

    await issuePasswordResetToken(db, {
      userId,
      tokenHash: 'hash-superseded-old',
      createdAtMs: 50_000,
      expiresAtMs: 50_000 + 30 * 60 * 1000,
    });
    // A second forgot-password request invalidates the first token.
    await issuePasswordResetToken(db, {
      userId,
      tokenHash: 'hash-superseded-new',
      createdAtMs: 51_000,
      expiresAtMs: 51_000 + 30 * 60 * 1000,
    });

    const result = await resetPasswordViaTokenAndEmit(db, {
      tokenHash: 'hash-superseded-old',
      passwordHash: 'superseded-hash',
      nowMs: 52_000,
    });
    expect(result).toEqual({ ok: false });
  });

  it('race: two concurrent consumes of the SAME token — exactly one wins', async () => {
    const casual = await getUserByUsername(db, 'casual');
    await issuePasswordResetToken(db, {
      userId: casual!.id,
      tokenHash: 'hash-race-token',
      createdAtMs: 60_000,
      expiresAtMs: 60_000 + 30 * 60 * 1000,
    });

    const [a, b] = await Promise.all([
      resetPasswordViaTokenAndEmit(db, { tokenHash: 'hash-race-token', passwordHash: 'race-hash-a', nowMs: 61_000 }),
      resetPasswordViaTokenAndEmit(db, { tokenHash: 'hash-race-token', passwordHash: 'race-hash-b', nowMs: 61_000 }),
    ]);

    const results = [a, b];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });
});
