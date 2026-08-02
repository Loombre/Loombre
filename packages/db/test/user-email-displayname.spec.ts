// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/user-email-displayname.spec.ts
//
// Live-DB tests for M1 (users.email loosens to optional, CITEXT NULLs
// distinct) and M2 (users.display_name — a real column, closing the H1
// bug-class silent-discard gap), migrations/0023_user_invites.sql.
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
import type { ViewerContext } from '../src/context.js';
import { getUserByEmail, getUserByUsername, createUserAdminAndEmit } from '../src/query/identity.js';
import { createUserAdmin, updateUserAdmin, updateUserSelf } from '../src/query/admin.js';
import { exportData } from '../src/query/export.js';
import { insertUserWithId } from '../src/internal/import-users.js';

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

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

describe('users.email optional / users.display_name (M1/M2)', () => {
  it('createUserAdmin persists a NULL email and a real display_name', async () => {
    const created = await createUserAdmin(db, {
      username: 'no-email-user',
      email: null,
      passwordHash: 'not-a-real-hash',
      isAdmin: false,
      maxContentRating: null,
      displayName: 'No Email Person',
      nowMs: 1_000,
    });
    expect(created.email).toBeNull();
    expect(created.display_name).toBe('No Email Person');
  });

  it('TWO email-less users coexist (Postgres NULLs are mutually distinct under UNIQUE)', async () => {
    const a = await createUserAdmin(db, {
      username: 'no-email-a',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 2_000,
    });
    const b = await createUserAdmin(db, {
      username: 'no-email-b',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 2_001,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.email).toBeNull();
    expect(b.email).toBeNull();
  });

  it('getUserByEmail never matches a NULL-email row, for any input string', async () => {
    await createUserAdmin(db, {
      username: 'null-email-lookup-test',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 3_000,
    });
    expect(await getUserByEmail(db, '')).toBeUndefined();
    expect(await getUserByEmail(db, 'null-email-lookup-test@example.invalid')).toBeUndefined();
    expect(await getUserByEmail(db, 'anything')).toBeUndefined();
  });

  it('login-by-username-only works for an email-less user: getUserByUsername still resolves it', async () => {
    await createUserAdmin(db, {
      username: 'username-only-login',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 3_500,
    });
    const row = await getUserByUsername(db, 'username-only-login');
    expect(row).toBeDefined();
    expect(row?.email).toBeNull();
  });

  it('updateUserAdmin can set displayName and clear email to null', async () => {
    const created = await createUserAdmin(db, {
      username: 'admin-update-target',
      email: 'has-email@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 4_000,
    });

    const withDisplayName = await updateUserAdmin(db, created.id, {
      displayName: 'Set By Admin',
      nowMs: 4_100,
    });
    expect(withDisplayName.ok).toBe(true);
    if (withDisplayName.ok) {
      expect(withDisplayName.user.display_name).toBe('Set By Admin');
      expect(withDisplayName.user.email).toBe('has-email@example.invalid'); // untouched
    }

    const clearedEmail = await updateUserAdmin(db, created.id, {
      email: null,
      nowMs: 4_200,
    });
    expect(clearedEmail.ok).toBe(true);
    if (clearedEmail.ok) {
      expect(clearedEmail.user.email).toBeNull();
      expect(clearedEmail.user.display_name).toBe('Set By Admin'); // untouched
    }
  });

  it('updateUserSelf can set displayName and clear email to null (UpdateMeRequest null-to-clear)', async () => {
    const created = await createUserAdmin(db, {
      username: 'self-update-target',
      email: 'self@example.invalid',
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 5_000,
    });

    const withDisplayName = await updateUserSelf(db, created.id, {
      displayName: 'My Own Name',
      nowMs: 5_100,
    });
    expect(withDisplayName?.user.display_name).toBe('My Own Name');
    expect(withDisplayName?.collidedEmail).toBeNull();

    const clearedEmail = await updateUserSelf(db, created.id, {
      email: null,
      nowMs: 5_200,
    });
    expect(clearedEmail?.user.email).toBeNull();
    expect(clearedEmail?.user.display_name).toBe('My Own Name'); // untouched
    expect(clearedEmail?.collidedEmail).toBeNull();
  });

  it('E4 archive check: exportData carries email:null and displayName through for an admin viewer', async () => {
    const created = await createUserAdmin(db, {
      username: 'export-round-trip',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      displayName: 'Export Me',
      nowMs: 6_000,
    });

    const admin = await getUserByUsername(db, 'admin');
    const ctx: ViewerContext = { userId: admin!.id, allowedLibraryIds: [], restrictedCleared: false };

    const chunks = [];
    for await (const chunk of exportData(db, ctx)) chunks.push(chunk);
    const exported = chunks.find((c) => c.kind === 'user' && c.user.id === created.id);
    expect(exported).toBeDefined();
    if (exported?.kind === 'user') {
      expect(exported.user.email).toBeNull();
      expect(exported.user.displayName).toBe('Export Me');
    }
  });

  it('E4 archive check: insertUserWithId (the import restore path) round-trips a null email + displayName', async () => {
    const imported = await insertUserWithId(db, {
      username: 'import-round-trip',
      email: null,
      displayName: 'Imported Name',
      isAdmin: false,
      createdAtMs: 7_000,
      updatedAtMs: 7_000,
    });
    expect(imported.email).toBeNull();
    expect(imported.display_name).toBe('Imported Name');
  });

  it('createUserAdminAndEmit (the interactive create path, POST /users) also persists email:null + displayName', async () => {
    const created = await createUserAdminAndEmit(db, {
      username: 'interactive-create',
      email: null,
      passwordHash: 'x',
      isAdmin: false,
      maxContentRating: null,
      displayName: 'Interactive Name',
      nowMs: 8_000,
    });
    expect(created.email).toBeNull();
    expect(created.display_name).toBe('Interactive Name');
  });
});
