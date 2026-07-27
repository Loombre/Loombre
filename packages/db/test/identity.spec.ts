// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/identity.spec.ts
//
// Live-DB tests for src/query/identity.ts — the non-catalog "identity
// plumbing" reads/writes (users, user_settings, library_permissions,
// devices, refresh_tokens) that apps/server's auth layer needs to build a
// ViewerContext (docs/PLAN.md §6.4, STATE.md P1.14). These are deliberately
// NOT catalog_items reads, so they do not go through applyGuard() — see
// src/query/identity.ts's header for why they still belong in the public
// barrel (src/index.ts) rather than @loombre/db/internal: apps/server is
// forbidden from importing the internal subpath (dependency-cruiser rule
// "no-internal-db-outside-worker"), and CLAUDE.md invariant 4's guard
// requirement is specific to catalog_items (restricted-content) reads.
//
// Self-sufficient like leak.spec.ts: resets + reseeds the live DB in
// beforeAll so `vitest run` alone is enough from a fresh database.
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
  createUserAdminAndEmit,
  findRefreshTokenByHash,
  getDeviceById,
  getLibraryPermissionSummary,
  getUserByEmail,
  getUserById,
  getUserByUsername,
  getUserSettings,
  insertRefreshToken,
  resetRestrictedPinAndEmit,
  revokeRefreshTokenChain,
  revokeRefreshTokensForDevice,
  setRestrictedUnlockUntil,
  setRestrictedUnlockUntilAndEmit,
  updateDeviceForLogin,
  updateRestrictedSettings,
  updateUserPrefs,
} from '../src/query/identity.js';

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

/** Most-recent row of `type` for `userId` (payload->>'userId'), or
 *  undefined — mirrors playback-sessions.spec.ts's eventForSession helper. */
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

