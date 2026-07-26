// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/test/transcode-sessions.spec.ts
//
// Live-DB tests for src/internal/transcode-sessions.ts + src/internal/
// media-assembly.ts (Phase 3 §11 step 6a, docs/PLAYBACK.md §9) — the
// WORKER-WRITTEN half of the transcode session control channel. See
// migrations/0012_transcode_sessions.sql and src/internal/
// transcode-sessions.ts's headers for the full write-ownership contract
// this exercises. SELF-SUFFICIENT (own reset + minimal fixtures), same
// convention as test/internal.spec.ts.
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
import {
  consumeSeekTarget,
  ensureSessionStagingDir,
  getMediaInfoForFile,
  getTranscodeSessionRow,
  markSessionActive,
  markSessionFailed,
  markSessionStarting,
  setThrottleSuspended,
  updateProducedSegment,
} from '../src/internal/index.js';

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

let userId: string;
let deviceId: string;
let itemId: string;
let fileId: string;
let ctx: ViewerContext;

async function eventForSession(type: string, sessionId: string): Promise<{ payload: Record<string, unknown> } | undefined> {
  const { rows } = await rawClient.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events WHERE type = $1 AND payload ->> 'sessionId' = $2 ORDER BY ts_ms DESC LIMIT 1`,
    [type, sessionId],
  );
  return rows[0];
}

async function newSession(): Promise<string> {
  const session = await createPlaybackSession(db, ctx, {
    itemId,
    fileId,
    deviceId,
    plan: { decision: 'transcode', reasons: [] },
    engineVersion: 'test',
    nowMs: Date.now(),
  });
  return session!.id;
}

beforeAll(async () => {
  run(path.join(PKG_ROOT, 'scripts', 'migrate.mjs'), ['reset']);

  db = createDb(DATABASE_URL);
  rawClient = new pg.Client({ connectionString: DATABASE_URL });
  await rawClient.connect();

  const now = Date.now();

  const userRow = await rawClient.query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, created_at_ms, updated_at_ms)
     VALUES ('transcode-test', 'transcode-test@loombre.local', 'x', $1, $1)
     RETURNING id`,
    [now],
  );
  userId = userRow.rows[0]!.id;

  const deviceRow = await rawClient.query<{ id: string }>(
    `INSERT INTO devices (user_id, name, profile, created_at_ms) VALUES ($1, 'test-device', '{}', $2) RETURNING id`,
    [userId, now],
  );
  deviceId = deviceRow.rows[0]!.id;

  const libRow = await rawClient.query<{ id: string }>(
    `INSERT INTO libraries (name, media_kind, paths, created_at_ms, updated_at_ms)
     VALUES ('Transcode Test Library', 'movie', '{}', $1, $1)
     RETURNING id`,
    [now],
  );
  const libraryId = libRow.rows[0]!.id;

  await rawClient.query(`INSERT INTO library_permissions (user_id, library_id, granted_at_ms) VALUES ($1, $2, $3)`, [
    userId,
    libraryId,
    now,
  ]);

  const itemRow = await rawClient.query<{ id: string }>(
    `INSERT INTO catalog_items (library_id, item_type, title, sort_title, added_at_ms, updated_at_ms)
     VALUES ($1, 'movie', 'Transcode Test Movie', 'transcode test movie', $2, $2)
     RETURNING id`,
    [libraryId, now],
  );
  itemId = itemRow.rows[0]!.id;

  const fileRow = await rawClient.query<{ id: string }>(
    `INSERT INTO media_files (item_id, path, content_hash, size_bytes, container, duration_ms, probed_at_ms)
     VALUES ($1, '/media/test/movie.mp4', 'cafef00d', 1000000, 'mp4', 90000, $2)
     RETURNING id`,
    [itemId, now],
  );
  fileId = fileRow.rows[0]!.id;

  await rawClient.query(
    `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, frame_rate, is_default, is_forced)
     VALUES ($1, 0, 'video', 'h264', 320, 240, 8, 25, true, false)`,
    [fileId],
  );
  await rawClient.query(
    `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, channels, sample_rate, is_default, is_forced)
     VALUES ($1, 1, 'audio', 'aac', 2, 48000, true, false)`,
    [fileId],
  );

  ctx = { userId, allowedLibraryIds: [libraryId], restrictedCleared: false };
});

afterAll(async () => {
  await db?.destroy();
  await rawClient?.end();
});

