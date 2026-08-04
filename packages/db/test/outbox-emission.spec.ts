// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/outbox-emission.spec.ts
//
// Live-DB tests for the two outbox event types that the contract declares
// but nothing used to produce: `user.created` and `progress.updated`. Both
// are in the closed envelope enum
// (packages/contract/event-schemas/envelope.schema.json), both have payload
// schemas asserting a real emission path, and docs/PLAN.md §4.3 requires
// every state change to write its typed event row IN THE SAME TRANSACTION
// as the change — so these tests assert emission AND transactional
// atomicity (a rolled-back write leaves no event behind, and a suppressed
// write emits nothing).
//
// SELF-SUFFICIENT (resets in its own beforeAll hooks, same convention as
// test/leak.spec.ts / test/playback-sessions.spec.ts — this package's
// vitest.config.ts forces sequential file execution for exactly that
// reason). The two describes reset differently on purpose:
// createFirstAdminIfEmpty only does anything against a genuinely EMPTY
// users table (reset, no seed), while the progress path needs a seeded
// catalog to write progress against (reset + seed).
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
import type { ViewerContext } from '../src/context.js';
import { createFirstAdminIfEmpty, createUserAdminAndEmit } from '../src/query/identity.js';
import { upsertProgress } from '../src/query/progress-write.js';
import { cancelNoticeAndEmit, getActiveNotice, publishNoticeAndEmit } from '../src/query/notices.js';

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
  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();
});

afterAll(async () => {
  await rawClient?.end();
  await db?.destroy();
});

describe('user.created (packages/contract/event-schemas/user.created.schema.json)', () => {
  beforeAll(() => {
    // NO seed.mjs — createFirstAdminIfEmpty is a permanent no-op the
    // instant any user exists (src/query/identity.ts), so the emission it
    // owns is only reachable from a genuinely empty users table.
    run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  });

  it('createFirstAdminIfEmpty emits user.created in the same transaction as the insert, with no secrets in the payload', async () => {
    const created = await createFirstAdminIfEmpty(db, {
      username: 'first-admin',
      email: 'first-admin@loombre.local',
      passwordHash: 'not-a-real-hash',
      nowMs: 1_000,
    });
    expect(created).toBeDefined();

    const rows = await eventsOfType('user.created');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.ts_ms)).toBe(1_000);
    // First-run onboarding has no prior admin to attribute the creation to
    // — the new admin is their own actor.
    expect(rows[0]!.actor_user_id).toBe(created!.id);
    expect(rows[0]!.payload).toEqual({
      userId: created!.id,
      username: 'first-admin',
      isAdmin: true,
      createdAtMs: 1_000,
    });
  });

  it('createUserAdminAndEmit emits user.created attributed to the ACTING admin, not the new user', async () => {
    const before = (await eventsOfType('user.created')).length;

    const actorId = (
      await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'first-admin'")
    ).rows[0]!.id;

    const created = await createUserAdminAndEmit(db, {
      username: 'invited',
      email: 'invited@loombre.local',
      passwordHash: 'another-hash',
      isAdmin: false,
      maxContentRating: null,
      nowMs: 2_000,
      actorUserId: actorId,
    });

    const rows = await eventsOfType('user.created');
    expect(rows).toHaveLength(before + 1);
    const row = rows[rows.length - 1]!;
    expect(row.actor_user_id).toBe(actorId);
    expect(row.payload).toEqual({
      userId: created.id,
      username: 'invited',
      isAdmin: false,
      createdAtMs: 2_000,
    });
  });

  it('a rejected creation (duplicate username) writes neither the row nor the event', async () => {
    const before = (await eventsOfType('user.created')).length;

    await expect(
      createUserAdminAndEmit(db, {
        username: 'invited',
        email: 'invited-again@loombre.local',
        passwordHash: 'dup',
        isAdmin: false,
        maxContentRating: null,
        nowMs: 3_000,
      }),
    ).rejects.toThrow();

    expect(await eventsOfType('user.created')).toHaveLength(before);
  });

  it('createFirstAdminIfEmpty emits nothing when it no-ops (users table already populated)', async () => {
    const before = (await eventsOfType('user.created')).length;

    const second = await createFirstAdminIfEmpty(db, {
      username: 'second-admin',
      email: 'second-admin@loombre.local',
      passwordHash: 'hash-two',
      nowMs: 4_000,
    });
    expect(second).toBeUndefined();

    expect(await eventsOfType('user.created')).toHaveLength(before);
  });
});

