// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/setup-first-admin.spec.ts
//
// Live-DB tests for src/query/identity.ts's countUsers/createFirstAdminIfEmpty
// (STATE.md P4.6/P4.10 — the onboarding wizard's escape hatch from the
// admin-creates-users chicken-and-egg). Deliberately a SEPARATE file from
// test/identity.spec.ts rather than an added describe() block there:
// identity.spec.ts's beforeAll seeds admin+casual users, which makes the
// "table is genuinely empty" scenario this file exists to prove
// unreachable without disturbing every other test in that file's shared
// state. This file resets the schema WITHOUT seeding (scripts/migrate.mjs
// reset only — no seed.mjs) so it starts from a real empty `users` table,
// matching a fresh install exactly.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import { countUsers, createFirstAdminIfEmpty, getUserById } from '../src/query/identity.js';
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

function resetSchemaOnly(): void {
  // NO seed.mjs call — the whole point of this file is a genuinely empty
  // `users` table, the exact starting condition a fresh install boots into.
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
}

let db: Kysely<DB>;

beforeAll(() => {
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

describe('countUsers / createFirstAdminIfEmpty (STATE.md P4.6/P4.10, first-boot setup)', () => {
  beforeEach(() => {
    resetSchemaOnly();
  });

  it('countUsers is 0 on a freshly reset (unseeded) database', async () => {
    expect(await countUsers(db)).toBe(0);
  });

  it('creates the admin on an empty table and countUsers reflects it afterwards', async () => {
    const created = await createFirstAdminIfEmpty(db, {
      username: 'first-admin',
      email: 'first-admin@loombre.local',
      passwordHash: 'not-a-real-hash',
      nowMs: 1_000,
    });

    expect(created).toBeDefined();
    expect(created!.username).toBe('first-admin');
    expect(created!.email).toBe('first-admin@loombre.local');
    expect(created!.is_admin).toBe(true);
    expect(created!.password_hash).toBe('not-a-real-hash');

    expect(await countUsers(db)).toBe(1);

    const fetched = await getUserById(db, created!.id);
    expect(fetched?.is_admin).toBe(true);
  });

  it('is a permanent no-op once ANY user exists — second call returns undefined, writes nothing', async () => {
    const first = await createFirstAdminIfEmpty(db, {
      username: 'first-admin',
      email: 'first-admin@loombre.local',
      passwordHash: 'hash-one',
      nowMs: 1_000,
    });
    expect(first).toBeDefined();

    const second = await createFirstAdminIfEmpty(db, {
      username: 'second-admin',
      email: 'second-admin@loombre.local',
      passwordHash: 'hash-two',
      nowMs: 2_000,
    });
    expect(second).toBeUndefined();

    // Exactly the first admin exists — the second call's candidate row was
    // never written.
    expect(await countUsers(db)).toBe(1);
    const survivor = await getUserById(db, first!.id);
    expect(survivor?.username).toBe('first-admin');
  });

  it('race safety: two concurrent calls against an empty table yield exactly one created row, never two, never zero', async () => {
    const [resultA, resultB] = await Promise.all([
      createFirstAdminIfEmpty(db, {
        username: 'race-admin-a',
        email: 'race-admin-a@loombre.local',
        passwordHash: 'hash-a',
        nowMs: 1_000,
      }),
      createFirstAdminIfEmpty(db, {
        username: 'race-admin-b',
        email: 'race-admin-b@loombre.local',
        passwordHash: 'hash-b',
        nowMs: 1_000,
      }),
    ]);

    // Exactly one of the two concurrent callers won — the transaction-
    // scoped pg_advisory_xact_lock serializes them around the
    // count-then-insert critical section (src/query/identity.ts's
    // createFirstAdminIfEmpty doc comment), so it is never both-defined
    // (two admins) and never both-undefined (zero admins, the request
    // silently swallowed).
    const winners = [resultA, resultB].filter((r): r is NonNullable<typeof r> => r !== undefined);
    expect(winners).toHaveLength(1);

    expect(await countUsers(db)).toBe(1);
    const winnerUsername = winners[0]!.username;
    expect(['race-admin-a', 'race-admin-b']).toContain(winnerUsername);
  });

  it('race safety holds across many (10) concurrent callers, not just two', async () => {
    const attempts = Array.from({ length: 10 }, (_, i) =>
      createFirstAdminIfEmpty(db, {
        username: `race-many-${i}`,
        email: `race-many-${i}@loombre.local`,
        passwordHash: `hash-${i}`,
        nowMs: 1_000,
      })
    );
    const results = await Promise.all(attempts);
    const winners = results.filter((r): r is NonNullable<typeof r> => r !== undefined);
    expect(winners).toHaveLength(1);
    expect(await countUsers(db)).toBe(1);
  });
});