describe('getMediaInfoForFile (guard-free, internal)', () => {
  it('assembles MediaInfo for a known probed file', async () => {
    const media = await getMediaInfoForFile(db, fileId);
    expect(media?.container).toBe('mp4');
    expect(media?.video).toHaveLength(1);
    expect(media?.video[0]?.codec).toBe('h264');
    expect(media?.audio).toHaveLength(1);
    expect(media?.audio[0]?.codec).toBe('aac');
    expect(media?.durationMs).toBe(90000);
  });

  it('returns undefined for a nonexistent file id', async () => {
    const media = await getMediaInfoForFile(db, '11111111-1111-4111-8111-111111111111');
    expect(media).toBeUndefined();
  });
});

describe('markSessionStarting', () => {
  it('created -> starting, recording staging_dir', async () => {
    const id = await newSession();
    const row = await markSessionStarting(db, id, { stagingDir: '/tmp/loombre-transcode/abc', nowMs: Date.now() });
    expect(row?.status).toBe('starting');
    expect(row?.staging_dir).toBe('/tmp/loombre-transcode/abc');
  });

  it('is idempotent/resumable: a second call with a different path never clobbers the first', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/loombre-transcode/first', nowMs: Date.now() });
    const second = await markSessionStarting(db, id, { stagingDir: '/tmp/loombre-transcode/second', nowMs: Date.now() });
    expect(second?.status).toBe('starting');
    expect(second?.staging_dir).toBe('/tmp/loombre-transcode/first');
  });
});

describe('markSessionActive', () => {
  it('starting -> active with produced_segment set (the first-segment observable)', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/x', nowMs: Date.now() });
    const active = await markSessionActive(db, id, { producedSegment: 0, nowMs: Date.now() });
    expect(active?.status).toBe('active');
    expect(active?.produced_segment).toBe(0);
  });

  it('refuses once the session is terminal', async () => {
    const id = await newSession();
    await markSessionFailed(db, id, { errorCode: 'transcode-failed', stderrTail: 'boom', nowMs: Date.now() });
    const result = await markSessionActive(db, id, { producedSegment: 3, nowMs: Date.now() });
    expect(result).toBeUndefined();
  });
});

describe('updateProducedSegment', () => {
  it('bumps produced_segment without touching status', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/x', nowMs: Date.now() });
    await markSessionActive(db, id, { producedSegment: 0, nowMs: Date.now() });
    const updated = await updateProducedSegment(db, id, 5, Date.now());
    expect(updated?.produced_segment).toBe(5);
    expect(updated?.status).toBe('active');
  });
});

describe('setThrottleSuspended', () => {
  it('suspends and resumes, flipping suspended_by_throttle both ways', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/x', nowMs: Date.now() });
    await markSessionActive(db, id, { producedSegment: 12, nowMs: Date.now() });

    const suspended = await setThrottleSuspended(db, id, { suspended: true, nowMs: Date.now() });
    expect(suspended?.status).toBe('suspended');
    expect(suspended?.suspended_by_throttle).toBe(true);

    const resumed = await setThrottleSuspended(db, id, { suspended: false, nowMs: Date.now() });
    expect(resumed?.status).toBe('active');
    expect(resumed?.suspended_by_throttle).toBe(false);
  });

  it('refuses while seeking (a restart in progress owns status)', async () => {
    const id = await newSession();
    await rawClient.query("UPDATE playback_sessions SET status = 'seeking' WHERE id = $1", [id]);
    const result = await setThrottleSuspended(db, id, { suspended: true, nowMs: Date.now() });
    expect(result).toBeUndefined();
  });
});

