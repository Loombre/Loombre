// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/playback-sessions.spec.ts
//
// Live-DB tests for src/query/playback-sessions.ts and
// src/query/media-info.ts (Wave-1 lane B, P2.4/P2.13/P2.14/P2.17).
// SELF-SUFFICIENT (resets + reseeds in its own beforeAll, same convention
// as test/leak.spec.ts and test/catalog-detail.spec.ts — this package's
// vitest.config.ts forces sequential file execution for exactly this
// reason).
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb } from '../src/db.js';
import type { DB } from '../src/types.js';
import type { ViewerContext } from '../src/context.js';
import { getMediaInfoAssembly } from '../src/query/media-info.js';
import {
  countActiveTranscodeSessions,
  createPlaybackSession,
  endPlaybackSession,
  endStalePlaybackSession,
  evictStalestSuspendedTranscodeSession,
  getMediaFileForPlaybackSession,
  getPlaybackSessionForUser,
  heartbeatPlaybackSession,
  listHeartbeatStalePlaybackSessions,
  listStalePlaybackSessions,
  requestRungSwitch,
  requestSeek,
  requestSeekWithRungSwitch,
  suspendStalePlaybackSession,
  updateRequestedSegment,
} from '../src/query/playback-sessions.js';
import { getProgressForItem, upsertProgress } from '../src/query/progress-write.js';
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
    throw new Error(`${script} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: Kysely<DB>;
let rawClient: pg.Client;

let adminId: string;
let casualId: string;
let harborLightsItemId: string;
let harborLightsFileId: string;
let restrictedItemId: string;
let restrictedFileId: string;

let adminCtx: ViewerContext;
let casualCtx: ViewerContext; // general-only, restrictedCleared: false
let adminDeviceId: string;

/** Scoped to a specific sessionId — several tests in
 *  this file create/end sessions back-to-back with test-controlled `nowMs`
 *  values that can tie (or even go non-monotonic relative to real wall
 *  time), so "the most recent row of this type" is not reliably "the one
 *  THIS test just wrote". Filtering on the payload's own sessionId is. */
async function eventForSession(type: string, sessionId: string): Promise<{ payload: Record<string, unknown> } | undefined> {
  const { rows } = await rawClient.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events WHERE type = $1 AND payload ->> 'sessionId' = $2 ORDER BY ts_ms DESC LIMIT 1`,
    [type, sessionId],
  );
  return rows[0];
}

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);
  run(path.join(PKG_ROOT, 'seed', 'seed.mjs'), []);

  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  adminId = (await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")).rows[0]!.id;
  casualId = (await rawClient.query<{ id: string }>("SELECT id FROM users WHERE username = 'casual'")).rows[0]!.id;

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

  adminCtx = { userId: adminId, allowedLibraryIds: allLibraryIds, restrictedCleared: true, surface: 'restricted' };
  casualCtx = { userId: casualId, allowedLibraryIds: generalLibraryIds, restrictedCleared: false, surface: 'restricted' };

  adminDeviceId = (
    await rawClient.query<{ id: string }>('SELECT id FROM devices WHERE user_id = $1 LIMIT 1', [adminId])
  ).rows[0]!.id;
});

afterAll(async () => {
  await rawClient.end();
  await db.destroy();
});

describe('getMediaInfoAssembly', () => {
  it('assembles MediaInfo from media_files + media_streams for a visible item', async () => {
    const result = await getMediaInfoAssembly(db, adminCtx, { itemId: harborLightsItemId });
    expect(result).toBeDefined();
    expect(result!.itemId).toBe(harborLightsItemId);
    expect(result!.fileId).toBe(harborLightsFileId);
    expect(result!.media.container).toBe('mkv');
    expect(result!.media.video).toHaveLength(1);
    expect(result!.media.video[0]!.codec).toBe('hevc');
    expect(result!.media.video[0]!.width).toBe(3840);
    expect(result!.media.audio).toHaveLength(1);
    expect(result!.media.audio[0]!.codec).toBe('eac3');
    expect(result!.media.audio[0]!.channels).toBe(6);
    expect(result!.media.durationMs).toBeGreaterThan(0);
    expect(result!.media.overallBitrateBps).toBeGreaterThan(0);
  });

  it('resolves by fileId directly', async () => {
    const result = await getMediaInfoAssembly(db, adminCtx, { fileId: harborLightsFileId });
    expect(result?.itemId).toBe(harborLightsItemId);
  });

  it('returns undefined for a restricted item when the viewer is not cleared', async () => {
    const result = await getMediaInfoAssembly(db, casualCtx, { itemId: restrictedItemId });
    expect(result).toBeUndefined();
  });

  it('returns undefined for a nonexistent item (indistinguishable from invisible)', async () => {
    const result = await getMediaInfoAssembly(db, adminCtx, { itemId: '11111111-1111-4111-8111-111111111111' });
    expect(result).toBeUndefined();
  });

  // STATE.md H3 (v1.1 widening, docs/PLAYBACK.md §2.1): the CONTAINERS
  // whitelist this module gates on (a probed-but-container-outside-the-set
  // row is treated as "not ready", same as an unprobed one) must include
  // every closed Container union member — a real ground-truth risk this
  // lane's recon surfaced beyond the orchestrator's originally-enumerated 5
  // sites: forgetting to widen this set would silently make every
  // legitimately-probed .wmv/.mpg/.flv/.aac/.aiff file's MediaInfo
  // unassemblable forever (getMediaInfoAssembly returns undefined exactly
  // as it would for an unprobed file), even though probe itself succeeded.
  it('assembles MediaInfo for a v1.1-reinstated container (asf) once probed — proves the CONTAINERS whitelist was widened alongside the Container union', async () => {
    const fileId = (
      await rawClient.query<{ id: string }>(
        `INSERT INTO media_files (item_id, path, container, duration_ms, size_bytes, probed_at_ms)
         VALUES ($1, $2, 'asf', 1000, 123456, $3) RETURNING id`,
        [harborLightsItemId, '/test-fixtures/h3/legacy-widening-check.wmv', Date.now()],
      )
    ).rows[0]!.id;

    const result = await getMediaInfoAssembly(db, adminCtx, { fileId });
    expect(result).toBeDefined();
    expect(result!.media.container).toBe('asf');
  });
});

