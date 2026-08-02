// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/user-self-collision-and-revocation-event.spec.ts
//
// Live-DB tests for G6 (email-collision silent no-op on updateUserSelf,
// replacing a live uncaught-23505 500), G5 (the `session.revoked-by-
// password-change` outbox event, F3), and G9 (updateUserAdmin's new 409
// conflict result instead of the same uncaught-23505 500) — STATE.md
// "Current-password re-auth on self-changes".
//
// SELF-SUFFICIENT (resets + reseeds its own DB in beforeAll), same
// convention as outbox-emission.spec.ts / user-email-displayname.spec.ts.
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
import { createUserAdmin, updateUserAdmin, updateUserSelf } from '../src/query/admin.js';
import { createDevice, insertRefreshToken } from '../src/query/identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loombre:loombre@localhost:5442/loombre';

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

interface RawEventRow {
  type: string;
  ts_ms: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
}

async function eventsOfType(type: string): Promise<RawEventRow[]> {
  const { rows } = await rawClient.query<RawEventRow>(
    'SELECT type, ts_ms, actor_user_id, payload FROM events WHERE type = $1 ORDER BY id ASC',
    [type],
  );
  return rows;
}

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

describe('updateUserSelf email collision (G6) — silent no-op, other members still apply', () => {
  it('re-setting your OWN current address is never a collision', async () => {
    const user = await createUserAdmin(db, {
      username: 'self-collision-own-address',
      email: 'own@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 1_000,
    });

    const result = await updateUserSelf(db, user.id, { email: 'own@example.invalid', nowMs: 1_100 });
    expect(result?.collidedEmail).toBeNull();
    expect(result?.user.email).toBe('own@example.invalid');
  });

  it('a collision with ANOTHER account silently drops ONLY the email member; displayName in the same request still applies; generic success either way', async () => {
    await createUserAdmin(db, {
      username: 'self-collision-victim',
      email: 'taken@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 2_000,
    });
    const attacker = await createUserAdmin(db, {
      username: 'self-collision-attacker',
      email: 'attacker-original@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 2_001,
    });

    const result = await updateUserSelf(db, attacker.id, {
      email: 'taken@example.invalid',
      displayName: 'New Display Name',
      nowMs: 2_100,
    });

    expect(result).toBeDefined();
    expect(result?.collidedEmail).toBe('taken@example.invalid');
    // The email member was dropped — the attacker's OWN original address is untouched.
    expect(result?.user.email).toBe('attacker-original@example.invalid');
    // Every OTHER member in the SAME request still applied.
    expect(result?.user.display_name).toBe('New Display Name');
  });

  it('a bare email-only collision (no other members) still returns a normal success shape', async () => {
    const attacker2 = await createUserAdmin(db, {
      username: 'self-collision-attacker-2',
      email: 'attacker2-original@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 2_200,
    });

    const result = await updateUserSelf(db, attacker2.id, { email: 'taken@example.invalid', nowMs: 2_300 });
    expect(result).toBeDefined();
    expect(result?.collidedEmail).toBe('taken@example.invalid');
    expect(result?.user.email).toBe('attacker2-original@example.invalid');
  });

  it('no collision when the address is genuinely free', async () => {
    const user = await createUserAdmin(db, {
      username: 'self-collision-free',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 2_400,
    });

    const result = await updateUserSelf(db, user.id, { email: 'brand-new-free@example.invalid', nowMs: 2_500 });
    expect(result?.collidedEmail).toBeNull();
    expect(result?.user.email).toBe('brand-new-free@example.invalid');
  });
});

describe('session.revoked-by-password-change event (G5/F3)', () => {
  it('emitted in the SAME transaction as a self-service password change, payload {userId, username, revokedCount}, ADMIN_ONLY-shaped (never a token/hash)', async () => {
    const user = await createUserAdmin(db, {
      username: 'revocation-event-user',
      email: 'revocation-event@example.invalid',
      passwordHash: 'old-hash',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 3_000,
    });

    // Two OTHER devices with live refresh tokens, plus the caller's own
    // "current" device (excluded from the revoke, F5 precedent).
    const deviceB = await createDevice(db, { userId: user.id, name: 'device-b', platform: null, profile: {}, nowMs: 3_001 });
    const deviceC = await createDevice(db, { userId: user.id, name: 'device-c', platform: null, profile: {}, nowMs: 3_002 });
    const currentDevice = await createDevice(db, { userId: user.id, name: 'current-device', platform: null, profile: {}, nowMs: 3_003 });
    await insertRefreshToken(db, { userId: user.id, deviceId: deviceB.id, tokenHash: 'hash-b', issuedAtMs: 3_004, expiresAtMs: 9_999_999, rotatedFrom: null });
    await insertRefreshToken(db, { userId: user.id, deviceId: deviceC.id, tokenHash: 'hash-c', issuedAtMs: 3_005, expiresAtMs: 9_999_999, rotatedFrom: null });
    await insertRefreshToken(db, { userId: user.id, deviceId: currentDevice.id, tokenHash: 'hash-current', issuedAtMs: 3_006, expiresAtMs: 9_999_999, rotatedFrom: null });

    const before = (await eventsOfType('session.revoked-by-password-change')).length;

    const result = await updateUserSelf(db, user.id, {
      passwordHash: 'new-hash',
      currentDeviceId: currentDevice.id,
      nowMs: 3_100,
    });
    expect(result).toBeDefined();

    const rows = await eventsOfType('session.revoked-by-password-change');
    expect(rows).toHaveLength(before + 1);
    const row = rows[rows.length - 1]!;
    expect(Number(row.ts_ms)).toBe(3_100);
    expect(row.actor_user_id).toBe(user.id);
    expect(row.payload).toEqual({
      userId: user.id,
      username: 'revocation-event-user',
      revokedCount: 2, // deviceB + deviceC, NOT currentDevice
    });
  });

  it('NOT emitted when the update carries no password member (bare profile save)', async () => {
    const user = await createUserAdmin(db, {
      username: 'no-password-no-event',
      email: 'no-password-no-event@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 4_000,
    });

    const before = (await eventsOfType('session.revoked-by-password-change')).length;
    await updateUserSelf(db, user.id, { displayName: 'Just A Name Change', nowMs: 4_100 });
    expect(await eventsOfType('session.revoked-by-password-change')).toHaveLength(before);
  });
});