describe('consumeSeekTarget', () => {
  it('atomically claims the pending target: nulls it, bumps discontinuity_count, sets status seeking', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/x', nowMs: Date.now() });
    await markSessionActive(db, id, { producedSegment: 3, nowMs: Date.now() });
    await rawClient.query('UPDATE playback_sessions SET seek_target_ms = 65000 WHERE id = $1', [id]);

    const consumed = await consumeSeekTarget(db, id, Date.now());
    expect(consumed).toEqual({ seekTargetMs: 65000, discontinuityCount: 1 });

    const row = await getTranscodeSessionRow(db, id);
    expect(row?.seek_target_ms).toBeNull();
    expect(row?.status).toBe('seeking');
    expect(row?.discontinuity_count).toBe(1);
  });

  it('returns undefined when there is nothing pending (idempotent against double-consumption)', async () => {
    const id = await newSession();
    const consumed = await consumeSeekTarget(db, id, Date.now());
    expect(consumed).toBeUndefined();
  });

  it('a second seek increments discontinuity_count again (2)', async () => {
    const id = await newSession();
    await rawClient.query('UPDATE playback_sessions SET seek_target_ms = 10000 WHERE id = $1', [id]);
    await consumeSeekTarget(db, id, Date.now());
    await markSessionActive(db, id, { producedSegment: 2, nowMs: Date.now() });
    await rawClient.query('UPDATE playback_sessions SET seek_target_ms = 20000 WHERE id = $1', [id]);
    const second = await consumeSeekTarget(db, id, Date.now());
    expect(second).toEqual({ seekTargetMs: 20000, discontinuityCount: 2 });
  });
});

describe('markSessionFailed', () => {
  it('fails the session, stores stderr_tail, and emits playback.ended exactly once', async () => {
    const id = await newSession();
    const failed = await markSessionFailed(db, id, { errorCode: 'transcode-failed', stderrTail: 'ffmpeg: fatal error', nowMs: Date.now() });
    expect(failed?.status).toBe('failed');
    expect(failed?.error_code).toBe('transcode-failed');
    expect(failed?.stderr_tail).toBe('ffmpeg: fatal error');

    const event = await eventForSession('playback.ended', id);
    expect(event?.payload).toMatchObject({ sessionId: id, itemId, reason: 'server-error', errorCode: 'transcode-failed' });
  });

  it('is idempotent — a session already ended by someone else is a no-op, no double-emit', async () => {
    const id = await newSession();
    await rawClient.query("UPDATE playback_sessions SET status = 'ended', ended_at_ms = $2 WHERE id = $1", [id, Date.now()]);

    const result = await markSessionFailed(db, id, { errorCode: 'transcode-failed', stderrTail: 'too late', nowMs: Date.now() });
    expect(result).toBeUndefined();

    const event = await eventForSession('playback.ended', id);
    expect(event).toBeUndefined();
  });
});

// Phase 3 §11 step 6b (P3.9(e)): shared by BOTH the 'transcode' consumer's
// own markSessionStarting path (already covered above) AND the NEW
// 'subtitle-extract' consumer (apps/worker/src/subtitles/**), which needs
// a staging dir recorded for a session that may never run a transcode
// pipeline at all.
describe('ensureSessionStagingDir', () => {
  it('sets staging_dir when it is currently NULL', async () => {
    const id = await newSession();
    const row = await ensureSessionStagingDir(db, id, '/tmp/loombre-subs/abc', Date.now());
    expect(row?.staging_dir).toBe('/tmp/loombre-subs/abc');
  });

  it('is a no-op (never clobbers) once staging_dir is already set — mirrors markSessionStarting\'s own idempotency', async () => {
    const id = await newSession();
    await ensureSessionStagingDir(db, id, '/tmp/loombre-subs/first', Date.now());
    const second = await ensureSessionStagingDir(db, id, '/tmp/loombre-subs/second', Date.now());
    expect(second).toBeUndefined(); // WHERE staging_dir IS NULL matched zero rows
    const row = await getTranscodeSessionRow(db, id);
    expect(row?.staging_dir).toBe('/tmp/loombre-subs/first');
  });

  it('also a no-op once the transcode runtime itself already set staging_dir via markSessionStarting (same deterministic path, never a clobber)', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/loombre-transcode/shared-id', nowMs: Date.now() });
    const result = await ensureSessionStagingDir(db, id, '/tmp/loombre-transcode/shared-id', Date.now());
    expect(result).toBeUndefined();
    const row = await getTranscodeSessionRow(db, id);
    expect(row?.staging_dir).toBe('/tmp/loombre-transcode/shared-id');
  });

  it('refuses once the session is terminal', async () => {
    const id = await newSession();
    await markSessionFailed(db, id, { errorCode: 'transcode-failed', stderrTail: 'boom', nowMs: Date.now() });
    const result = await ensureSessionStagingDir(db, id, '/tmp/loombre-subs/too-late', Date.now());
    expect(result).toBeUndefined();
  });

  it('returns undefined for a nonexistent session id', async () => {
    const result = await ensureSessionStagingDir(db, '11111111-1111-4111-8111-111111111111', '/tmp/x', Date.now());
    expect(result).toBeUndefined();
  });
});