describe('createPlaybackSession', () => {
  it('creates a session + emits playback.started in the same transaction', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });

    expect(session).toBeDefined();
    expect(session!.userId).toBe(adminId);
    expect(session!.fileId).toBe(harborLightsFileId);
    expect(session!.itemId).toBe(harborLightsItemId);
    expect(session!.engineVersion).toBe('phase2-static');
    expect(session!.status).toBe('active');
    expect(session!.plan).toEqual({ decision: 'direct-play', reasons: [] });

    const event = await eventForSession('playback.started', session!.id);
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({
      sessionId: session!.id,
      itemId: harborLightsItemId,
      deviceId: adminDeviceId,
      decision: 'direct-play',
    });
  });

  it('returns undefined when the item is invisible to ctx (restricted, uncleared)', async () => {
    const session = await createPlaybackSession(db, casualCtx, {
      itemId: restrictedItemId,
      fileId: restrictedFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs: Date.now(),
    });
    expect(session).toBeUndefined();
  });

  it('returns undefined when fileId does not belong to itemId', async () => {
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: restrictedFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs: Date.now(),
    });
    expect(session).toBeUndefined();
  });
});

describe('getPlaybackSessionForUser / getMediaFileForPlaybackSession', () => {
  it('cross-user access returns undefined; owner sees the session', async () => {
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs: Date.now(),
    });
    expect(session).toBeDefined();

    const asOwner = await getPlaybackSessionForUser(db, adminCtx, session!.id);
    expect(asOwner?.id).toBe(session!.id);

    const asOtherUser = await getPlaybackSessionForUser(db, casualCtx, session!.id);
    expect(asOtherUser).toBeUndefined();
  });

  it('returns the raw media file row for byte-serving', async () => {
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs: Date.now(),
    });
    const file = await getMediaFileForPlaybackSession(db, session!.fileId!);
    expect(file?.container).toBe('mkv');
    expect(file?.path).toContain('Harbor.Lights');
  });
});

describe('heartbeatPlaybackSession / endPlaybackSession', () => {
  it('heartbeat bumps last_heartbeat_ms and keeps status active; rejects non-owner and ended sessions', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });

    const heartbeatMs = nowMs + 60_000;
    const beat = await heartbeatPlaybackSession(db, adminCtx, session!.id, heartbeatMs);
    expect(beat?.lastHeartbeatMs).toBe(heartbeatMs);
    expect(beat?.status).toBe('active');

    const beatByOther = await heartbeatPlaybackSession(db, casualCtx, session!.id, heartbeatMs);
    expect(beatByOther).toBeUndefined();

    const ended = await endPlaybackSession(db, adminCtx, session!.id, heartbeatMs + 1000);
    expect(ended?.status).toBe('ended');

    const beatAfterEnd = await heartbeatPlaybackSession(db, adminCtx, session!.id, heartbeatMs + 2000);
    expect(beatAfterEnd).toBeUndefined();
  });

  // V1-006 class, this file: heartbeatPlaybackSession's own leading SELECT
  // already guards on `status IN ('created','active')` (the sequential case
  // just above), but that guard is stale by the time the UPDATE runs — the
  // UPDATE itself only ever filtered on `id`, trusting the SELECT. Real
  // Postgres row-lock race (same technique as
  // transcode-sessions.spec.ts's consumeSeekTarget test): a second
  // connection holds the row past heartbeatPlaybackSession's SELECT, ends
  // the session first, commits (releasing the lock), and only then does
  // heartbeatPlaybackSession's UPDATE proceed — proving the UPDATE must
  // re-check status itself or a heartbeat can resurrect a session another
  // actor (the sweeper, the DELETE endpoint) just closed out.
  it('does not resurrect a session ended by a concurrent actor mid-heartbeat (real Postgres row-lock race)', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });

    const locker = new pg.Client({ connectionString: DATABASE_URL });
    await locker.connect();
    let heartbeatPromise: ReturnType<typeof heartbeatPlaybackSession>;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT * FROM playback_sessions WHERE id = $1 FOR UPDATE', [session!.id]);

      heartbeatPromise = heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs + 1000);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Close the session out (e.g. the sweeper's idle-timeout), still
      // holding the lock, then commit.
      await locker.query(
        "UPDATE playback_sessions SET status = 'failed', error_code = 'heartbeat-timeout', ended_at_ms = $2, updated_at_ms = $2 WHERE id = $1",
        [session!.id, nowMs + 500],
      );
      await locker.query('COMMIT'); // releases the lock; the heartbeat's UPDATE can now run
    } finally {
      await locker.end();
    }

    const result = await heartbeatPromise;
    expect(result).toBeUndefined(); // "a heartbeat cannot revive a dead session" (docstring)

    const row = await getPlaybackSessionForUser(db, adminCtx, session!.id);
    expect(row?.status).toBe('failed'); // NOT resurrected to 'active'
    expect(row?.errorCode).toBe('heartbeat-timeout');
  });

  it('end emits playback.ended, is idempotent, and rejects non-owner', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });

    const endedByOther = await endPlaybackSession(db, casualCtx, session!.id, nowMs + 1000);
    expect(endedByOther).toBeUndefined();

    const ended = await endPlaybackSession(db, adminCtx, session!.id, nowMs + 2000);
    expect(ended?.status).toBe('ended');
    expect(ended?.endedAtMs).toBe(nowMs + 2000);

    const event = await eventForSession('playback.ended', session!.id);
    expect(event?.payload).toMatchObject({ sessionId: session!.id, itemId: harborLightsItemId, reason: 'client-stopped' });

    const eventCountBefore = (await rawClient.query('SELECT count(*)::int AS n FROM events WHERE type = $1', ['playback.ended']))
      .rows[0].n;

    // Idempotent re-end: no new event, same row.
    const endedAgain = await endPlaybackSession(db, adminCtx, session!.id, nowMs + 3000);
    expect(endedAgain?.endedAtMs).toBe(nowMs + 2000);

    const eventCountAfter = (await rawClient.query('SELECT count(*)::int AS n FROM events WHERE type = $1', ['playback.ended']))
      .rows[0].n;
    expect(eventCountAfter).toBe(eventCountBefore);
  });

  // V1-006 class, this file: the sequential idempotent-re-end case above
  // only exercises finalizeSession's CALLER-side check (endPlaybackSession's
  // own `if (current.status === 'ended' || ...) return mapRow(current)`,
  // evaluated against ITS SELECT). finalizeSession's own UPDATE — shared by
  // endPlaybackSession AND endStalePlaybackSession — filtered only on `id`,
  // trusting that stale caller-side check. Same real-lock race technique:
  // a second connection holds the row past the caller's SELECT, closes the
  // session out FIRST (a different cause/reason), commits, and only then
  // does finalizeSession's UPDATE proceed — proving it must re-check status
  // itself or it overwrites one terminal state with another and
  // double-emits playback.ended.
  it('does not overwrite a session closed by a concurrent actor mid-call, and does not double-emit playback.ended (real Postgres row-lock race)', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });

    const locker = new pg.Client({ connectionString: DATABASE_URL });
    await locker.connect();
    let endPromise: ReturnType<typeof endPlaybackSession>;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT * FROM playback_sessions WHERE id = $1 FOR UPDATE', [session!.id]);

      endPromise = endPlaybackSession(db, adminCtx, session!.id, nowMs + 2000); // client-stopped
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The sweeper (endStalePlaybackSession) closes it out FIRST, still
      // holding the lock — status update AND its own playback.ended event,
      // exactly like the real function does in the same transaction — then
      // commits.
      await locker.query(
        "UPDATE playback_sessions SET status = 'failed', error_code = 'heartbeat-timeout', ended_at_ms = $2, updated_at_ms = $2 WHERE id = $1",
        [session!.id, nowMs + 1500],
      );
      await locker.query(
        `INSERT INTO events (type, ts_ms, payload) VALUES ('playback.ended', $1, $2::jsonb)`,
        [nowMs + 1500, JSON.stringify({ sessionId: session!.id, itemId: harborLightsItemId, reason: 'idle-timeout', errorCode: 'heartbeat-timeout', finalPositionMs: null, endedAtMs: nowMs + 1500 })],
      );
      await locker.query('COMMIT'); // releases the lock; endPlaybackSession's finalizeSession UPDATE can now run
    } finally {
      await locker.end();
    }

    const result = await endPromise;
    // Idempotent contract (docstring): must see the row as the actual
    // winner left it, not overwrite 'failed' -> 'ended'.
    expect(result?.status).toBe('failed');
    expect(result?.errorCode).toBe('heartbeat-timeout');
    expect(result?.endedAtMs).toBe(nowMs + 1500);

    const row = await getPlaybackSessionForUser(db, adminCtx, session!.id);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('heartbeat-timeout');

    // Exactly one playback.ended event for this session — the sweeper's,
    // not a second one from endPlaybackSession racing behind it.
    const { rows } = await rawClient.query(
      `SELECT payload FROM events WHERE type = 'playback.ended' AND payload ->> 'sessionId' = $1`,
      [session!.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ reason: 'idle-timeout', errorCode: 'heartbeat-timeout' } as never);
  });

  it('errorCode transitions status to failed', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });
    const failed = await endPlaybackSession(db, adminCtx, session!.id, nowMs + 500, 'stream-error');
    expect(failed?.status).toBe('failed');
    expect(failed?.errorCode).toBe('stream-error');
  });
});

