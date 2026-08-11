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
  absorbSeekTarget,
  consumeSeekTarget,
  ensureSessionStagingDir,
  getMediaInfoForFile,
  getTranscodeSessionRow,
  listReapableTranscodeSessions,
  markSessionActive,
  markSessionFailed,
  markSessionStarting,
  recordSessionWorkerProcess,
  recordTranscodeRun,
  setThrottleSuspended,
  updateProducedSegment,
} from '../src/internal/index.js';
import { getTranscodeRunForSegment, listTranscodeRuns } from '../src/query/playback-sessions.js';
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
    // migrations/0038_media_streams_open_gop.sql: this fixture's video row
    // (seeded above) never set open_gop — NULL maps to false (toOpenGop's
    // conservative "not yet probed for this fact" default).
    expect(media?.video[0]?.openGop).toBe(false);
  });

  // migrations/0038_media_streams_open_gop.sql: a positively-detected
  // open_gop = true row maps straight through (toOpenGop's real-verdict
  // passthrough, mirrored identically by src/query/media-info.ts's guarded
  // getMediaInfoAssembly — this module's own header notes the two are
  // intentionally field-for-field identical mappings).
  it('maps a real open_gop = true column value straight through', async () => {
    const hevcFileId = (
      await rawClient.query<{ id: string }>(
        `INSERT INTO media_files (item_id, path, container, duration_ms, size_bytes, probed_at_ms)
         VALUES ($1, '/media/test/opengop-check.mkv', 'mkv', 90000, 45000000, $2)
         RETURNING id`,
        [itemId, Date.now()],
      )
    ).rows[0]!.id;
    await rawClient.query(
      `INSERT INTO media_streams (file_id, stream_index, stream_type, codec, width, height, bit_depth, frame_rate, is_default, is_forced, open_gop)
       VALUES ($1, 0, 'video', 'hevc', 320, 240, 8, 25, true, false, true)`,
      [hevcFileId],
    );

    const media = await getMediaInfoForFile(db, hevcFileId);
    expect(media?.video).toHaveLength(1);
    expect(media?.video[0]?.codec).toBe('hevc');
    expect(media?.video[0]?.openGop).toBe(true);
  });

  it('returns undefined for a nonexistent file id', async () => {
    const media = await getMediaInfoForFile(db, '11111111-1111-4111-8111-111111111111');
    expect(media).toBeUndefined();
  });

  // STATE.md H3 (v1.1 widening, docs/PLAYBACK.md §2.1): this module's own
  // CONTAINERS whitelist (deliberately a separate copy from query/
  // media-info.ts's — see this file's header) must ALSO include every
  // closed Container union member, or a seek-restart against a legitimately
  // probed .aiff/.wmv/etc. file would fail as if unprobed.
  it('assembles MediaInfo for a v1.1-reinstated container (aiff) once probed', async () => {
    const aiffFileId = (
      await rawClient.query<{ id: string }>(
        `INSERT INTO media_files (item_id, path, container, duration_ms, size_bytes, probed_at_ms)
         VALUES ($1, '/media/test/legacy-widening-check.aiff', 'aiff', 90000, 45000000, $2)
         RETURNING id`,
        [itemId, Date.now()],
      )
    ).rows[0]!.id;

    const media = await getMediaInfoForFile(db, aiffFileId);
    expect(media).toBeDefined();
    expect(media?.container).toBe('aiff');
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

  // V1-006: the SELECT half of consumeSeekTarget's own transaction already
  // guards on NON_TERMINAL_STATUSES, so calling it AFTER a session is
  // already terminal is a no-op even on the buggy code — that sequential
  // shape does not exercise the defect. The real hole is the gap BETWEEN
  // that SELECT and the UPDATE: under READ COMMITTED (tx.ts's default), a
  // second actor's terminal transition can commit in that gap, and the
  // UPDATE re-evaluates its own WHERE against the row as it stands THEN —
  // so the UPDATE, not the SELECT, is what has to carry the guard. This
  // test forces that exact interleaving with a real row lock on a second
  // connection: it holds the row past consumeSeekTarget's SELECT (which
  // sees the still-open session), closes the session out and commits
  // (releasing the lock) only once consumeSeekTarget's UPDATE is already
  // parked waiting on it, and only then lets that UPDATE proceed — so the
  // UPDATE runs, in real time, strictly after the row went terminal.
  it('does not resurrect a session closed by a concurrent actor mid-consume (real Postgres row-lock race)', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/x', nowMs: Date.now() });
    await markSessionActive(db, id, { producedSegment: 3, nowMs: Date.now() });
    await rawClient.query('UPDATE playback_sessions SET seek_target_ms = 65000 WHERE id = $1', [id]);

    const locker = new pg.Client({ connectionString: DATABASE_URL });
    await locker.connect();
    let consumePromise: ReturnType<typeof consumeSeekTarget>;
    try {
      await locker.query('BEGIN');
      // Row lock taken FIRST: consumeSeekTarget's SELECT (a plain read)
      // is unaffected and will still observe the open, non-terminal row;
      // its UPDATE needs the same row and will block behind this lock.
      await locker.query('SELECT * FROM playback_sessions WHERE id = $1 FOR UPDATE', [id]);

      consumePromise = consumeSeekTarget(db, id, Date.now());
      // Let consumeSeekTarget's SELECT complete and its UPDATE reach the
      // lock wait (a local Postgres round trip is single-digit ms; this
      // margin is generous, not a tight race).
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Close the session out from under it, still holding the lock, then
      // commit — this is the terminal transition landing in the window
      // consumeSeekTarget's own transaction already opened.
      await locker.query(
        "UPDATE playback_sessions SET status = 'failed', error_code = 'transcode-failed', ended_at_ms = $2, updated_at_ms = $2 WHERE id = $1",
        [id, Date.now()],
      );
      await locker.query('COMMIT'); // releases the lock; consumeSeekTarget's UPDATE can now run
    } finally {
      await locker.end();
    }

    const consumed = await consumePromise;

    // The UPDATE must re-check status itself (the SELECT's guard is stale
    // by the time the UPDATE runs) — so it now matches zero rows, exactly
    // like the existing "nothing pending" case above.
    expect(consumed).toBeUndefined();

    const row = await getTranscodeSessionRow(db, id);
    expect(row?.status).toBe('failed'); // NOT resurrected to 'seeking'
    expect(row?.seek_target_ms).toBe(65000); // left untouched for whoever closed it out
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

  // V1-006, third writer: markSessionFailed's own leading SELECT already
  // guards on NON_TERMINAL_STATUSES (the sequential test above), but its
  // UPDATE — like consumeSeekTarget's before its fix — only ever filtered
  // on `id`, trusting that stale SELECT. Same real-lock technique as
  // consumeSeekTarget's race test: a second connection holds the row past
  // markSessionFailed's SELECT, closes the session out first, commits
  // (releasing the lock), and only then does markSessionFailed's UPDATE
  // proceed — proving the UPDATE itself must re-check status or this
  // function breaks its own documented "no-op, emits NOTHING" promise.
  it('does not double-emit playback.ended when a concurrent actor closes the session mid-call (real Postgres row-lock race)', async () => {
    const id = await newSession();

    const locker = new pg.Client({ connectionString: DATABASE_URL });
    await locker.connect();
    let failPromise: ReturnType<typeof markSessionFailed>;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT * FROM playback_sessions WHERE id = $1 FOR UPDATE', [id]);

      failPromise = markSessionFailed(db, id, { errorCode: 'transcode-failed', stderrTail: 'racing', nowMs: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Close the session out from a different cause first (e.g. Lane B's
      // DELETE endpoint / the sweeper), still holding the lock, then commit.
      await locker.query("UPDATE playback_sessions SET status = 'ended', ended_at_ms = $2, updated_at_ms = $2 WHERE id = $1", [id, Date.now()]);
      await locker.query('COMMIT'); // releases the lock; markSessionFailed's UPDATE can now run
    } finally {
      await locker.end();
    }

    const result = await failPromise;
    expect(result).toBeUndefined(); // must see "already closed", not overwrite 'ended' -> 'failed'

    const row = await getTranscodeSessionRow(db, id);
    expect(row?.status).toBe('ended'); // NOT overwritten to 'failed'
    expect(row?.error_code).toBeNull();

    const event = await eventForSession('playback.ended', id);
    expect(event).toBeUndefined(); // no double-emit for this session
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

// The "absorb" counterpart to consumeSeekTarget: clears a REDUNDANT seek
// request (one the in-flight run is already serving) without bumping
// discontinuity_count or moving status, and — the property that actually
// matters — without ever being able to swallow a DIFFERENT target written
// in the meantime.
describe('absorbSeekTarget', () => {
  it('clears the pending target without a discontinuity or a status change', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/loombre-transcode/absorb', nowMs: Date.now() });
    await markSessionActive(db, id, { producedSegment: 3, nowMs: Date.now() });
    await rawClient.query(`UPDATE playback_sessions SET seek_target_ms = 60000 WHERE id = $1`, [id]);

    const absorbed = await absorbSeekTarget(db, id, 60000, Date.now());
    expect(absorbed).toBe(true);

    const row = await getTranscodeSessionRow(db, id);
    expect(row?.seek_target_ms).toBeNull();
    expect(row?.discontinuity_count).toBe(0); // nothing restarted
    expect(row?.status).toBe('active'); // never moved to 'seeking'
  });

  it('never swallows a DIFFERENT target written between the read and the write', async () => {
    const id = await newSession();
    await rawClient.query(`UPDATE playback_sessions SET seek_target_ms = 90000 WHERE id = $1`, [id]);

    // The caller read 60000 and judged it redundant; by the time it writes,
    // the client has asked for a real seek to 90000 instead.
    const absorbed = await absorbSeekTarget(db, id, 60000, Date.now());
    expect(absorbed).toBe(false);
    expect((await getTranscodeSessionRow(db, id))?.seek_target_ms).toBe(90000);
  });

  it('is a no-op once the session is terminal', async () => {
    const id = await newSession();
    await rawClient.query(`UPDATE playback_sessions SET seek_target_ms = 60000 WHERE id = $1`, [id]);
    await markSessionFailed(db, id, { errorCode: 'transcode-failed', stderrTail: '', nowMs: Date.now() });
    expect(await absorbSeekTarget(db, id, 60000, Date.now())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// migrations/0041_playback_sessions_worker_process.sql (process-lifecycle
// hardening wave, item C2): the two columns that make a boot-time
// orphan reaper possible at all. Everything else about an interrupted
// session survives a hard kill; the ffmpeg process itself does not — its
// pid is the only handle on it, and it has to be on the row because the
// process that knew it is gone.
// ---------------------------------------------------------------------------

describe('recordSessionWorkerProcess', () => {
  it('records the ffmpeg pid and the supervising worker generation', async () => {
    const id = await newSession();
    await markSessionStarting(db, id, { stagingDir: '/tmp/loombre-transcode/pid-a', nowMs: Date.now() });
    const row = await recordSessionWorkerProcess(db, id, { workerPid: 31337, workerStartedAtMs: 1_700_000_000_000, nowMs: Date.now() });
    expect(row?.worker_pid).toBe(31337);
    expect(row?.worker_started_at_ms).toBe(1_700_000_000_000);
  });

  it('overwrites on a seek-restart (a new run means a new pid)', async () => {
    const id = await newSession();
    await recordSessionWorkerProcess(db, id, { workerPid: 1, workerStartedAtMs: 10, nowMs: Date.now() });
    await recordSessionWorkerProcess(db, id, { workerPid: 2, workerStartedAtMs: 10, nowMs: Date.now() });
    expect((await getTranscodeSessionRow(db, id))?.worker_pid).toBe(2);
  });

  it('refuses once the session is terminal', async () => {
    const id = await newSession();
    await markSessionFailed(db, id, { errorCode: 'transcode-failed', stderrTail: 'boom', nowMs: Date.now() });
    const result = await recordSessionWorkerProcess(db, id, { workerPid: 9, workerStartedAtMs: 10, nowMs: Date.now() });
    expect(result).toBeUndefined();
    expect((await getTranscodeSessionRow(db, id))?.worker_pid).toBeNull();
  });
});

describe('listReapableTranscodeSessions', () => {
  it('returns only non-terminal sessions with a pid from a PREVIOUS worker generation', async () => {
    const thisGenerationStart = 2_000_000;

    const orphan = await newSession();
    await markSessionStarting(db, orphan, { stagingDir: '/tmp/loombre-transcode/orphan', nowMs: Date.now() });
    await recordSessionWorkerProcess(db, orphan, { workerPid: 4242, workerStartedAtMs: thisGenerationStart - 1, nowMs: Date.now() });

    const mine = await newSession();
    await recordSessionWorkerProcess(db, mine, { workerPid: 4243, workerStartedAtMs: thisGenerationStart, nowMs: Date.now() });

    const neverSpawned = await newSession(); // no worker_pid at all

    const terminal = await newSession();
    await recordSessionWorkerProcess(db, terminal, { workerPid: 4244, workerStartedAtMs: thisGenerationStart - 1, nowMs: Date.now() });
    await markSessionFailed(db, terminal, { errorCode: 'transcode-failed', stderrTail: '', nowMs: Date.now() });

    const reapable = await listReapableTranscodeSessions(db, { workerStartedBeforeMs: thisGenerationStart });
    const ids = reapable.map((r) => r.id);

    expect(ids).toContain(orphan);
    expect(ids).not.toContain(mine);
    expect(ids).not.toContain(neverSpawned);
    expect(ids).not.toContain(terminal);

    const row = reapable.find((r) => r.id === orphan);
    expect(row?.worker_pid).toBe(4242);
    expect(row?.staging_dir).toBe('/tmp/loombre-transcode/orphan');
  });
});

// ---------------------------------------------------------------------------
// migrations/0043_transcode_runs.sql (process-lifecycle hardening wave,
// continuation item 2): per-run SOURCE-ORIGIN recording.
//
// Segment indices are a single global counter across a session's runs
// (docs/PLAYBACK.md §9 — run 1 continues run 0's numbering), while each
// seek run's ffmpeg output timeline restarts at zero because it is spawned
// with `-ss` and no `-copyts`. Nothing durable connected the two, so for
// every run after the first there was no way to answer "what source time
// does segment N correspond to?" — which is what a server-side consumer
// needs for exact source-time anchoring and for post-seek progress
// reporting. These rows are that record: one per spawned run, carrying the
// run's index, the segment index it starts numbering at, and where it
// begins in SOURCE time.
//
// Real table, real FK, real columns (CLAUDE.md invariant 3 — this is not
// one of the JSONB-whitelisted payloads).
// ---------------------------------------------------------------------------

describe('recordTranscodeRun / transcode run lookup', () => {
  it('records run 0 at source origin 0 and segment 0', async () => {
    const id = await newSession();
    await recordTranscodeRun(db, { sessionId: id, runIndex: 0, startSegment: 0, sourceOriginMs: 0, nowMs: Date.now() });

    const runs = await listTranscodeRuns(db, id);
    expect(runs).toEqual([{ runIndex: 0, startSegment: 0, sourceOriginMs: 0 }]);
  });

  it('records a seek restart at the consumed target, continuing the segment numbering', async () => {
    const id = await newSession();
    await recordTranscodeRun(db, { sessionId: id, runIndex: 0, startSegment: 0, sourceOriginMs: 0, nowMs: Date.now() });
    await recordTranscodeRun(db, { sessionId: id, runIndex: 1, startSegment: 43, sourceOriginMs: 600_000, nowMs: Date.now() });

    expect(await listTranscodeRuns(db, id)).toEqual([
      { runIndex: 0, startSegment: 0, sourceOriginMs: 0 },
      { runIndex: 1, startSegment: 43, sourceOriginMs: 600_000 },
    ]);
  });

  it('is idempotent per (session, runIndex) — a redelivered job never duplicates or fails', async () => {
    const id = await newSession();
    await recordTranscodeRun(db, { sessionId: id, runIndex: 0, startSegment: 0, sourceOriginMs: 0, nowMs: Date.now() });
    await recordTranscodeRun(db, { sessionId: id, runIndex: 0, startSegment: 0, sourceOriginMs: 0, nowMs: Date.now() });
    expect(await listTranscodeRuns(db, id)).toHaveLength(1);
  });

  it('maps any served segment index to its OWNING run and that run source origin', async () => {
    const id = await newSession();
    await recordTranscodeRun(db, { sessionId: id, runIndex: 0, startSegment: 0, sourceOriginMs: 0, nowMs: Date.now() });
    await recordTranscodeRun(db, { sessionId: id, runIndex: 1, startSegment: 43, sourceOriginMs: 600_000, nowMs: Date.now() });
    await recordTranscodeRun(db, { sessionId: id, runIndex: 2, startSegment: 51, sourceOriginMs: 120_000, nowMs: Date.now() });

    // Inside run 0.
    expect(await getTranscodeRunForSegment(db, id, 0)).toEqual({ runIndex: 0, startSegment: 0, sourceOriginMs: 0 });
    expect(await getTranscodeRunForSegment(db, id, 42)).toEqual({ runIndex: 0, startSegment: 0, sourceOriginMs: 0 });
    // The first segment of run 1, and one inside it.
    expect(await getTranscodeRunForSegment(db, id, 43)).toEqual({ runIndex: 1, startSegment: 43, sourceOriginMs: 600_000 });
    expect(await getTranscodeRunForSegment(db, id, 50)).toEqual({ runIndex: 1, startSegment: 43, sourceOriginMs: 600_000 });
    // Run 2 is a BACKWARD seek: its source origin is earlier than run 1's,
    // while its segment numbering still moves forward. Ownership follows
    // the segment counter, never the source clock — the exact confusion
    // this table exists to remove.
    expect(await getTranscodeRunForSegment(db, id, 51)).toEqual({ runIndex: 2, startSegment: 51, sourceOriginMs: 120_000 });
    expect(await getTranscodeRunForSegment(db, id, 9_999)).toEqual({ runIndex: 2, startSegment: 51, sourceOriginMs: 120_000 });
  });

  it('returns undefined for a session with no recorded runs, and scopes strictly to one session', async () => {
    const empty = await newSession();
    expect(await getTranscodeRunForSegment(db, empty, 0)).toBeUndefined();
    expect(await listTranscodeRuns(db, empty)).toEqual([]);

    const other = await newSession();
    await recordTranscodeRun(db, { sessionId: other, runIndex: 0, startSegment: 0, sourceOriginMs: 0, nowMs: Date.now() });
    expect(await getTranscodeRunForSegment(db, empty, 0)).toBeUndefined();
  });

  it('rows are removed with their session (real FK, ON DELETE CASCADE)', async () => {
    const id = await newSession();
    await recordTranscodeRun(db, { sessionId: id, runIndex: 0, startSegment: 0, sourceOriginMs: 0, nowMs: Date.now() });
    await rawClient.query(`DELETE FROM playback_sessions WHERE id = $1`, [id]);
    const { rows } = await rawClient.query(`SELECT 1 FROM transcode_runs WHERE session_id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });
});