describe('identity queries (users / user_settings / library_permissions / devices / refresh_tokens)', () => {
  it('getUserByUsername / getUserByEmail / getUserById all resolve the seeded admin identically', async () => {
    const byUsername = await getUserByUsername(db, 'admin');
    expect(byUsername).toBeDefined();
    expect(byUsername?.is_admin).toBe(true);
    expect(byUsername?.birth_date).toBe('1988-03-14');

    const byEmail = await getUserByEmail(db, 'admin@loombre.local');
    expect(byEmail?.id).toBe(byUsername?.id);

    const byId = await getUserById(db, byUsername!.id);
    expect(byId?.username).toBe('admin');
  });

  it('getUserByUsername is case-insensitive (CITEXT) and returns undefined for unknown users', async () => {
    const upper = await getUserByUsername(db, 'ADMIN');
    expect(upper).toBeDefined();
    expect(upper?.username).toBe('admin');

    const missing = await getUserByUsername(db, 'nobody');
    expect(missing).toBeUndefined();
  });

  it('casual user has no birth_date (age-ineligible by construction)', async () => {
    const casual = await getUserByUsername(db, 'casual');
    expect(casual?.birth_date).toBeNull();
  });

  it('getUserSettings reflects seed: admin opted in with a PIN, casual did not', async () => {
    const admin = await getUserByUsername(db, 'admin');
    const casual = await getUserByUsername(db, 'casual');

    const adminSettings = await getUserSettings(db, admin!.id);
    expect(adminSettings?.restricted_opt_in).toBe(true);
    expect(adminSettings?.restricted_pin_hash).not.toBeNull();
    expect(adminSettings?.restricted_unlocked_until_ms).toBeNull();

    const casualSettings = await getUserSettings(db, casual!.id);
    expect(casualSettings?.restricted_opt_in).toBe(false);
    expect(casualSettings?.restricted_pin_hash).toBeNull();
  });

  it('getLibraryPermissionSummary: admin has the restricted library grant, casual does not', async () => {
    const admin = await getUserByUsername(db, 'admin');
    const casual = await getUserByUsername(db, 'casual');

    const adminPerms = await getLibraryPermissionSummary(db, admin!.id);
    expect(adminPerms.generalLibraryIds).toHaveLength(3);
    expect(adminPerms.restrictedLibraryIds).toHaveLength(1);

    const casualPerms = await getLibraryPermissionSummary(db, casual!.id);
    expect(casualPerms.generalLibraryIds).toHaveLength(3);
    expect(casualPerms.restrictedLibraryIds).toHaveLength(0);
  });

  it('updateRestrictedSettings + setRestrictedUnlockUntil round-trip', async () => {
    const casual = await getUserByUsername(db, 'casual');
    const userId = casual!.id;

    const updated = await updateRestrictedSettings(db, {
      userId,
      optIn: true,
      pinHash: 'fake-hash-for-test',
      updatedAtMs: 1_000,
    });
    expect(updated.restricted_opt_in).toBe(true);
    expect(updated.restricted_pin_hash).toBe('fake-hash-for-test');

    await setRestrictedUnlockUntil(db, userId, 2_000, 1_500);
    const afterUnlock = await getUserSettings(db, userId);
    expect(afterUnlock?.restricted_unlocked_until_ms).toBe(2_000);

    await setRestrictedUnlockUntil(db, userId, null, 1_600);
    const afterLock = await getUserSettings(db, userId);
    expect(afterLock?.restricted_unlocked_until_ms).toBeNull();

    // Opt-out clears the PIN hash.
    const optedOut = await updateRestrictedSettings(db, {
      userId,
      optIn: false,
      pinHash: null,
      updatedAtMs: 1_700,
    });
    expect(optedOut.restricted_opt_in).toBe(false);
    expect(optedOut.restricted_pin_hash).toBeNull();
  });

  it('updateUserPrefs writes prefs (H1) without touching restricted_* columns', async () => {
    const casual = await getUserByUsername(db, 'casual');
    const userId = casual!.id;

    // Establish a known restricted_opt_in/pin state first, so we can prove
    // updateUserPrefs below leaves it alone (A-5).
    await updateRestrictedSettings(db, {
      userId,
      optIn: true,
      pinHash: 'pref-test-pin-hash',
      updatedAtMs: 500,
    });

    const written = await updateUserPrefs(db, {
      userId,
      prefs: {
        locale: 'fr-FR',
        theme: 'dark',
        subtitlePreferredLanguage: 'fra',
        audioPreferredLanguage: null,
        autoplayNextEpisode: false,
      },
      updatedAtMs: 1_234,
    });

    expect(written.prefs).toEqual({
      locale: 'fr-FR',
      theme: 'dark',
      subtitlePreferredLanguage: 'fra',
      audioPreferredLanguage: null,
      autoplayNextEpisode: false,
    });
    expect(written.updated_at_ms).toBe(1_234);
    // restricted_* untouched by this writer (A-5).
    expect(written.restricted_opt_in).toBe(true);
    expect(written.restricted_pin_hash).toBe('pref-test-pin-hash');

    const reread = await getUserSettings(db, userId);
    expect(reread?.prefs).toEqual({
      locale: 'fr-FR',
      theme: 'dark',
      subtitlePreferredLanguage: 'fra',
      audioPreferredLanguage: null,
      autoplayNextEpisode: false,
    });
    expect(reread?.restricted_opt_in).toBe(true);
  });

  it('updateUserPrefs REPLACES the whole prefs object, not a partial merge', async () => {
    const casual = await getUserByUsername(db, 'casual');
    const userId = casual!.id;

    await updateUserPrefs(db, {
      userId,
      prefs: { locale: 'en-US', theme: 'system', extra: 'stale-key' },
      updatedAtMs: 1,
    });
    const second = await updateUserPrefs(db, {
      userId,
      prefs: { locale: 'de-DE', theme: 'dark' },
      updatedAtMs: 2,
    });

    expect(second.prefs).toEqual({ locale: 'de-DE', theme: 'dark' });
    expect(second.prefs).not.toHaveProperty('extra');
  });

  it('createDevice / getDeviceById round-trip', async () => {
    const admin = await getUserByUsername(db, 'admin');
    const device = await createDevice(db, {
      userId: admin!.id,
      name: 'Test Device',
      platform: 'web',
      profile: { profileId: 'web-chrome' },
      nowMs: 5_000,
    });
    expect(device.user_id).toBe(admin!.id);
    expect(device.name).toBe('Test Device');

    const fetched = await getDeviceById(db, device.id);
    expect(fetched?.id).toBe(device.id);
    expect(fetched?.profile).toEqual({ profileId: 'web-chrome' });
  });

  it('updateDeviceForLogin (P2.16 device-row reuse) refreshes profile + last_seen_ms, preserving id/user_id/created_at_ms', async () => {
    const admin = await getUserByUsername(db, 'admin');
    const device = await createDevice(db, {
      userId: admin!.id,
      name: 'Reused Device',
      platform: 'web',
      profile: { profileId: 'web-chrome' },
      nowMs: 5_000,
    });

    const updated = await updateDeviceForLogin(db, device.id, {
      profile: { profileId: 'web-safari' },
      nowMs: 9_000,
    });

    expect(updated.id).toBe(device.id);
    expect(updated.user_id).toBe(admin!.id);
    expect(updated.created_at_ms).toBe(device.created_at_ms);
    expect(updated.profile).toEqual({ profileId: 'web-safari' });
    expect(updated.last_seen_ms).toBe(9_000);
  });

  describe('refresh token rotation chain + reuse (token-theft) revocation', () => {
    it('revokeRefreshTokenChain revokes both ancestors and descendants of the reused token', async () => {
      const admin = await getUserByUsername(db, 'admin');
      const device = await createDevice(db, {
        userId: admin!.id,
        name: 'Chain Test Device',
        platform: 'web',
        profile: {},
        nowMs: 10_000,
      });

      // root -> rotated once -> rotated again (root and middle are revoked
      // by rotation; only the tip is currently active).
      const root = await insertRefreshToken(db, {
        userId: admin!.id,
        deviceId: device.id,
        tokenHash: 'hash-root',
        issuedAtMs: 10_000,
        expiresAtMs: 10_000 + 30 * 24 * 60 * 60 * 1000,
        rotatedFrom: null,
      });
      const middle = await insertRefreshToken(db, {
        userId: admin!.id,
        deviceId: device.id,
        tokenHash: 'hash-middle',
        issuedAtMs: 11_000,
        expiresAtMs: 11_000 + 30 * 24 * 60 * 60 * 1000,
        rotatedFrom: root.id,
      });
      const tip = await insertRefreshToken(db, {
        userId: admin!.id,
        deviceId: device.id,
        tokenHash: 'hash-tip',
        issuedAtMs: 12_000,
        expiresAtMs: 12_000 + 30 * 24 * 60 * 60 * 1000,
        rotatedFrom: middle.id,
      });
      // Simulate normal rotation having revoked root and middle already.
      await db
        .updateTable('refresh_tokens')
        .set({ revoked_at_ms: 11_000 })
        .where('id', '=', root.id)
        .execute();
      await db
        .updateTable('refresh_tokens')
        .set({ revoked_at_ms: 12_000 })
        .where('id', '=', middle.id)
        .execute();

      // Attacker replays the already-rotated `root` token -> theft response:
      // the WHOLE chain (root, middle, and the still-active tip) must die.
      const revokedCount = await revokeRefreshTokenChain(db, root.id, 13_000);
      expect(revokedCount).toBeGreaterThanOrEqual(1); // tip was the only non-revoked row

      const tipRow = await findRefreshTokenByHash(db, 'hash-tip');
      expect(tipRow?.revoked_at_ms).toBe(13_000);
    });

    it('revokeRefreshTokensForDevice revokes only that device active tokens (logout)', async () => {
      const admin = await getUserByUsername(db, 'admin');
      const deviceA = await createDevice(db, {
        userId: admin!.id,
        name: 'Device A',
        platform: 'web',
        profile: {},
        nowMs: 20_000,
      });
      const deviceB = await createDevice(db, {
        userId: admin!.id,
        name: 'Device B',
        platform: 'web',
        profile: {},
        nowMs: 20_000,
      });

      await insertRefreshToken(db, {
        userId: admin!.id,
        deviceId: deviceA.id,
        tokenHash: 'hash-device-a',
        issuedAtMs: 20_000,
        expiresAtMs: 20_000 + 1000,
        rotatedFrom: null,
      });
      await insertRefreshToken(db, {
        userId: admin!.id,
        deviceId: deviceB.id,
        tokenHash: 'hash-device-b',
        issuedAtMs: 20_000,
        expiresAtMs: 20_000 + 1000,
        rotatedFrom: null,
      });

      const count = await revokeRefreshTokensForDevice(db, admin!.id, deviceA.id, 21_000);
      expect(count).toBe(1);

      const rowA = await findRefreshTokenByHash(db, 'hash-device-a');
      const rowB = await findRefreshTokenByHash(db, 'hash-device-b');
      expect(rowA?.revoked_at_ms).toBe(21_000);
      expect(rowB?.revoked_at_ms).toBeNull();
    });

    it('findRefreshTokenByHash returns undefined for an unknown hash', async () => {
      const row = await findRefreshTokenByHash(db, 'not-a-real-hash');
      expect(row).toBeUndefined();
    });
  });

  describe('setRestrictedUnlockUntilAndEmit (STATE.md P2.8, restricted.locked/unlocked outbox events)', () => {
    it('unlocking writes restricted.unlocked with payload {userId}; the row still updates identically to the plain setter', async () => {
      const casual = await getUserByUsername(db, 'casual');
      const userId = casual!.id;

      await setRestrictedUnlockUntilAndEmit(db, userId, 50_000, 49_000);
      const settings = await getUserSettings(db, userId);
      expect(settings?.restricted_unlocked_until_ms).toBe(50_000);

      const event = await latestUserEvent('restricted.unlocked', userId);
      expect(event).toBeDefined();
      expect(event!.payload).toEqual({ userId });
      expect(event!.actor_user_id).toBe(userId);
    });

    it('locking (unlockedUntilMs=null) writes restricted.locked with payload {userId}', async () => {
      const casual = await getUserByUsername(db, 'casual');
      const userId = casual!.id;

      await setRestrictedUnlockUntilAndEmit(db, userId, null, 60_000);
      const settings = await getUserSettings(db, userId);
      expect(settings?.restricted_unlocked_until_ms).toBeNull();

      const event = await latestUserEvent('restricted.locked', userId);
      expect(event).toBeDefined();
      expect(event!.payload).toEqual({ userId });
    });

    it('the plain setRestrictedUnlockUntil (used by login, P1.14) never writes an event', async () => {
      const admin = await getUserByUsername(db, 'admin');
      const userId = admin!.id;

      const before = await latestUserEvent('restricted.locked', userId);
      await setRestrictedUnlockUntil(db, userId, null, 70_000);
      const after = await latestUserEvent('restricted.locked', userId);
      // Same row (or both undefined) — no NEW event was written.
      expect(after?.payload).toEqual(before?.payload);
    });
  });

  describe('resetRestrictedPinAndEmit (H2 — server-local CLI admin recovery path, `loombre admin reset-pin <username>`)', () => {
    it('clears opt-in/pin/unlock unconditionally and writes user.restricted-pin-reset (actor: cli, actorUserId: null) when a user_settings row exists', async () => {
      const casual = await getUserByUsername(db, 'casual');
      const userId = casual!.id;

      await updateRestrictedSettings(db, {
        userId,
        optIn: true,
        pinHash: 'fake-hash-for-reset-test',
        updatedAtMs: 80_000,
      });
      await setRestrictedUnlockUntil(db, userId, 90_000, 80_500);

      const result = await resetRestrictedPinAndEmit(db, { userId, username: 'casual', nowMs: 100_000 });
      expect(result).toEqual({ cleared: true });

      const settings = await getUserSettings(db, userId);
      expect(settings?.restricted_opt_in).toBe(false);
      expect(settings?.restricted_pin_hash).toBeNull();
      expect(settings?.restricted_unlocked_until_ms).toBeNull();

      const event = await latestUserEvent('user.restricted-pin-reset', userId);
      expect(event).toBeDefined();
      expect(event!.payload).toEqual({ userId, username: 'casual', actor: 'cli' });
      // The CLI has no user id of its own — the payload's `actor: 'cli'`
      // field carries that truth, never the envelope's actorUserId (see
      // this function's doc comment).
      expect(event!.actor_user_id).toBeNull();
    });

    it('is a no-op — no row touched, NO event emitted — for a user with no user_settings row at all (never opted in)', async () => {
      // A fresh admin-created user gets no user_settings row automatically
      // (no DB-level auto-create trigger — see updateRestrictedSettings's
      // own doc comment above), so this exercises the true "never opted
      // in" case rather than an opted-out-with-a-row one.
      const created = await createUserAdminAndEmit(db, {
        username: 'reset-noop-user',
        email: 'reset-noop-user@example.invalid',
        passwordHash: 'not-a-real-hash',
        isAdmin: false,
        maxContentRating: null,
        nowMs: 101_000,
      });

      const result = await resetRestrictedPinAndEmit(db, {
        userId: created.id,
        username: created.username,
        nowMs: 102_000,
      });
      expect(result).toEqual({ cleared: false });

      const settings = await getUserSettings(db, created.id);
      expect(settings).toBeUndefined();

      const event = await latestUserEvent('user.restricted-pin-reset', created.id);
      expect(event).toBeUndefined();
    });
  });
});