describe('sweeper: listStalePlaybackSessions / endStalePlaybackSession', () => {
  it('finds sessions past the heartbeat cutoff and ends them with idle-timeout', async () => {
    const staleStartMs = Date.now() - 20 * 60_000; // 20 min ago
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs: staleStartMs,
    });
    // Backdate started_at_ms directly (createPlaybackSession always uses
    // nowMs for both started_at_ms and updated_at_ms, which is what we want
    // here — no separate raw UPDATE needed).
    const cutoffMs = Date.now() - 15 * 60_000;

    const stale = await listStalePlaybackSessions(db, cutoffMs);
    expect(stale.some((s) => s.id === session!.id)).toBe(true);

    const swept = await endStalePlaybackSession(db, session!.id, Date.now());
    expect(swept?.status).toBe('failed');
    expect(swept?.errorCode).toBe('heartbeat-timeout');

    const event = await eventForSession('playback.ended', session!.id);
    expect(event?.payload).toMatchObject({ sessionId: session!.id, reason: 'idle-timeout' });

    // No longer in the stale set once ended.
    const staleAfter = await listStalePlaybackSessions(db, cutoffMs);
    expect(staleAfter.some((s) => s.id === session!.id)).toBe(false);
  });

  it('a fresh session (recent heartbeat) is not swept', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });
    await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs);

    const cutoffMs = nowMs - 15 * 60_000;
    const stale = await listStalePlaybackSessions(db, cutoffMs);
    expect(stale.some((s) => s.id === session!.id)).toBe(false);
  });

  it('endStalePlaybackSession returns undefined for a nonexistent session id', async () => {
    const result = await endStalePlaybackSession(db, '11111111-1111-4111-8111-111111111111', Date.now());
    expect(result).toBeUndefined();
  });

  // Item C7 (process-lifecycle hardening wave (2026-08-11)): the ORPHAN SIGNATURE
  // breadcrumb. "The heartbeat sweeper ended this session" AND "a
  // transcode job-ledger row is still active" AND "the session still names
  // a live ffmpeg pid" is precisely the combination that used to mean a
  // detached encoder was about to keep running with its admission slot
  // handed to the next viewer. The boot reaper (C2) cleans it up on the
  // next restart; this WARN is what makes it visible BEFORE the restart,
  // in the logs of the process that caused it.
  it('WARNs when it ends a session that still names a live pipeline while a transcode job is active', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const session = await createPlaybackSession(db, adminCtx, {
        itemId: harborLightsItemId,
        fileId: harborLightsFileId,
        deviceId: adminDeviceId,
        plan: { decision: 'transcode', reasons: [] },
        engineVersion: 'test',
        nowMs: Date.now(),
      });
      await rawClient.query(
        `UPDATE playback_sessions SET worker_pid = 31337, worker_started_at_ms = $2, staging_dir = '/tmp/x' WHERE id = $1`,
        [session!.id, Date.now()],
      );
      const jobId = randomUUID();
      await rawClient.query(
        `INSERT INTO jobs (id, type, status, created_at_ms, updated_at_ms) VALUES ($1, 'transcode', 'active', $2, $2)`,
        [jobId, Date.now()],
      );

      await endStalePlaybackSession(db, session!.id, Date.now());

      const messages = warn.mock.calls.map((c) => c.join(' '));
      expect(messages.some((m) => m.includes(session!.id))).toBe(true);
      expect(messages.some((m) => m.includes('31337'))).toBe(true);

      await rawClient.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet for an ordinary swept session (no pipeline recorded)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const session = await createPlaybackSession(db, adminCtx, {
        itemId: harborLightsItemId,
        fileId: harborLightsFileId,
        deviceId: adminDeviceId,
        plan: { decision: 'direct-play', reasons: [] },
        engineVersion: 'phase2-static',
        nowMs: Date.now(),
      });
      await endStalePlaybackSession(db, session!.id, Date.now());
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('heartbeatPlaybackSession progress-event throttle (STATE.md P2.8, at most once per 30s per session)', () => {
  it('omitting `progress` never emits playback.progress, even repeatedly', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });

    await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs + 1000);
    await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs + 2000);

    const event = await eventForSession('playback.progress', session!.id);
    expect(event).toBeUndefined();
  });

  it('the first heartbeat WITH progress emits playback.progress immediately', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });

    const beat = await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs + 1000, {
      positionMs: 5000,
      durationMs: 6_000_000,
    });
    expect(beat?.lastHeartbeatMs).toBe(nowMs + 1000);

    const event = await eventForSession('playback.progress', session!.id);
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({
      sessionId: session!.id,
      itemId: harborLightsItemId,
      deviceId: adminDeviceId,
      positionMs: 5000,
      durationMs: 6_000_000,
      updatedAtMs: nowMs + 1000,
    });
  });

  it('a second heartbeat within 30s of the last EMITTED event does not emit again; one after 30s does', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'phase2-static',
      nowMs,
    });

    await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs + 1000, { positionMs: 1000 });
    const countAfterFirst = (
      await rawClient.query('SELECT count(*)::int AS n FROM events WHERE type = $1 AND payload ->> $2 = $3', [
        'playback.progress',
        'sessionId',
        session!.id,
      ])
    ).rows[0].n;
    expect(countAfterFirst).toBe(1);

    // 10s later (well under the 30s throttle, and would have been enough
    // to accumulate to 30s across MULTIPLE such calls if the throttle
    // incorrectly used last_heartbeat_ms instead of a dedicated marker —
    // see migration 0007's header) — must NOT emit a second event.
    await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs + 11_000, { positionMs: 11_000 });
    await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs + 21_000, { positionMs: 21_000 });
    const countAfterTwoMore = (
      await rawClient.query('SELECT count(*)::int AS n FROM events WHERE type = $1 AND payload ->> $2 = $3', [
        'playback.progress',
        'sessionId',
        session!.id,
      ])
    ).rows[0].n;
    expect(countAfterTwoMore).toBe(1);

    // >=30s since the FIRST emitted event (nowMs+1000) -> emits again.
    await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs + 31_500, { positionMs: 31_500 });
    const finalCount = (
      await rawClient.query('SELECT count(*)::int AS n FROM events WHERE type = $1 AND payload ->> $2 = $3', [
        'playback.progress',
        'sessionId',
        session!.id,
      ])
    ).rows[0].n;
    expect(finalCount).toBe(2);

    const latest = await eventForSession('playback.progress', session!.id);
    expect(latest!.payload).toMatchObject({ positionMs: 31_500, updatedAtMs: nowMs + 31_500 });
  });
});

