// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/admin-sessions.spec.ts
//
// Live-DB tests for src/query/admin.ts's listActiveSessionsAdmin (STATE.md
// P2.8/deliverable E, GET /admin/sessions). The key property under test:
// item display fields are resolved through the REQUESTING ADMIN'S OWN
// ViewerContext, not a synthetic all-seeing one — plan §6.4 gate 4/5
// default-denies even admins. Both directions are exercised with the SAME
// admin user id, varying only the ctx object passed in (restrictedCleared
// true vs false) — this file constructs ViewerContext values by hand
// exactly like packages/db/test/playback-sessions.spec.ts already does,
// rather than going through a real login/unlock HTTP round-trip.
//
// Self-sufficient: resets + reseeds in its own beforeAll.
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
import { createPlaybackSession } from '../src/query/playback-sessions.js';
import { listActiveSessionsAdmin } from '../src/query/admin.js';

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
let harborLightsItemId: string;
let harborLightsFileId: string;
let restrictedItemId: string;
let restrictedFileId: string;
let adminDeviceId: string;
let adminDeviceName: string;

let adminClearedCtx: ViewerContext; // gate 4+5 both pass
let adminUnclearedCtx: ViewerContext; // same admin USER, but no live restricted clearance

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);

  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  adminId = (await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")).rows[0]!.id;

  const harborLights = (
    await rawClient.query<{ id: string }>("SELECT id FROM catalog_items WHERE title = 'Harbor Lights'")
  ).rows[0]!;
  harborLightsItemId = harborLights.id;
  harborLightsFileId = (
    await rawClient.query<{ id: string }>('SELECT id FROM media_files WHERE item_id = $1', [harborLightsItemId])
  ).rows[0]!.id;

  const restrictedMovie = (
    await rawClient.query<{ id: string }>("SELECT id FROM catalog_items WHERE title = 'After Hours Redline'")
  ).rows[0]!;
  restrictedItemId = restrictedMovie.id;
  restrictedFileId = (
    await rawClient.query<{ id: string }>('SELECT id FROM media_files WHERE item_id = $1', [restrictedItemId])
  ).rows[0]!.id;

  const generalLibraryIds = (
    await rawClient.query<{ id: string }>("SELECT id FROM libraries WHERE content_class = 'general'")
  ).rows.map((r) => r.id);
  const allLibraryIds = (await rawClient.query<{ id: string }>('SELECT id FROM libraries')).rows.map((r) => r.id);

  adminClearedCtx = { userId: adminId, allowedLibraryIds: allLibraryIds, restrictedCleared: true };
  adminUnclearedCtx = { userId: adminId, allowedLibraryIds: generalLibraryIds, restrictedCleared: false };

  const device = await rawClient.query<{ id: string; name: string }>(
    'SELECT id, name FROM devices WHERE user_id = $1 LIMIT 1',
    [adminId]
  );
  adminDeviceId = device.rows[0]!.id;
  adminDeviceName = device.rows[0]!.name;
});

afterAll(async () => {
  await rawClient.end();
  await db.destroy();
});

describe('listActiveSessionsAdmin (STATE.md P2.8/deliverable E)', () => {
  it('a general-item session is fully visible to any admin ctx (cleared or not)', async () => {
    const session = await createPlaybackSession(db, adminClearedCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs: Date.now(),
    });
    expect(session).toBeDefined();

    const clearedPage = await listActiveSessionsAdmin(db, adminClearedCtx);
    const clearedRow = clearedPage.rows.find((r) => r.id === session!.id);
    expect(clearedRow).toBeDefined();
    expect(clearedRow!.itemId).toBe(harborLightsItemId);
    expect(clearedRow!.itemTitle).toBe('Harbor Lights');
    expect(clearedRow!.contentHidden).toBe(false);
    expect(clearedRow!.username).toBe('admin');
    expect(clearedRow!.deviceId).toBe(adminDeviceId);
    expect(clearedRow!.deviceName).toBe(adminDeviceName);
    // General-item session: plan/engineVersion visible regardless of this
    // admin's OWN restricted clearance (nothing restricted about it).
    expect(clearedRow!.plan).toEqual({ decision: 'direct-play', reasons: [] });
    expect(clearedRow!.engineVersion).toBe('phase2-static');

    const unclearedPage = await listActiveSessionsAdmin(db, adminUnclearedCtx);
    const unclearedRow = unclearedPage.rows.find((r) => r.id === session!.id);
    expect(unclearedRow).toBeDefined();
    expect(unclearedRow!.itemTitle).toBe('Harbor Lights');
    expect(unclearedRow!.contentHidden).toBe(false);
    expect(unclearedRow!.plan).toEqual({ decision: 'direct-play', reasons: [] });
    expect(unclearedRow!.engineVersion).toBe('phase2-static');
  });

  it('a restricted-item session: visible with title+plan to a cleared ctx, redacted (itemTitle/plan/engineVersion null + contentHidden true) to an uncleared ctx — SAME admin user both times', async () => {
    const distinctivePlan = {
      decision: 'transcode',
      reasons: [{ code: 'video-codec-unsupported', detail: 'After Hours Redline needs HEVC transcode' }],
    };
    const session = await createPlaybackSession(db, adminClearedCtx, {
      itemId: restrictedItemId,
      fileId: restrictedFileId,
      deviceId: adminDeviceId,
      plan: distinctivePlan,
      engineVersion: 'phase3-engine-1.0.0',
      nowMs: Date.now(),
    });
    expect(session).toBeDefined();

    // Direction 1: cleared -> title + plan (the "why is this transcoding"
    // reasons view, deliverable D) both visible.
    const clearedPage = await listActiveSessionsAdmin(db, adminClearedCtx);
    const clearedRow = clearedPage.rows.find((r) => r.id === session!.id);
    expect(clearedRow).toBeDefined();
    expect(clearedRow!.itemId).toBe(restrictedItemId);
    expect(clearedRow!.itemTitle).toBe('After Hours Redline');
    expect(clearedRow!.contentHidden).toBe(false);
    expect(clearedRow!.plan).toEqual(distinctivePlan);
    expect(clearedRow!.engineVersion).toBe('phase3-engine-1.0.0');

    // Direction 2: uncleared -> the SESSION ROW STILL APPEARS (never
    // silently dropped — see listActiveSessionsAdmin's doc comment), but
    // itemTitle/plan/engineVersion are null and contentHidden is true. The
    // itemId itself is intentionally still surfaced (it is not restricted-
    // content, only the title/plan/metadata is) — this mirrors what the row
    // shape documents. plan is REDACTED (null), not OMITTED (key absent) —
    // same posture as itemTitle, tested the same way.
    const unclearedPage = await listActiveSessionsAdmin(db, adminUnclearedCtx);
    const unclearedRow = unclearedPage.rows.find((r) => r.id === session!.id);
    expect(unclearedRow).toBeDefined();
    expect(unclearedRow!.itemTitle).toBeNull();
    expect(unclearedRow!.contentHidden).toBe(true);
    expect(unclearedRow!.plan).toBeNull();
    expect('plan' in unclearedRow!).toBe(true); // redacted, not omitted
    expect(unclearedRow!.engineVersion).toBeNull();
    // Never leak the title, or anything from the plan (which itself named
    // the title in its `detail` string), anywhere in the row.
    expect(JSON.stringify(unclearedRow)).not.toContain('After Hours Redline');
  });
});