describe('password_changed_at_ms epoch (R-F7, opus adversarial review fix wave)', () => {
  it('set to nowMs when the update carries a password member; untouched (stays null) for a bare profile save', async () => {
    const user = await createUserAdmin(db, {
      username: 'epoch-user',
      email: 'epoch-user@example.invalid',
      passwordHash: 'old-hash',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 7_000,
    });
    expect(user.password_changed_at_ms).toBeNull();

    const afterProfileSave = await updateUserSelf(db, user.id, { displayName: 'Still No Password Change', nowMs: 7_100 });
    expect(afterProfileSave?.user.password_changed_at_ms).toBeNull();

    const afterPasswordChange = await updateUserSelf(db, user.id, { passwordHash: 'new-hash', nowMs: 7_200 });
    expect(afterPasswordChange?.user.password_changed_at_ms).toBe(7_200);
  });
});

describe('updateUserSelf 23505 backstop (R-F6, opus adversarial review fix wave) — the retry survives a REAL race, not just the deterministic pre-SELECT case', () => {
  it('two concurrent updateUserSelf calls racing the SAME free address: neither throws, exactly one keeps it, the loser is a clean silent drop', async () => {
    const a = await createUserAdmin(db, {
      username: 'r-f6-racer-a',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 6_000,
    });
    const b = await createUserAdmin(db, {
      username: 'r-f6-racer-b',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 6_001,
    });

    // Both pre-SELECTs observe the address as free (neither the other
    // party's row exists yet) — only ONE of the two concurrent UPDATEs can
    // win the users_email_key unique constraint; the loser must hit the
    // OUTER retry (a fresh transaction, not a second statement on the
    // aborted one — that was R-F6's actual bug) and complete with the
    // email member cleanly dropped, never an uncaught 500.
    const target = 'r-f6-race-target@example.invalid';
    const [resultA, resultB] = await Promise.all([
      updateUserSelf(db, a.id, { email: target, nowMs: 6_100 }),
      updateUserSelf(db, b.id, { email: target, nowMs: 6_100 }),
    ]);

    expect(resultA, 'the loser must resolve, never throw/reject').toBeDefined();
    expect(resultB, 'the loser must resolve, never throw/reject').toBeDefined();

    const aGotIt = resultA!.user.email === target;
    const bGotIt = resultB!.user.email === target;
    expect(aGotIt !== bGotIt, 'exactly one racer ends up with the address').toBe(true);
    expect(aGotIt ? resultB!.collidedEmail : resultA!.collidedEmail).toBe(target);
    expect(aGotIt ? resultA!.collidedEmail : resultB!.collidedEmail).toBeNull();
  });
});

describe('updateUserAdmin email conflict (G9) — a proper 409-shaped result instead of an uncaught 500', () => {
  it('a genuine email collision returns {ok:false, reason:"email-conflict"}, not a throw', async () => {
    await createUserAdmin(db, {
      username: 'admin-conflict-victim',
      email: 'admin-taken@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 5_000,
    });
    const target = await createUserAdmin(db, {
      username: 'admin-conflict-target',
      email: 'admin-original@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 5_001,
    });

    const result = await updateUserAdmin(db, target.id, { email: 'admin-taken@example.invalid', nowMs: 5_100 });
    expect(result).toEqual({ ok: false, reason: 'email-conflict' });
  });

  it('a genuinely unknown id returns {ok:false, reason:"not-found"}', async () => {
    const result = await updateUserAdmin(db, '018f6f1e-0000-7000-8000-0000000000ff', { displayName: 'x', nowMs: 5_200 });
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('a non-colliding update returns {ok:true, user}', async () => {
    const target = await createUserAdmin(db, {
      username: 'admin-conflict-happy',
      email: 'admin-happy@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 5_300,
    });
    const result = await updateUserAdmin(db, target.id, { displayName: 'Happy Path', nowMs: 5_400 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.display_name).toBe('Happy Path');
    }
  });
});