describe('upsertProgress durationMs', () => {
  it('stores durationMs and preserves it across a heartbeat that omits it', async () => {
    const first = await upsertProgress(db, adminCtx, harborLightsItemId, {
      positionMs: 1000,
      state: 'in-progress',
      nowMs: Date.now(),
      durationMs: 6_480_000,
    });
    expect(first?.durationMs).toBe(6_480_000);

    const second = await upsertProgress(db, adminCtx, harborLightsItemId, {
      positionMs: 2000,
      state: 'in-progress',
      nowMs: Date.now() + 1000,
    });
    expect(second?.durationMs).toBe(6_480_000);
  });
});

// Phase 3 §11 step 6a — server-written control-channel columns
// (migrations/0012_transcode_sessions.sql). These back Lane B's future
// segment-serving/seek endpoints; this lane implements + tests them ahead
// of Lane B landing so the seam is ready-made.
describe('updateRequestedSegment / requestSeek (server-written control columns)', () => {
  it('updates requested_segment for the owner; rejects non-owner and terminal sessions', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs,
    });

    const updated = await updateRequestedSegment(db, adminCtx, session!.id, 7, nowMs + 100);
    expect(updated?.requestedSegment).toBe(7);

    const byOther = await updateRequestedSegment(db, casualCtx, session!.id, 9, nowMs + 200);
    expect(byOther).toBeUndefined();

    await endPlaybackSession(db, adminCtx, session!.id, nowMs + 300);
    const afterEnd = await updateRequestedSegment(db, adminCtx, session!.id, 11, nowMs + 400);
    expect(afterEnd).toBeUndefined();
  });

  it('records a seek target the worker can later consume; rejects non-owner and terminal sessions', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs,
    });

    const seeked = await requestSeek(db, adminCtx, session!.id, 65_000, nowMs + 100);
    expect(seeked?.seekTargetMs).toBe(65_000);

    const byOther = await requestSeek(db, casualCtx, session!.id, 70_000, nowMs + 200);
    expect(byOther).toBeUndefined();

    await endPlaybackSession(db, adminCtx, session!.id, nowMs + 300);
    const afterEnd = await requestSeek(db, adminCtx, session!.id, 80_000, nowMs + 400);
    expect(afterEnd).toBeUndefined();
  });
});

