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

  adminClearedCtx = { userId: adminId, allowedLibraryIds: allLibraryIds, restrictedCleared: true, surface: 'restricted' };
  adminUnclearedCtx = { userId: adminId, allowedLibraryIds: generalLibraryIds, restrictedCleared: false, surface: 'restricted' };

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

// ---------------------------------------------------------------------------
// browser-admin-F2 (QA 2026-08-20/21, P1): listActiveSessionsAdmin used to
// hard-filter `status IN ('created','active')`, so the moment the
// segment-ahead throttle flipped a steady-state transcode to `suspended`
// (apps/worker/src/transcode/throttle.ts, ~30s into a real 4K stream) the
// row vanished from BOTH admin monitoring surfaces while the viewer was
// still watching. `suspended`/`starting`/`seeking` are live states, not
// terminal ones — the only genuinely-over statuses are `ended`/`failed`.
// ---------------------------------------------------------------------------
describe('listActiveSessionsAdmin — live (non-terminal) statuses (browser-admin-F2)', () => {
  async function setStatus(sessionId: string, status: string, byThrottle = false): Promise<void> {
    await rawClient.query('UPDATE playback_sessions SET status = $2, suspended_by_throttle = $3 WHERE id = $1', [
      sessionId,
      status,
      byThrottle,
    ]);
  }

  async function seedSession(): Promise<string> {
    const session = await createPlaybackSession(db, adminClearedCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'phase3-engine-1.0.0',
      nowMs: Date.now(),
    });
    expect(session).toBeDefined();
    return session!.id;
  }

  it('keeps a THROTTLE-suspended session listed, with status suspended (the row an admin must still see while the viewer watches)', async () => {
    const id = await seedSession();
    await setStatus(id, 'suspended', true);

    const page = await listActiveSessionsAdmin(db, adminClearedCtx);
    const row = page.rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('suspended');
    // Still fully rendered — the suspend changes nothing about redaction.
    expect(row!.itemTitle).toBe('Harbor Lights');
    expect(row!.plan).toEqual({ decision: 'transcode', reasons: [] });
  });

  it('keeps a HEARTBEAT-suspended session listed too (same enum value, server-authored cause)', async () => {
    const id = await seedSession();
    await setStatus(id, 'suspended', false);

    const page = await listActiveSessionsAdmin(db, adminClearedCtx);
    expect(page.rows.find((r) => r.id === id)?.status).toBe('suspended');
  });

  it('lists starting and seeking sessions (both mid-flight, neither terminal)', async () => {
    const startingId = await seedSession();
    await setStatus(startingId, 'starting');
    const seekingId = await seedSession();
    await setStatus(seekingId, 'seeking');

    const page = await listActiveSessionsAdmin(db, adminClearedCtx);
    expect(page.rows.find((r) => r.id === startingId)?.status).toBe('starting');
    expect(page.rows.find((r) => r.id === seekingId)?.status).toBe('seeking');
  });

  it('still excludes the terminal statuses (ended/failed) — this is a now-playing feed, not a history', async () => {
    const endedId = await seedSession();
    await setStatus(endedId, 'ended');
    const failedId = await seedSession();
    await setStatus(failedId, 'failed');

    const page = await listActiveSessionsAdmin(db, adminClearedCtx, { limit: 200 });
    expect(page.rows.find((r) => r.id === endedId)).toBeUndefined();
    expect(page.rows.find((r) => r.id === failedId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// d3-e3 (browser-admin-F2 follow-up, P2): widening the status filter above
// fixed the disappearing-transcode half and created the opposite problem —
// an ABANDONED session (walked-away viewer) is suspended by the sweeper at
// 90s and only ENDED at 15 minutes, so for ~13.5 minutes it sat on the admin
// dashboard looking exactly like a healthy throttle-parked stream. The row
// carried nothing that could tell the two apart: `suspended` is one enum
// value with two causes, and the disambiguator the schema has had since
// migration 0012 (suspended_by_throttle) was never selected. These two
// derived fields are what the surfaces render/count on.
// ---------------------------------------------------------------------------
describe('listActiveSessionsAdmin — presence disambiguation (d3-e3)', () => {
  async function seedSession(nowMs: number): Promise<string> {
    const session = await createPlaybackSession(db, adminClearedCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'phase3-engine-1.0.0',
      nowMs,
    });
    expect(session).toBeDefined();
    return session!.id;
  }

  it('carries suspended_by_throttle: true for a worker-parked transcode, false for a sweeper heartbeat-suspend', async () => {
    const nowMs = Date.now();
    const throttled = await seedSession(nowMs);
    await rawClient.query(
      "UPDATE playback_sessions SET status = 'suspended', suspended_by_throttle = true WHERE id = $1",
      [throttled]
    );
    const abandoned = await seedSession(nowMs);
    await rawClient.query(
      "UPDATE playback_sessions SET status = 'suspended', suspended_by_throttle = false WHERE id = $1",
      [abandoned]
    );

    const page = await listActiveSessionsAdmin(db, adminClearedCtx, { limit: 200 });
    expect(page.rows.find((r) => r.id === throttled)!.suspendedByThrottle).toBe(true);
    expect(page.rows.find((r) => r.id === abandoned)!.suspendedByThrottle).toBe(false);
  });

  it('flags heartbeatStale against the caller-supplied boundary — the same (lastHeartbeatMs ?? startedAtMs) predicate the sweeper suspends on', async () => {
    const nowMs = Date.now();
    const fresh = await seedSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET last_heartbeat_ms = $2 WHERE id = $1', [fresh, nowMs]);
    const stale = await seedSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET last_heartbeat_ms = $2 WHERE id = $1', [
      stale,
      nowMs - 120_000,
    ]);

    const page = await listActiveSessionsAdmin(db, adminClearedCtx, {
      limit: 200,
      heartbeatStaleBeforeMs: nowMs - 90_000,
    });
    expect(page.rows.find((r) => r.id === fresh)!.heartbeatStale).toBe(false);
    expect(page.rows.find((r) => r.id === stale)!.heartbeatStale).toBe(true);
  });

  it('falls back to startedAtMs for a session that never sent a heartbeat at all (the walked-away-at-the-start case)', async () => {
    const nowMs = Date.now();
    const justStarted = await seedSession(nowMs);
    const longAgo = await seedSession(nowMs - 600_000);

    const page = await listActiveSessionsAdmin(db, adminClearedCtx, {
      limit: 200,
      heartbeatStaleBeforeMs: nowMs - 90_000,
    });
    const justStartedRow = page.rows.find((r) => r.id === justStarted)!;
    const longAgoRow = page.rows.find((r) => r.id === longAgo)!;
    expect(justStartedRow.lastHeartbeatMs).toBeNull();
    expect(longAgoRow.lastHeartbeatMs).toBeNull();
    expect(justStartedRow.heartbeatStale).toBe(false);
    expect(longAgoRow.heartbeatStale).toBe(true);
  });

  it('claims nothing stale when no boundary is supplied (a caller with no clock/cutoff never gets a guessed answer)', async () => {
    const ancient = await seedSession(Date.now() - 3_600_000);

    const page = await listActiveSessionsAdmin(db, adminClearedCtx, { limit: 200 });
    expect(page.rows.find((r) => r.id === ancient)!.heartbeatStale).toBe(false);
  });
});
