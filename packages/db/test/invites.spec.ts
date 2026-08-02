// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/invites.spec.ts
//
// Live-DB tests for src/query/invites.ts (E2, migrations/0023_user_invites.sql).
// Self-sufficient like identity.spec.ts: resets + reseeds in beforeAll.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { getUserByUsername } from '../src/query/identity.js';
import {
  claimInviteAndEmit,
  createInviteAndEmit,
  deriveInviteStatus,
  getInviteByTokenHash,
  isInviteClaimable,
  listInvitesAdmin,
  mapClaimState,
  revokeInviteAndEmit,
} from '../src/query/invites.js';

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
let adminId: string;
let libMoviesId: string;
let libTvId: string;
let libRestrictedId: string;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function freshTokenHash(): string {
  return hashToken(randomBytes(32).toString('base64url'));
}

async function latestEvent(
  type: string,
  matcher: (payload: Record<string, unknown>) => boolean
): Promise<{ payload: Record<string, unknown>; actor_user_id: string | null } | undefined> {
  const { rows } = await rawClient.query<{ payload: Record<string, unknown>; actor_user_id: string | null }>(
    `SELECT payload, actor_user_id FROM events WHERE type = $1 ORDER BY ts_ms DESC, id DESC LIMIT 20`,
    [type]
  );
  return rows.find((r) => matcher(r.payload));
}

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  const admin = await getUserByUsername(db, 'admin');
  adminId = admin!.id;

  const libs = await rawClient.query<{ id: string; name: string; content_class: string }>(
    `SELECT id, name, content_class FROM libraries ORDER BY name`
  );
  libMoviesId = libs.rows.find((l) => l.name === 'Movies')!.id;
  libTvId = libs.rows.find((l) => l.name === 'TV')!.id;
  libRestrictedId = libs.rows.find((l) => l.content_class === 'restricted')!.id;
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