// Wave C2 / migration 0044 (docs/PLAYBACK.md §9.1.3). The SERVER half of
// the slot-handoff control channel: a `v{K}` playlist/segment GET naming a
// rung other than the session's active one records a switch request, which
// the worker consumes at its next tick.
describe('requestRungSwitch (server-written, absorb-on-match at the WRITE side)', () => {
  async function newTranscodeSession(nowMs: number): Promise<string> {
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs,
    });
    return session!.id;
  }

  it('records a pending rung the worker can later consume', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET active_rung_index = 0 WHERE id = $1', [id]);

    const switched = await requestRungSwitch(db, adminCtx, id, 2, nowMs + 100);
    expect(switched?.pendingRungIndex).toBe(2);
  });

  it('ABSORBS a request naming the already-active rung — nothing is recorded (§9.1.3)', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET active_rung_index = 1 WHERE id = $1', [id]);

    // A client pinned to rung 1 keeps fetching `v1/...` — every one of
    // those GETs would otherwise write a "switch" the worker has to read
    // and discard. This is the switch analogue of seek absorption, and it
    // kills the storm at the door rather than at the poll tick.
    const same = await requestRungSwitch(db, adminCtx, id, 1, nowMs + 100);
    expect(same?.pendingRungIndex).toBeNull();
    const { rows } = await rawClient.query<{ pending_rung_index: number | null }>(
      'SELECT pending_rung_index FROM playback_sessions WHERE id = $1',
      [id],
    );
    expect(rows[0]?.pending_rung_index).toBeNull();
  });

  it('rung 0 is a real target, never confused with "no active rung"', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET active_rung_index = 2 WHERE id = $1', [id]);
    expect((await requestRungSwitch(db, adminCtx, id, 0, nowMs + 100))?.pendingRungIndex).toBe(0);
  });

  it('records even when active_rung_index is still NULL (the worker has not spawned yet)', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    expect((await requestRungSwitch(db, adminCtx, id, 1, nowMs + 100))?.pendingRungIndex).toBe(1);
  });

  it('a LATER request overwrites an unconsumed earlier one (last write wins — the client changed its mind)', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    await requestRungSwitch(db, adminCtx, id, 1, nowMs + 100);
    expect((await requestRungSwitch(db, adminCtx, id, 2, nowMs + 200))?.pendingRungIndex).toBe(2);
  });

  it('rejects a non-owner and a terminal session, exactly like requestSeek', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    expect(await requestRungSwitch(db, casualCtx, id, 1, nowMs + 100)).toBeUndefined();
    await endPlaybackSession(db, adminCtx, id, nowMs + 200);
    expect(await requestRungSwitch(db, adminCtx, id, 1, nowMs + 300)).toBeUndefined();
  });

  it('exposes both rung columns on the mapped row (the controller reads activeRungIndex to decide switch-vs-noop)', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET active_rung_index = 0 WHERE id = $1', [id]);
    await requestRungSwitch(db, adminCtx, id, 2, nowMs + 100);
    const row = await getPlaybackSessionForUser(db, adminCtx, id);
    expect(row?.activeRungIndex).toBe(0);
    expect(row?.pendingRungIndex).toBe(2);
  });
});

// THE COINCIDENT WRITE (pre-D consolidation item 3a, C2 review finding
// f5). ONE segment GET can carry BOTH intentions — a far-ahead index (a
// seek) under a `v{K}` naming a different rung (a switch) — and hls.js
// produces exactly that whenever an ABR level change coincides with a
// user scrub, or when a level switch's first fragment request lands past
// the produced edge.
//
// The WORKER side of §9.1.7 already reads both columns in one tick and
// spawns ONE run for the pair. The WRITE side did not: two independent
// statements, and a poll tick landing between them consumes the switch
// alone (a handoff restart at the live-edge continuation origin) and then
// the seek on the next tick (a second restart, at the requested origin) —
// two of the most expensive operations this runtime performs, for one
// client intention, and the intermediate run produces bytes nobody wanted.
//
// A single statement makes that interleaving inexpressible rather than
// unlikely.
describe('requestSeekWithRungSwitch (§9.1.7 — one statement, both intentions)', () => {
  async function newTranscodeSession(nowMs: number): Promise<string> {
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs,
    });
    return session!.id;
  }

  it('writes both columns, so the worker can never observe one without the other', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET active_rung_index = 0 WHERE id = $1', [id]);

    const row = await requestSeekWithRungSwitch(db, adminCtx, id, 65_000, 2, nowMs + 100);
    expect(row?.seekTargetMs).toBe(65_000);
    expect(row?.pendingRungIndex).toBe(2);
  });

  it('keeps requestRungSwitch\'s absorb-on-match for the RUNG half while still recording the seek', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET active_rung_index = 1 WHERE id = $1', [id]);

    // A client pinned to rung 1 seeking within that rung: the seek is
    // real, the "switch" is not. Absorbing the pair wholesale would drop
    // the seek — the failure mode a naive single-statement merge with
    // requestRungSwitch's own WHERE clause would introduce.
    const row = await requestSeekWithRungSwitch(db, adminCtx, id, 65_000, 1, nowMs + 100);
    expect(row?.seekTargetMs).toBe(65_000);
    expect(row?.pendingRungIndex).toBeNull();
  });

  it('leaves an unconsumed pending rung for a DIFFERENT rung intact when absorbing the matching half', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    await rawClient.query('UPDATE playback_sessions SET active_rung_index = 1, pending_rung_index = 2 WHERE id = $1', [id]);

    // The absorbed rung half must be a NO-OP on the column, not a clear:
    // rung 2 is a request the worker still owes a handoff.
    const row = await requestSeekWithRungSwitch(db, adminCtx, id, 20_000, 1, nowMs + 100);
    expect(row?.seekTargetMs).toBe(20_000);
    expect(row?.pendingRungIndex).toBe(2);
  });

  it('records the rung while active_rung_index is still NULL (the worker has not spawned yet)', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    const row = await requestSeekWithRungSwitch(db, adminCtx, id, 12_000, 1, nowMs + 100);
    expect(row?.seekTargetMs).toBe(12_000);
    expect(row?.pendingRungIndex).toBe(1);
  });

  it('rejects a non-owner and a terminal session, exactly like its two halves', async () => {
    const nowMs = Date.now();
    const id = await newTranscodeSession(nowMs);
    expect(await requestSeekWithRungSwitch(db, casualCtx, id, 1_000, 1, nowMs + 100)).toBeUndefined();
    // Nothing was written by the rejected call.
    const { rows } = await rawClient.query<{ seek_target_ms: string | null }>('SELECT seek_target_ms FROM playback_sessions WHERE id = $1', [id]);
    expect(rows[0]?.seek_target_ms).toBeNull();

    await endPlaybackSession(db, adminCtx, id, nowMs + 200);
    expect(await requestSeekWithRungSwitch(db, adminCtx, id, 1_000, 1, nowMs + 300)).toBeUndefined();
  });
});

