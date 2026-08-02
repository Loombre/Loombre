// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/email-collision-notice.spec.ts
//
// Live-DB tests for src/query/email-collision-notice.ts — the per-address
// 24h notice-window ledger (G7, STATE.md "Current-password re-auth on
// self-changes"). Same self-sufficient pattern as password-reset.spec.ts:
// resets + reseeds the live DB in beforeAll so `vitest run` alone is
// enough from a fresh database.
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
import { EMAIL_COLLISION_NOTICE_WINDOW_MS, claimEmailCollisionNoticeWindow } from '../src/query/email-collision-notice.js';

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
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.destroy();
});

describe('claimEmailCollisionNoticeWindow (G7)', () => {
  it('a fresh address wins the window (no ledger row yet)', async () => {
    const won = await claimEmailCollisionNoticeWindow(db, 'fresh@example.invalid', 1_000_000);
    expect(won).toBe(true);
  });

  it('a second claim for the SAME address inside the 24h window loses (suppressed)', async () => {
    const email = 'repeat@example.invalid';
    const first = await claimEmailCollisionNoticeWindow(db, email, 2_000_000);
    expect(first).toBe(true);

    const second = await claimEmailCollisionNoticeWindow(db, email, 2_000_000 + 1);
    expect(second).toBe(false);

    const justUnderWindow = await claimEmailCollisionNoticeWindow(
      db,
      email,
      2_000_000 + EMAIL_COLLISION_NOTICE_WINDOW_MS - 1,
    );
    expect(justUnderWindow).toBe(false);
  });

  it('a claim exactly at the 24h boundary (or later) wins again', async () => {
    const email = 'boundary@example.invalid';
    const first = await claimEmailCollisionNoticeWindow(db, email, 3_000_000);
    expect(first).toBe(true);

    const atBoundary = await claimEmailCollisionNoticeWindow(db, email, 3_000_000 + EMAIL_COLLISION_NOTICE_WINDOW_MS);
    expect(atBoundary).toBe(true);
  });

  it('is CITEXT case-insensitive — the SAME address under different casing shares one window', async () => {
    const first = await claimEmailCollisionNoticeWindow(db, 'MixedCase@Example.Invalid', 4_000_000);
    expect(first).toBe(true);

    const second = await claimEmailCollisionNoticeWindow(db, 'mixedcase@example.invalid', 4_000_000 + 1);
    expect(second).toBe(false);
  });

  it('independent addresses have independent windows', async () => {
    const a = await claimEmailCollisionNoticeWindow(db, 'address-a@example.invalid', 5_000_000);
    const b = await claimEmailCollisionNoticeWindow(db, 'address-b@example.invalid', 5_000_000);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('re-winning the window advances last_notice_at_ms (a THIRD claim right after the second win still loses)', async () => {
    const email = 'advance@example.invalid';
    await claimEmailCollisionNoticeWindow(db, email, 6_000_000);
    const rewon = await claimEmailCollisionNoticeWindow(db, email, 6_000_000 + EMAIL_COLLISION_NOTICE_WINDOW_MS);
    expect(rewon).toBe(true);

    const immediatelyAfter = await claimEmailCollisionNoticeWindow(
      db,
      email,
      6_000_000 + EMAIL_COLLISION_NOTICE_WINDOW_MS + 1,
    );
    expect(immediatelyAfter).toBe(false);
  });
});