describe('progress.updated (packages/contract/event-schemas/progress.updated.schema.json)', () => {
  let adminCtx: ViewerContext;
  let casualCtx: ViewerContext;
  let harborLightsItemId: string;
  let restrictedItemId: string;
  let adminId: string;

  beforeAll(async () => {
    run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
    run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);

    adminId = (await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")).rows[0]!.id;
    const casualId = (await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'casual'")).rows[0]!
      .id;
    harborLightsItemId = (
      await rawClient.query<{ id: string }>("SELECT id FROM catalog_items WHERE title = 'Harbor Lights'")
    ).rows[0]!.id;
    restrictedItemId = (
      await rawClient.query<{ id: string }>("SELECT id FROM catalog_items WHERE title = 'After Hours Redline'")
    ).rows[0]!.id;

    const generalLibraryIds = (
      await rawClient.query<{ id: string }>("SELECT id FROM libraries WHERE content_class = 'general'")
    ).rows.map((r) => r.id);
    const allLibraryIds = (await rawClient.query<{ id: string }>('SELECT id FROM libraries')).rows.map((r) => r.id);

    adminCtx = { userId: adminId, allowedLibraryIds: allLibraryIds, restrictedCleared: true };
    casualCtx = { userId: casualId, allowedLibraryIds: generalLibraryIds, restrictedCleared: false };
  });

  it('emits progress.updated on EVERY upsert (including the heartbeat-driven update of an existing row)', async () => {
    const before = (await eventsOfType('progress.updated')).length;

    const first = await upsertProgress(db, adminCtx, harborLightsItemId, {
      positionMs: 12_000,
      state: 'in-progress',
      nowMs: 10_000,
      durationMs: 600_000,
    });
    expect(first).toBeDefined();

    await upsertProgress(db, adminCtx, harborLightsItemId, {
      positionMs: 34_000,
      state: 'in-progress',
      nowMs: 20_000,
    });

    const rows = await eventsOfType('progress.updated');
    expect(rows).toHaveLength(before + 2);

    const insertEvent = rows[rows.length - 2]!;
    expect(insertEvent.actor_user_id).toBe(adminId);
    expect(Number(insertEvent.ts_ms)).toBe(10_000);
    // Exactly the schema's required properties, nothing more
    // (additionalProperties: false) — notably NO durationMs.
    expect(insertEvent.payload).toEqual({
      userId: adminId,
      itemId: harborLightsItemId,
      positionMs: 12_000,
      state: 'in-progress',
      playCount: first!.playCount,
      updatedAtMs: 10_000,
    });

    expect(rows[rows.length - 1]!.payload).toEqual({
      userId: adminId,
      itemId: harborLightsItemId,
      positionMs: 34_000,
      state: 'in-progress',
      playCount: first!.playCount,
      updatedAtMs: 20_000,
    });
  });

  it('the emitted playCount is the one actually written, not independently re-derived', async () => {
    const beforePlayCount = (await upsertProgress(db, adminCtx, harborLightsItemId, {
      positionMs: 590_000,
      state: 'in-progress',
      nowMs: 25_000,
    }))!.playCount;

    const played = await upsertProgress(db, adminCtx, harborLightsItemId, {
      positionMs: 600_000,
      state: 'played',
      nowMs: 30_000,
    });
    expect(played!.playCount).toBe(beforePlayCount + 1);

    const rows = await eventsOfType('progress.updated');
    expect(rows[rows.length - 1]!.payload).toMatchObject({
      state: 'played',
      playCount: played!.playCount,
    });

    // A second 'played' heartbeat must not over-count — and the event must
    // agree with the row it describes.
    const again = await upsertProgress(db, adminCtx, harborLightsItemId, {
      positionMs: 600_000,
      state: 'played',
      nowMs: 40_000,
    });
    expect(again!.playCount).toBe(played!.playCount);

    const after = await eventsOfType('progress.updated');
    expect(after[after.length - 1]!.payload).toMatchObject({
      state: 'played',
      playCount: again!.playCount,
    });
  });

  it('emits nothing when the guard rejects the write (invisible item — no row, no event)', async () => {
    const before = (await eventsOfType('progress.updated')).length;

    const blocked = await upsertProgress(db, casualCtx, restrictedItemId, {
      positionMs: 5_000,
      state: 'in-progress',
      nowMs: 50_000,
    });
    expect(blocked).toBeUndefined();

    expect(await eventsOfType('progress.updated')).toHaveLength(before);
  });
});

describe('notice.published / notice.cancelled (STATE.md "Admin broadcast notifications — system notices", packages/db/src/query/notices.ts)', () => {
  let adminId: string;

  beforeAll(async () => {
    run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
    run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);
    adminId = (await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")).rows[0]!.id;
  });

  it('publishNoticeAndEmit emits notice.published with the exact all-user shape (no createdBy) and the actor as envelope.actorUserId', async () => {
    const before = (await eventsOfType('notice.published')).length;

    const notice = await publishNoticeAndEmit(db, {
      message: 'Scheduled maintenance tonight.',
      severity: 'warning',
      effectiveAtMs: null,
      expiresAtMs: 100_000,
      createdBy: adminId,
      nowMs: 10_000,
    });
    expect(notice.status).toBe('active');

    const rows = await eventsOfType('notice.published');
    expect(rows).toHaveLength(before + 1);
    const row = rows[rows.length - 1]!;
    expect(row.actor_user_id).toBe(adminId);
    expect(Number(row.ts_ms)).toBe(10_000);
    // Exactly the schema's required properties — NG6: no createdBy, no
    // user-id field of any kind.
    expect(row.payload).toEqual({
      id: notice.id,
      message: 'Scheduled maintenance tonight.',
      severity: 'warning',
      effectiveAtMs: null,
      expiresAtMs: 100_000,
      createdAtMs: 10_000,
    });
  });

  it('a second publish REPLACES the first: exactly one notice.published for the new row, NO notice.cancelled from the replace, and the old row is cancelled', async () => {
    const first = await publishNoticeAndEmit(db, {
      message: 'First notice.',
      severity: 'info',
      effectiveAtMs: null,
      expiresAtMs: 200_000,
      createdBy: adminId,
      nowMs: 20_000,
    });

    const cancelledBefore = (await eventsOfType('notice.cancelled')).length;
    const publishedBefore = (await eventsOfType('notice.published')).length;

    const second = await publishNoticeAndEmit(db, {
      message: 'Second notice replaces the first.',
      severity: 'critical',
      effectiveAtMs: 250_000,
      expiresAtMs: null,
      createdBy: adminId,
      nowMs: 30_000,
    });

    // NG8: exactly one notice.published (for the SECOND row) — the
    // replace of the first is NOT itself an event.
    const publishedRows = await eventsOfType('notice.published');
    expect(publishedRows).toHaveLength(publishedBefore + 1);
    expect(publishedRows[publishedRows.length - 1]!.payload).toMatchObject({ id: second.id });

    // NG8: NO notice.cancelled event for the superseded row.
    expect(await eventsOfType('notice.cancelled')).toHaveLength(cancelledBefore);

    const active = await getActiveNotice(db, 40_000);
    expect(active?.id).toBe(second.id);

    const firstRow = await rawClient.query<{ cancelled_at_ms: string | null }>(
      'SELECT cancelled_at_ms FROM system_notices WHERE id = $1',
      [first.id],
    );
    expect(firstRow.rows[0]!.cancelled_at_ms).not.toBeNull();
  });

  it('cancelNoticeAndEmit emits notice.cancelled {id} with the acting admin as actor; a second cancel is a no-op (returns false, emits nothing)', async () => {
    const notice = await publishNoticeAndEmit(db, {
      message: 'Cancel me.',
      severity: 'critical',
      effectiveAtMs: null,
      expiresAtMs: null,
      createdBy: adminId,
      nowMs: 40_000,
    });

    const before = (await eventsOfType('notice.cancelled')).length;
    const won = await cancelNoticeAndEmit(db, { id: notice.id, actorUserId: adminId, nowMs: 41_000 });
    expect(won).toBe(true);

    const rows = await eventsOfType('notice.cancelled');
    expect(rows).toHaveLength(before + 1);
    const row = rows[rows.length - 1]!;
    expect(row.actor_user_id).toBe(adminId);
    expect(row.payload).toEqual({ id: notice.id });

    const again = await cancelNoticeAndEmit(db, { id: notice.id, actorUserId: adminId, nowMs: 42_000 });
    expect(again).toBe(false);
    expect(await eventsOfType('notice.cancelled')).toHaveLength(before + 1);
  });

  it('getActiveNotice returns null when nothing is active, and respects natural expiry', async () => {
    const notice = await publishNoticeAndEmit(db, {
      message: 'Expires soon.',
      severity: 'info',
      effectiveAtMs: null,
      expiresAtMs: 100,
      createdBy: adminId,
      nowMs: 50_000,
    });
    // Cancel it so this test starts from a clean "nothing active" slate
    // regardless of execution order.
    await cancelNoticeAndEmit(db, { id: notice.id, actorUserId: adminId, nowMs: 50_050 });
    expect(await getActiveNotice(db, 60_000)).toBeNull();

    const expiring = await publishNoticeAndEmit(db, {
      message: 'Expires at 61000.',
      severity: 'info',
      effectiveAtMs: null,
      expiresAtMs: 61_000,
      createdBy: adminId,
      nowMs: 60_000,
    });
    expect((await getActiveNotice(db, 60_500))?.id).toBe(expiring.id);
    expect(await getActiveNotice(db, 61_000)).toBeNull(); // expiresAtMs is exclusive (> now, not >=)
  });

  it('one-active invariant holds under CONCURRENT publishes (review R-F2: pg_advisory_xact_lock — without it READ COMMITTED lets overlapping transactions miss each other\'s uncommitted INSERT and BOTH new rows survive; red is probabilistic without the lock, green is deterministic with it)', async () => {
    const nowMs = 500_000;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        publishNoticeAndEmit(db, {
          message: `Concurrent probe ${i}.`,
          severity: 'critical',
          effectiveAtMs: null,
          expiresAtMs: null,
          createdBy: adminId,
          nowMs,
        }),
      ),
    );
    const active = await rawClient.query(
      'SELECT id FROM system_notices WHERE cancelled_at_ms IS NULL AND (expires_at_ms IS NULL OR expires_at_ms > $1)',
      [nowMs],
    );
    expect(active.rows).toHaveLength(1);
  });
});