describe('listStalePlaybackSessions widened for transcode states (P3 §11 step 6a)', () => {
  it('catches a stale session sitting in "suspended", not just created/active', async () => {
    const staleStartMs = Date.now() - 20 * 60_000;
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs: staleStartMs,
    });
    await rawClient.query("UPDATE playback_sessions SET status = 'suspended' WHERE id = $1", [session!.id]);

    const cutoffMs = Date.now() - 15 * 60_000;
    const stale = await listStalePlaybackSessions(db, cutoffMs);
    expect(stale.some((s) => s.id === session!.id)).toBe(true);
  });
});

describe('listHeartbeatStalePlaybackSessions / suspendStalePlaybackSession (90s heartbeat-stale suspend, docs/PLAYBACK.md §9)', () => {
  it('finds an active session past the 90s cutoff and suspends it WITHOUT the throttle flag, WITHOUT playback.ended, but WITH a heartbeat-stale status-changed event (d4-f5)', async () => {
    const staleStartMs = Date.now() - 5 * 60_000;
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs: staleStartMs,
    });
    // A 'transcode' plan starts life 'created' (docs/PLAYBACK.md §9) — the
    // worker is what transitions it to 'active' once its pipeline is up;
    // simulate that having already happened well before the stale cutoff.
    await rawClient.query("UPDATE playback_sessions SET status = 'active' WHERE id = $1", [session!.id]);

    const cutoffMs = Date.now() - 90_000;
    const stale = await listHeartbeatStalePlaybackSessions(db, cutoffMs);
    expect(stale.some((s) => s.id === session!.id)).toBe(true);

    const suspendedAtMs = Date.now();
    const suspended = await suspendStalePlaybackSession(db, session!.id, suspendedAtMs);
    expect(suspended?.status).toBe('suspended');
    expect(suspended?.suspendedByThrottle).toBe(false);

    // d4-f5 (E/d3-e5 follow-up): the transition IS an event. Without it the
    // abandoned-session shape the admin now-playing surfaces render only
    // ever arrived on the 30s fallback poll, because this is the ONE
    // non-terminal status write in the system that had no emitter.
    const statusEvent = await eventForSession('playback.session-status-changed', session!.id);
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.payload).toMatchObject({
      sessionId: session!.id,
      previousStatus: 'active',
      status: 'suspended',
      // The disambiguator: this is NOT the worker's segment-ahead throttle.
      suspendedByThrottle: false,
      reason: 'heartbeat-stale',
      changedAtMs: suspendedAtMs,
    });

    // Idempotent: already suspended, not 'active' -> no-op.
    const again = await suspendStalePlaybackSession(db, session!.id, Date.now());
    expect(again).toBeUndefined();

    // ...and the no-op writes NO second event — every sweeper tick re-reads
    // its candidate set, so an emitter that fired on a no-op UPDATE would
    // pour one duplicate per minute into the outbox for as long as the
    // session lingers.
    const { rows: statusRows } = await rawClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events WHERE type = 'playback.session-status-changed' AND payload ->> 'sessionId' = $1`,
      [session!.id],
    );
    expect(statusRows[0]!.count).toBe('1');

    // No playback.ended event — a suspend is not a session end.
    const event = await eventForSession('playback.ended', session!.id);
    expect(event).toBeUndefined();

    // No longer in the heartbeat-stale candidate set (status !== 'active').
    const staleAfter = await listHeartbeatStalePlaybackSessions(db, cutoffMs);
    expect(staleAfter.some((s) => s.id === session!.id)).toBe(false);
  });

  it('a fresh (recently heartbeated) active session is not a candidate', async () => {
    const nowMs = Date.now();
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs,
    });
    await heartbeatPlaybackSession(db, adminCtx, session!.id, nowMs);

    const cutoffMs = nowMs - 90_000;
    const stale = await listHeartbeatStalePlaybackSessions(db, cutoffMs);
    expect(stale.some((s) => s.id === session!.id)).toBe(false);
  });
});

// Gap-closure lane: GET /progress/{itemId} additive single-item read
// (STATE.md §6.4 leak-checklist note n5). Guarded exactly like the PUT
// (upsertProgress): item-nonexistent, item-invisible, and no-progress-row
// are all indistinguishable `undefined` -> 404 upstream.
describe('getProgressForItem', () => {
  it('returns the current user progress row for a visible item', async () => {
    const nowMs = Date.now();
    await upsertProgress(db, adminCtx, harborLightsItemId, {
      positionMs: 12_345,
      state: 'in-progress',
      nowMs,
      durationMs: 6_480_000,
    });

    const row = await getProgressForItem(db, adminCtx, harborLightsItemId);
    expect(row).toMatchObject({
      itemId: harborLightsItemId,
      positionMs: 12_345,
      durationMs: 6_480_000,
      state: 'in-progress',
    });
  });

  it('returns undefined when the item is visible but has no progress row for this user', async () => {
    // Harbor Lights is visible to casual (general library) but seed.mjs
    // only seeds casual progress on OTHER items (movies[1]/episodes[3]),
    // and no test in this file writes casual progress against Harbor
    // Lights — a genuinely untouched, deterministic pairing.
    const row = await getProgressForItem(db, casualCtx, harborLightsItemId);
    expect(row).toBeUndefined();
  });

  it('returns undefined (404-equivalent) when the item is invisible to the viewer (restricted, uncleared)', async () => {
    // Prove the write-side guard leak-impossibility also holds read-side:
    // an uncleared viewer must not be able to distinguish "no progress" from
    // "item exists but I can't see it" via this read either.
    const write = await upsertProgress(db, adminCtx, restrictedItemId, {
      positionMs: 500,
      state: 'in-progress',
      nowMs: Date.now(),
    });
    expect(write).toBeDefined(); // admin (cleared) CAN write it

    const asCasual = await getProgressForItem(db, casualCtx, restrictedItemId);
    expect(asCasual).toBeUndefined(); // casual (uncleared, no library access) cannot read it back
  });

  it('returns undefined for a nonexistent item id', async () => {
    const row = await getProgressForItem(db, adminCtx, '018f6f1e-0000-7000-8000-00000000dead');
    expect(row).toBeUndefined();
  });
});

// Phase 3 §11 step 6b — global admission-control read (docs/PLAYBACK.md
// §9's "Concurrency: global semaphore = maxSimultaneousTranscodes").
// Measures the BASELINE count first rather than asserting an absolute
// number — this file's OTHER describe blocks create their own
// 'transcode'-decision sessions and never end every one of them, so the
// system-wide count is not zero by the time this block runs (sequential
// file execution, same DB, STATE.md's known shared-state convention).
describe('countActiveTranscodeSessions', () => {
  it('counts only non-terminal, non-direct-play sessions, system-wide (not ViewerContext-scoped)', async () => {
    const baseline = await countActiveTranscodeSessions(db);

    const directPlay = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'test',
      nowMs: Date.now(),
    });
    expect(await countActiveTranscodeSessions(db)).toBe(baseline); // direct-play never counts

    const transcodeA = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs: Date.now(),
    });
    expect(await countActiveTranscodeSessions(db)).toBe(baseline + 1);

    // A DIFFERENT user's transcode session still counts — this is a
    // system-wide semaphore, not per-viewer.
    const transcodeB = await createPlaybackSession(db, casualCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-stream', reasons: [] },
      engineVersion: 'test',
      nowMs: Date.now(),
    });
    expect(await countActiveTranscodeSessions(db)).toBe(baseline + 2);

    // Ending one drops the count back down.
    await endPlaybackSession(db, adminCtx, transcodeA!.id, Date.now());
    expect(await countActiveTranscodeSessions(db)).toBe(baseline + 1);

    await endPlaybackSession(db, casualCtx, transcodeB!.id, Date.now());
    await endPlaybackSession(db, adminCtx, directPlay!.id, Date.now());
    expect(await countActiveTranscodeSessions(db)).toBe(baseline);
  });

  it('every non-terminal status counts (created/starting/active/suspended/seeking), only ended/failed do not', async () => {
    const baseline = await countActiveTranscodeSessions(db);
    const nonTerminal = ['created', 'starting', 'active', 'suspended', 'seeking'] as const;
    const ids: string[] = [];
    for (const status of nonTerminal) {
      const session = await createPlaybackSession(db, adminCtx, {
        itemId: harborLightsItemId,
        fileId: harborLightsFileId,
        deviceId: adminDeviceId,
        plan: { decision: 'transcode', reasons: [] },
        engineVersion: 'test',
        nowMs: Date.now(),
      });
      await rawClient.query('UPDATE playback_sessions SET status = $2 WHERE id = $1', [session!.id, status]);
      ids.push(session!.id);
    }
    expect(await countActiveTranscodeSessions(db)).toBe(baseline + nonTerminal.length);

    for (const id of ids) {
      await rawClient.query("UPDATE playback_sessions SET status = 'ended' WHERE id = $1", [id]);
    }
    expect(await countActiveTranscodeSessions(db)).toBe(baseline);
  });
});

// SPF-9 — admission-time reclamation (docs/PLAYBACK.md §9's A5 law: no
// setting/admission decision may drop an ACTIVE session; a
// heartbeat-suspended one, by contrast, has no viewer left watching it).
describe('evictStalestSuspendedTranscodeSession', () => {
  // This file's other describe blocks (listStalePlaybackSessions widened,
  // countActiveTranscodeSessions) leave their own heartbeat-suspended
  // transcode sessions lying around (sequential file execution, same DB —
  // module header's known shared-state convention), which would otherwise
  // be silently eligible candidates for THIS block's eviction calls and
  // make an "expect undefined"/"expect exactly this id" assertion flaky.
  // Retiring every pre-existing eligible-shaped row before each test here
  // gives each test a clean, deterministic candidate set — never touches
  // an active session, a throttle-suspended one, or a direct-play one,
  // matching exactly what the function itself is forbidden to touch.
  beforeEach(async () => {
    await rawClient.query(
      "UPDATE playback_sessions SET status = 'ended', updated_at_ms = $1 " +
        "WHERE status = 'suspended' AND suspended_by_throttle = false AND plan ->> 'decision' != 'direct-play'",
      [Date.now()],
    );
  });

  async function newSuspendedTranscodeSession(input: {
    lastHeartbeatMs: number | null;
    startedAtMs: number;
    suspendedByThrottle?: boolean;
  }): Promise<string> {
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs: input.startedAtMs,
    });
    await rawClient.query(
      "UPDATE playback_sessions SET status = 'suspended', suspended_by_throttle = $2, last_heartbeat_ms = $3, started_at_ms = $4 WHERE id = $1",
      [session!.id, input.suspendedByThrottle ?? false, input.lastHeartbeatMs, input.startedAtMs],
    );
    return session!.id;
  }

  it('returns undefined when no session qualifies', async () => {
    const cutoffMs = Date.now() - 90_000;
    // A fresh (recently-heartbeated) suspended session is not stale enough.
    await newSuspendedTranscodeSession({ lastHeartbeatMs: Date.now(), startedAtMs: Date.now() - 60_000 });
    const evicted = await evictStalestSuspendedTranscodeSession(db, { cutoffMs, nowMs: Date.now() });
    expect(evicted).toBeUndefined();
  });

  it('evicts the stalest heartbeat-suspended transcode session, marking it failed with evicted-for-admission', async () => {
    const nowMs = Date.now();
    const cutoffMs = nowMs - 90_000;

    // Two eligible candidates at different staleness; the OLDER heartbeat
    // must be the one reclaimed.
    const newerId = await newSuspendedTranscodeSession({ lastHeartbeatMs: nowMs - 100_000, startedAtMs: nowMs - 200_000 });
    const olderId = await newSuspendedTranscodeSession({ lastHeartbeatMs: nowMs - 500_000, startedAtMs: nowMs - 600_000 });

    const evicted = await evictStalestSuspendedTranscodeSession(db, { cutoffMs, nowMs });
    expect(evicted?.id).toBe(olderId);
    expect(evicted?.status).toBe('failed');
    expect(evicted?.errorCode).toBe('evicted-for-admission');

    const untouched = await rawClient.query<{ status: string }>('SELECT status FROM playback_sessions WHERE id = $1', [newerId]);
    expect(untouched.rows[0]?.status).toBe('suspended');

    const evictedEvent = await eventForSession('playback.ended', olderId);
    expect(evictedEvent).toBeDefined();
    expect(evictedEvent!.payload).toMatchObject({ reason: 'admission-eviction', errorCode: 'evicted-for-admission' });
  });

  it('a null last_heartbeat_ms (never heartbeated) uses started_at_ms and sorts FIRST (NULLS FIRST)', async () => {
    const nowMs = Date.now();
    const cutoffMs = nowMs - 90_000;

    // Has a heartbeat, but still stale.
    const withHeartbeatId = await newSuspendedTranscodeSession({ lastHeartbeatMs: nowMs - 200_000, startedAtMs: nowMs - 300_000 });
    // Never heartbeated at all — NULLS FIRST means this is picked even
    // though its started_at_ms is more recent than the row above.
    const neverHeartbeatedId = await newSuspendedTranscodeSession({ lastHeartbeatMs: null, startedAtMs: nowMs - 100_000 });

    const evicted = await evictStalestSuspendedTranscodeSession(db, { cutoffMs, nowMs });
    expect(evicted?.id).toBe(neverHeartbeatedId);

    const untouched = await rawClient.query<{ status: string }>('SELECT status FROM playback_sessions WHERE id = $1', [withHeartbeatId]);
    expect(untouched.rows[0]?.status).toBe('suspended');
  });

  it('never evicts an ACTIVE session, even a stale one (only suspended is eligible)', async () => {
    const nowMs = Date.now();
    const cutoffMs = nowMs - 90_000;
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'transcode', reasons: [] },
      engineVersion: 'test',
      nowMs: nowMs - 600_000,
    });
    await rawClient.query(
      "UPDATE playback_sessions SET status = 'active', last_heartbeat_ms = $2 WHERE id = $1",
      [session!.id, nowMs - 500_000],
    );

    const evicted = await evictStalestSuspendedTranscodeSession(db, { cutoffMs, nowMs });
    expect(evicted).toBeUndefined();

    const stillActive = await rawClient.query<{ status: string }>('SELECT status FROM playback_sessions WHERE id = $1', [session!.id]);
    expect(stillActive.rows[0]?.status).toBe('active');
  });

  it('never evicts a THROTTLE-suspended session (suspended_by_throttle = true) — that encoder is deliberately parked mid-watch, not abandoned', async () => {
    const nowMs = Date.now();
    const cutoffMs = nowMs - 90_000;
    const throttleId = await newSuspendedTranscodeSession({
      lastHeartbeatMs: nowMs - 500_000,
      startedAtMs: nowMs - 600_000,
      suspendedByThrottle: true,
    });

    const evicted = await evictStalestSuspendedTranscodeSession(db, { cutoffMs, nowMs });
    expect(evicted).toBeUndefined();

    const stillSuspended = await rawClient.query<{ status: string }>('SELECT status FROM playback_sessions WHERE id = $1', [throttleId]);
    expect(stillSuspended.rows[0]?.status).toBe('suspended');
  });

  it('never evicts a DIRECT-PLAY session (never occupies a slot in the first place)', async () => {
    const nowMs = Date.now();
    const cutoffMs = nowMs - 90_000;
    const session = await createPlaybackSession(db, adminCtx, {
      itemId: harborLightsItemId,
      fileId: harborLightsFileId,
      deviceId: adminDeviceId,
      plan: { decision: 'direct-play', reasons: [] },
      engineVersion: 'test',
      nowMs: nowMs - 600_000,
    });
    await rawClient.query(
      "UPDATE playback_sessions SET status = 'suspended', suspended_by_throttle = false, last_heartbeat_ms = $2 WHERE id = $1",
      [session!.id, nowMs - 500_000],
    );

    const evicted = await evictStalestSuspendedTranscodeSession(db, { cutoffMs, nowMs });
    expect(evicted).toBeUndefined();

    const stillSuspended = await rawClient.query<{ status: string }>('SELECT status FROM playback_sessions WHERE id = $1', [session!.id]);
    expect(stillSuspended.rows[0]?.status).toBe('suspended');
  });

  it('is idempotent under a re-check: the evicted session is no longer a candidate on a second call', async () => {
    const nowMs = Date.now();
    const cutoffMs = nowMs - 90_000;
    const id = await newSuspendedTranscodeSession({ lastHeartbeatMs: nowMs - 500_000, startedAtMs: nowMs - 600_000 });

    const first = await evictStalestSuspendedTranscodeSession(db, { cutoffMs, nowMs });
    expect(first?.id).toBe(id);

    const second = await evictStalestSuspendedTranscodeSession(db, { cutoffMs, nowMs });
    expect(second).toBeUndefined();
  });
});