describe('invites (E2)', () => {
  describe('createInviteAndEmit', () => {
    it('creates the invite row + grant rows + user.invited event without ever carrying token material', async () => {
      const tokenHash = freshTokenHash();
      const invite = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: 'preset-user',
        displayNamePreset: 'Preset Person',
        email: 'invitee@example.invalid',
        libraryIds: [libMoviesId, libTvId],
        expiresAtMs: Date.now() + 72 * 60 * 60 * 1000,
        nowMs: 1_000_000,
      });

      expect(invite.usernamePreset).toBe('preset-user');
      expect(invite.displayNamePreset).toBe('Preset Person');
      expect(invite.email).toBe('invitee@example.invalid');
      expect(invite.libraryIds.sort()).toEqual([libMoviesId, libTvId].sort());
      expect(invite.claimedAtMs).toBeNull();
      expect(invite.revokedAtMs).toBeNull();

      const event = await latestEvent('user.invited', (p) => p.inviteId === invite.id);
      expect(event).toBeDefined();
      expect(event!.actor_user_id).toBe(adminId);
      expect(event!.payload).toEqual({
        inviteId: invite.id,
        usernamePreset: 'preset-user',
        libraryIds: [libMoviesId, libTvId],
        createdAtMs: 1_000_000,
      });
      // The raw token never appears anywhere the event/row can be inspected.
      expect(JSON.stringify(event!.payload)).not.toContain(tokenHash);
    });

    it('supports zero library grants (an admin-only-content-free invite)', async () => {
      const invite = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash: freshTokenHash(),
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 1000,
        nowMs: 1_000_100,
      });
      expect(invite.libraryIds).toEqual([]);
    });
  });

  describe('listInvitesAdmin', () => {
    it('lists newest-first with libraryIds assembled per invite, keyset-paginated', async () => {
      const first = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash: freshTokenHash(),
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [libMoviesId],
        expiresAtMs: Date.now() + 1000,
        nowMs: 2_000_000,
      });
      const second = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash: freshTokenHash(),
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 1000,
        nowMs: 2_000_001,
      });

      const page = await listInvitesAdmin(db, { limit: 1 });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.id).toBe(second.id);
      expect(page.nextCursor).not.toBeNull();

      const page2 = await listInvitesAdmin(db, { limit: 1, cursor: page.nextCursor! });
      expect(page2.rows[0]!.id).toBe(first.id);
      expect(page2.rows[0]!.libraryIds).toEqual([libMoviesId]);
    });
  });

  describe('deriveInviteStatus', () => {
    it('pending / expired / claimed / revoked, revoked winning when both are set', () => {
      const now = 100_000;
      expect(deriveInviteStatus({ claimedAtMs: null, revokedAtMs: null, expiresAtMs: now + 1 }, now)).toBe('pending');
      expect(deriveInviteStatus({ claimedAtMs: null, revokedAtMs: null, expiresAtMs: now - 1 }, now)).toBe('expired');
      expect(deriveInviteStatus({ claimedAtMs: 50, revokedAtMs: null, expiresAtMs: now + 1 }, now)).toBe('claimed');
      expect(deriveInviteStatus({ claimedAtMs: null, revokedAtMs: 50, expiresAtMs: now + 1 }, now)).toBe('revoked');
      expect(deriveInviteStatus({ claimedAtMs: 50, revokedAtMs: 60, expiresAtMs: now + 1 }, now)).toBe('revoked');
    });
  });

  describe('revokeInviteAndEmit', () => {
    it('revokes a pending invite and writes user.invite-revoked', async () => {
      const invite = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash: freshTokenHash(),
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 1000,
        nowMs: 3_000_000,
      });

      const won = await revokeInviteAndEmit(db, invite.id, adminId, 3_000_100);
      expect(won).toBe(true);

      const event = await latestEvent('user.invite-revoked', (p) => p.inviteId === invite.id);
      expect(event).toBeDefined();
      expect(event!.actor_user_id).toBe(adminId);
      expect(event!.payload).toEqual({ inviteId: invite.id, revokedAtMs: 3_000_100 });
    });

    it('a second revoke of the same invite fails (already revoked)', async () => {
      const invite = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash: freshTokenHash(),
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 1000,
        nowMs: 3_100_000,
      });
      expect(await revokeInviteAndEmit(db, invite.id, adminId, 3_100_100)).toBe(true);
      expect(await revokeInviteAndEmit(db, invite.id, adminId, 3_100_200)).toBe(false);
    });

    it('revoking an already-claimed invite fails', async () => {
      const tokenHash = freshTokenHash();
      const invite = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: 'claim-then-revoke',
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 3_200_000,
      });
      const result = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'claim-then-revoke',
        email: null,
        displayName: null,
        passwordHash: 'not-a-real-hash',
        nowMs: 3_200_100,
      });
      expect(result.ok).toBe(true);

      expect(await revokeInviteAndEmit(db, invite.id, adminId, 3_200_200)).toBe(false);
    });

    it('revoking an unknown id fails', async () => {
      expect(await revokeInviteAndEmit(db, '018f6f1e-0000-7000-8000-0000000000ff', adminId, 3_300_000)).toBe(false);
    });
  });

  describe('getInviteByTokenHash / isInviteClaimable / mapClaimState', () => {
    it('resolves a live invite and reports it claimable', async () => {
      const tokenHash = freshTokenHash();
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: 'preset-name',
        displayNamePreset: 'Display Name',
        email: 'claim-state@example.invalid',
        libraryIds: [],
        expiresAtMs: 4_100_000,
        nowMs: 4_000_000,
      });

      const row = await getInviteByTokenHash(db, tokenHash);
      expect(row).toBeDefined();
      expect(
        isInviteClaimable({ claimedAtMs: row!.claimed_at_ms, revokedAtMs: row!.revoked_at_ms, expiresAtMs: row!.expires_at_ms }, 4_050_000)
      ).toBe(true);
      expect(
        isInviteClaimable({ claimedAtMs: row!.claimed_at_ms, revokedAtMs: row!.revoked_at_ms, expiresAtMs: row!.expires_at_ms }, 4_200_000)
      ).toBe(false); // past expiresAtMs

      expect(mapClaimState(row!)).toEqual({
        usernamePreset: 'preset-name',
        displayNamePreset: 'Display Name',
        emailPreset: 'claim-state@example.invalid',
      });
    });

    it('an unknown token hash resolves to undefined', async () => {
      expect(await getInviteByTokenHash(db, freshTokenHash())).toBeUndefined();
    });
  });

  describe('claimInviteAndEmit', () => {
    it('happy path: creates the user (emits user.created), grants general libraries, skips restricted, emits user.claimed', async () => {
      const tokenHash = freshTokenHash();
      const invite = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: 'Invited Preset',
        email: 'preset@example.invalid',
        libraryIds: [libMoviesId, libRestrictedId],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_000_000,
      });

      const result = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'claimed-user-1',
        email: null, // defaults to invite.email
        displayName: null, // defaults to invite.displayNamePreset
        passwordHash: 'argon2id-fake-hash',
        nowMs: 5_000_100,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.user.username).toBe('claimed-user-1');
      expect(result.grantedLibraryIds).toEqual([libMoviesId]);
      expect(result.skippedRestrictedLibraryIds).toEqual([libRestrictedId]);

      // library_permissions actually written for the general library only.
      const perms = await rawClient.query<{ library_id: string }>(
        `SELECT library_id FROM library_permissions WHERE user_id = $1`,
        [result.user.id]
      );
      expect(perms.rows.map((r) => r.library_id).sort()).toEqual([libMoviesId].sort());

      // invite row now shows claimed + the new user id.
      const row = await getInviteByTokenHash(db, tokenHash);
      expect(row!.claimed_at_ms).toBe(5_000_100);
      expect(row!.claimed_user_id).toBe(result.user.id);

      const createdEvent = await latestEvent('user.created', (p) => p.userId === result.user.id);
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.actor_user_id).toBe(result.user.id); // self-attributed, not the admin

      const claimedEvent = await latestEvent('user.claimed', (p) => p.userId === result.user.id);
      expect(claimedEvent).toBeDefined();
      expect(claimedEvent!.actor_user_id).toBe(result.user.id);
      expect(claimedEvent!.payload).toEqual({
        userId: result.user.id,
        inviteId: invite.id,
        username: 'claimed-user-1',
        createdAtMs: 5_000_100,
      });
    });

    it('invalid token -> {ok:false, reason:"invalid"}', async () => {
      const result = await claimInviteAndEmit(db, {
        tokenHash: freshTokenHash(),
        username: 'nobody',
        email: null,
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_100_000,
      });
      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('expired invite -> {ok:false, reason:"invalid"}', async () => {
      const tokenHash = freshTokenHash();
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: 5_200_000,
        nowMs: 5_100_000,
      });
      const result = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'too-late',
        email: null,
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_300_000, // past expiresAtMs
      });
      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('revoked invite -> {ok:false, reason:"invalid"}', async () => {
      const tokenHash = freshTokenHash();
      const invite = await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_400_000,
      });
      await revokeInviteAndEmit(db, invite.id, adminId, 5_400_100);
      const result = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'revoked-claim',
        email: null,
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_400_200,
      });
      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('already-claimed invite -> {ok:false, reason:"invalid"} on the second attempt', async () => {
      const tokenHash = freshTokenHash();
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_500_000,
      });
      const first = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'claim-once',
        email: null,
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_500_100,
      });
      expect(first.ok).toBe(true);

      const second = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'claim-twice',
        email: null,
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_500_200,
      });
      expect(second).toEqual({ ok: false, reason: 'invalid' });
    });

    it('username conflict rolls back the WHOLE transaction — the invite is still claimable afterward', async () => {
      const tokenHash = freshTokenHash();
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_600_000,
      });

      // 'admin' already exists (seed) -> unique violation on username.
      const conflict = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'admin',
        email: null,
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_600_100,
      });
      expect(conflict).toEqual({ ok: false, reason: 'username-conflict' });

      // The invite was NOT burned — claimed_at_ms rolled back with the rest
      // of the failed transaction, so a retry with a free username wins.
      const retry = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'admin-retry-ok',
        email: null,
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_600_200,
      });
      expect(retry.ok).toBe(true);
    });

    it('email/displayName default to the invite preset when the claim omits them', async () => {
      const tokenHash = freshTokenHash();
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: 'Preset Display',
        email: 'preset-default@example.invalid',
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_700_000,
      });

      const result = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'default-preset-user',
        email: 'preset-default@example.invalid',
        displayName: 'Preset Display',
        passwordHash: 'x',
        nowMs: 5_700_100,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.user.email).toBe('preset-default@example.invalid');
      expect(result.user.display_name).toBe('Preset Display');
    });

    // G6 (STATE.md "Current-password re-auth on self-changes"): the
    // COMMON collision case — a submitted email already belonging to
    // another account — was always silently dropped (R-F3/F3, E8); this
    // lane's addition is that the dropped address now surfaces in the
    // ok:true result's INTERNAL `collidedEmail` field (never serialized to
    // any HTTP response) so the controller can dispatch the email-in-use
    // notice post-commit (G7).
    it('a colliding email is silently dropped AND surfaced via collidedEmail — the claim still succeeds', async () => {
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash: freshTokenHash(),
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_750_000,
      });

      // A pre-existing account already owns this address (seed admin).
      const admin = await getUserByUsername(db, 'admin');
      const collidingEmail = admin!.email!;

      const tokenHash = freshTokenHash();
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_760_000,
      });

      const result = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'collision-claim-user',
        email: collidingEmail,
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_760_100,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.collidedEmail).toBe(collidingEmail);
      expect(result.user.email).toBeNull(); // dropped, not the colliding address
    });

    it('no collision -> collidedEmail is null', async () => {
      const tokenHash = freshTokenHash();
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_770_000,
      });

      const result = await claimInviteAndEmit(db, {
        tokenHash,
        username: 'no-collision-claim-user',
        email: 'genuinely-free@example.invalid',
        displayName: null,
        passwordHash: 'x',
        nowMs: 5_770_100,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.collidedEmail).toBeNull();
      expect(result.user.email).toBe('genuinely-free@example.invalid');
    });

    it('N concurrent claims of the SAME invite: exactly one succeeds, the rest see reason:"invalid", exactly one user row is created', async () => {
      const tokenHash = freshTokenHash();
      await createInviteAndEmit(db, {
        createdByUserId: adminId,
        tokenHash,
        usernamePreset: null,
        displayNamePreset: null,
        email: null,
        libraryIds: [],
        expiresAtMs: Date.now() + 100_000,
        nowMs: 5_800_000,
      });

      const N = 8;
      const attempts = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          claimInviteAndEmit(db, {
            tokenHash,
            username: `race-user-${i}`,
            email: null,
            displayName: null,
            passwordHash: 'x',
            nowMs: 5_800_100 + i,
          })
        )
      );

      const wins = attempts.filter((r) => r.ok);
      const losses = attempts.filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(N - 1);
      for (const loss of losses) {
        expect(loss).toEqual({ ok: false, reason: 'invalid' });
      }

      const created = await rawClient.query<{ count: string }>(
        `SELECT count(*) FROM users WHERE username LIKE 'race-user-%'`
      );
      expect(Number(created.rows[0]!.count)).toBe(1);
    });
  });
});
