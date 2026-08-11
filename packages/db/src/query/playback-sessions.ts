// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/query/playback-sessions.ts
//
// Direct-play session rows (docs/PLAYBACK.md §9, STATE.md P2.4/P2.13/P2.14).
// Phase 2 scope only: no HLS packaging, no transcode — every session this
// wave creates is stored with `plan.decision === 'direct-play'` and
// `engineVersion: 'phase2-static'` (the caller, apps/server's playback
// module, is the one that runs checkStaticCompat() from
// @loombre/playback-engine and refuses to call createPlaybackSession at all
// when it says canDirectPlay is false — this module does not re-derive that
// decision, it only persists what the caller already decided).
//
// Guard posture: createPlaybackSession/getPlaybackSessionForUser/
// heartbeatPlaybackSession/endPlaybackSession all take a ViewerContext and
// are scoped to `ctx.userId` — a playback session is inherently a per-user
// resource (nobody else's session, restricted or not, is visible), so unlike
// catalog_items there is no separate content_class check to compile in here:
// the ITEM-visibility check (getItemById, which itself enforces the full
// restricted-content guard) is what stands between an uncleared viewer and
// starting a session against a restricted file in the first place —
// createPlaybackSession is the one function in this file that touches
// catalog_items, and it does so through getItemById exactly like every
// other guarded write in this package (see progress-write.ts's header for
// the identical reasoning).
//
// listStalePlaybackSessions / endStalePlaybackSession are deliberately NOT
// ViewerContext-scoped: they back the server-side heartbeat sweeper
// (docs/PLAYBACK.md §9, "no heartbeat for 15 min -> end session"), a
// system-wide background job with no requesting viewer, exactly like
// query/libraries.ts's admin CRUD functions are existence-scoped rather than
// viewer-guarded for the same class of reason (see that file's header).
//
// Events: playback.started is written in the SAME transaction as the
// session insert; playback.ended in the same transaction as the state
// transition to ended/failed — matching src/query/libraries.ts's
// createLibrary outbox pattern exactly (writeEvent only accepts a live
// Transaction handle, so "write the event outside the transaction" is a
// compile error, not a runtime foot-gun).
//
// itemId recovery for events: playback_sessions has no item_id column of
// its own (only file_id, migrations/0001_init.sql) — the owning item is
// recovered via a LEFT JOIN onto media_files at read/end time. In the rare
// case a session's file has since been hard-deleted (file_id survives via
// ON DELETE SET NULL, but the join then misses), the event is written
// without an `itemId` key rather than guessing — a documented limitation,
// not a silent inconsistency.

import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB, PlaybackSessionStatus } from '../types.js';
import type { ViewerContext } from '../context.js';
import { getItemById } from './items.js';
import { withTransaction, writeEvent } from '../internal/index.js';

export interface PlaybackSessionRow {
  id: string;
  userId: string;
  deviceId: string | null;
  fileId: string | null;
  /** Recovered via media_files.item_id join; null only if the file row is
   *  gone (hard-deleted) since the session was created. */
  itemId: string | null;
  plan: Record<string, unknown> | null;
  engineVersion: string | null;
  status: PlaybackSessionStatus;
  errorCode: string | null;
  startedAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
  lastHeartbeatMs: number | null;
  /** Migration 0007 (P2.8) — throttle marker for playback.progress
   *  emission, see heartbeatPlaybackSession below. */
  lastProgressEventAtMs: number | null;
  /** migrations/0012_transcode_sessions.sql (Phase 3 §11 step 6a) — see
   *  that migration's column comments for the full worker/server
   *  write-ownership split summarized in this file's new section below. */
  stagingDir: string | null;
  requestedSegment: number | null;
  producedSegment: number | null;
  seekTargetMs: number | null;
  discontinuityCount: number;
  suspendedByThrottle: boolean;
  stderrTail: string | null;
}

interface RawSessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  file_id: string | null;
  item_id: string | null;
  plan: Record<string, unknown> | null;
  engine_version: string | null;
  status: PlaybackSessionStatus;
  error_code: string | null;
  started_at_ms: number;
  updated_at_ms: number;
  ended_at_ms: number | null;
  last_heartbeat_ms: number | null;
  last_progress_event_at_ms: number | null;
  staging_dir: string | null;
  requested_segment: number | null;
  produced_segment: number | null;
  seek_target_ms: number | null;
  discontinuity_count: number;
  suspended_by_throttle: boolean;
  stderr_tail: string | null;
}

function mapRow(row: RawSessionRow): PlaybackSessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    fileId: row.file_id,
    itemId: row.item_id,
    plan: row.plan,
    engineVersion: row.engine_version,
    status: row.status,
    errorCode: row.error_code,
    startedAtMs: row.started_at_ms,
    updatedAtMs: row.updated_at_ms,
    endedAtMs: row.ended_at_ms,
    lastHeartbeatMs: row.last_heartbeat_ms,
    lastProgressEventAtMs: row.last_progress_event_at_ms,
    stagingDir: row.staging_dir,
    requestedSegment: row.requested_segment,
    producedSegment: row.produced_segment,
    seekTargetMs: row.seek_target_ms,
    discontinuityCount: row.discontinuity_count,
    suspendedByThrottle: row.suspended_by_throttle,
    stderrTail: row.stderr_tail,
  };
}

/** Base select carrying the media_files join every read below needs to
 *  recover itemId (see module header). */
function baseSelect(db: Kysely<DB> | Transaction<DB>) {
  return db
    .selectFrom('playback_sessions')
    .leftJoin('media_files', 'media_files.id', 'playback_sessions.file_id')
    .select([
      'playback_sessions.id as id',
      'playback_sessions.user_id as user_id',
      'playback_sessions.device_id as device_id',
      'playback_sessions.file_id as file_id',
      'media_files.item_id as item_id',
      'playback_sessions.plan as plan',
      'playback_sessions.engine_version as engine_version',
      'playback_sessions.status as status',
      'playback_sessions.error_code as error_code',
      'playback_sessions.started_at_ms as started_at_ms',
      'playback_sessions.updated_at_ms as updated_at_ms',
      'playback_sessions.ended_at_ms as ended_at_ms',
      'playback_sessions.last_heartbeat_ms as last_heartbeat_ms',
      'playback_sessions.last_progress_event_at_ms as last_progress_event_at_ms',
      'playback_sessions.staging_dir as staging_dir',
      'playback_sessions.requested_segment as requested_segment',
      'playback_sessions.produced_segment as produced_segment',
      'playback_sessions.seek_target_ms as seek_target_ms',
      'playback_sessions.discontinuity_count as discontinuity_count',
      'playback_sessions.suspended_by_throttle as suspended_by_throttle',
      'playback_sessions.stderr_tail as stderr_tail',
    ]);
}

export interface CreatePlaybackSessionInput {
  itemId: string;
  /** Must be a media_files row belonging to `itemId` — verified here, not
   *  trusted from the caller. */
  fileId: string;
  /** Required, not nullable: the event-schemas' playback.started/ended
   *  payloads both require a uuid `deviceId` (packages/contract/
   *  event-schemas), and every Phase 2 access token carries a deviceId
   *  claim (login always registers/reuses a device row) — the caller
   *  (apps/server) is expected to 422 upstream in the theoretical case a
   *  presented token has none, rather than this function silently writing
   *  a schema-invalid event payload. */
  deviceId: string;
  /** Serialized PlaybackPlan-shaped object (Phase 2: always
   *  `{decision:'direct-play', reasons:[], ...}`), stored as-is in the
   *  `plan` JSONB column (docs/PLAN.md §6.3 whitelist). */
  plan: Record<string, unknown>;
  engineVersion: string;
  nowMs: number;
}

/**
 * Creates a playback session row + emits `playback.started` in one
 * transaction. Returns `undefined` — indistinguishable from "does not
 * exist", matching every other guarded write in this package — when:
 *   - the item does not exist or is not visible to `ctx` (getItemById), or
 *   - `fileId` is not a media_files row belonging to that item.
 */
export async function createPlaybackSession(
  db: Kysely<DB>,
  ctx: ViewerContext,
  input: CreatePlaybackSessionInput
): Promise<PlaybackSessionRow | undefined> {
  const item = await getItemById(db, ctx, input.itemId);
  if (!item) return undefined;

  const file = await db
    .selectFrom('media_files')
    .select(['id'])
    .where('id', '=', input.fileId)
    .where('item_id', '=', input.itemId)
    .executeTakeFirst();
  if (!file) return undefined;

  const decision =
    typeof input.plan === 'object' && input.plan !== null && 'decision' in input.plan
      ? (input.plan as { decision?: unknown }).decision
      : undefined;

  // Initial status (docs/PLAYBACK.md §9 state machine, Phase 3 §11 step 6a):
  // a 'direct-play' plan is immediately playable — range-request file
  // serving needs no pipeline to start, so it goes straight to 'active'
  // exactly like every Phase 2 session always has (unchanged behavior,
  // still asserted by this file's own Phase 2 tests). Any OTHER decision
  // ('direct-stream'/'remux'/'transcode') requires the worker to actually
  // start an ffmpeg pipeline first (apps/worker/src/transcode/**) — those
  // sessions start life 'created' and the worker transitions them through
  // starting -> active once init + the first segment exist.
  const initialStatus: PlaybackSessionStatus = decision === 'direct-play' ? 'active' : 'created';

  return withTransaction(db, async (trx) => {
    const inserted = await trx
      .insertInto('playback_sessions')
      .values({
        user_id: ctx.userId,
        device_id: input.deviceId,
        file_id: input.fileId,
        plan: input.plan,
        engine_version: input.engineVersion,
        started_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
        status: initialStatus,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeEvent(trx, {
      type: 'playback.started',
      tsMs: input.nowMs,
      actorUserId: ctx.userId,
      payload: {
        sessionId: inserted.id,
        itemId: input.itemId,
        deviceId: input.deviceId,
        decision: typeof decision === 'string' ? decision : 'direct-play',
        startedAtMs: input.nowMs,
      },
    });

    return mapRow({
      id: inserted.id,
      user_id: inserted.user_id,
      device_id: inserted.device_id,
      file_id: inserted.file_id,
      item_id: input.itemId,
      plan: inserted.plan,
      engine_version: inserted.engine_version,
      status: inserted.status,
      error_code: inserted.error_code,
      started_at_ms: inserted.started_at_ms,
      updated_at_ms: inserted.updated_at_ms,
      ended_at_ms: inserted.ended_at_ms,
      last_heartbeat_ms: inserted.last_heartbeat_ms,
      last_progress_event_at_ms: inserted.last_progress_event_at_ms,
      staging_dir: inserted.staging_dir,
      requested_segment: inserted.requested_segment,
      produced_segment: inserted.produced_segment,
      seek_target_ms: inserted.seek_target_ms,
      discontinuity_count: inserted.discontinuity_count,
      suspended_by_throttle: inserted.suspended_by_throttle,
      stderr_tail: inserted.stderr_tail,
    });
  });
}

/** Own sessions only — scoped to `ctx.userId` (module header). */
export async function getPlaybackSessionForUser(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string
): Promise<PlaybackSessionRow | undefined> {
  const row = await baseSelect(db).where('playback_sessions.id', '=', id).where('playback_sessions.user_id', '=', ctx.userId).executeTakeFirst();
  return row ? mapRow(row) : undefined;
}

/** Raw media_files fields the file-serving endpoint needs (path/container/
 *  size/hash). Authorization for byte access is already established by the
 *  caller having resolved a session via getPlaybackSessionForUser first —
 *  this is a plain lookup, not a second guard gate (module header). */
export interface PlaybackSessionFileRow {
  id: string;
  path: string;
  container: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
}

export async function getMediaFileForPlaybackSession(
  db: Kysely<DB>,
  fileId: string
): Promise<PlaybackSessionFileRow | undefined> {
  const row = await db
    .selectFrom('media_files')
    .select(['id', 'path', 'container', 'size_bytes', 'content_hash'])
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (!row) return undefined;
  return { id: row.id, path: row.path, container: row.container, sizeBytes: row.size_bytes, contentHash: row.content_hash };
}

/** Session heartbeat's optional progress info (P2.8 websocket-presence
 *  lane) — supplied by the caller (apps/server's ProgressController)
 *  because playback_sessions itself stores no position; the `progress`
 *  table (packages/db/src/query/progress-write.ts) is the source of truth
 *  for that, written in the SAME request just before this call. Omitted
 *  entirely by any caller that heartbeats without a position at hand
 *  (e.g. this file's own tests) — in that case NO playback.progress event
 *  is ever emitted, matching the schema's required `positionMs` field
 *  (never write a value-free/guessed payload). */
export interface HeartbeatProgressInput {
  positionMs: number;
  durationMs?: number | null;
}

/** playback.progress emission throttle (STATE.md P2.8, plan §6.3 — "at
 *  most once per 30s per session from the heartbeat path, never
 *  row-per-tick"). */
export const PLAYBACK_PROGRESS_EVENT_INTERVAL_MS = 30_000;

/**
 * Session heartbeat (docs/PLAYBACK.md §9): PUT /progress/{itemId} with a
 * sessionId doubles as this. Bumps last_heartbeat_ms/updated_at_ms and
 * (re)marks the session active. Returns `undefined` when the session does
 * not exist, isn't owned by `ctx.userId`, or has already ended/failed (a
 * heartbeat cannot revive a dead session).
 *
 * Additionally (P2.8), when `progress` is supplied AND at least
 * PLAYBACK_PROGRESS_EVENT_INTERVAL_MS has elapsed since the last EMITTED
 * playback.progress event for this session (never since the last
 * heartbeat call, which can be far more frequent — see
 * last_progress_event_at_ms's migration-0007 doc comment and
 * HeartbeatProgressInput above), writes one in the SAME transaction as the
 * heartbeat update. A session with no recoverable itemId (module header:
 * the owning file was hard-deleted) never gets a progress event — same
 * "never guess" rule playback.ended's itemId omission already follows.
 */
export async function heartbeatPlaybackSession(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string,
  nowMs: number,
  progress?: HeartbeatProgressInput
): Promise<PlaybackSessionRow | undefined> {
  return withTransaction(db, async (trx) => {
    const current = await baseSelect(trx)
      .where('playback_sessions.id', '=', id)
      .where('playback_sessions.user_id', '=', ctx.userId)
      .where('playback_sessions.status', 'in', ['created', 'active'])
      .executeTakeFirst();
    if (!current) return undefined;

    const shouldEmitProgress =
      progress !== undefined &&
      current.item_id !== null &&
      (current.last_progress_event_at_ms === null ||
        nowMs - current.last_progress_event_at_ms >= PLAYBACK_PROGRESS_EVENT_INTERVAL_MS);

    // Re-check status on the UPDATE itself, not just the leading SELECT
    // above: under READ COMMITTED a second actor (the sweeper, the DELETE
    // endpoint) can close this session out in the gap between that SELECT
    // and this UPDATE, and only this WHERE clause is re-evaluated against
    // the row as it stands at write time. Without it, this UPDATE still
    // matches on `id` alone and a heartbeat resurrects a session someone
    // else already closed (V1-006's exact defect class).
    const updated = await trx
      .updateTable('playback_sessions')
      .set({
        last_heartbeat_ms: nowMs,
        updated_at_ms: nowMs,
        status: 'active',
        ...(shouldEmitProgress ? { last_progress_event_at_ms: nowMs } : {}),
      })
      .where('id', '=', id)
      .where('status', 'in', ['created', 'active'] satisfies PlaybackSessionStatus[])
      .returningAll()
      .executeTakeFirst();
    // Lost the race: someone else closed the session first. "A heartbeat
    // cannot revive a dead session" (docstring) — undefined, no event.
    if (!updated) return undefined;

    if (shouldEmitProgress) {
      // current.item_id !== null already checked above; TypeScript can't
      // see that through shouldEmitProgress alone, so re-assert narrowly.
      const itemId = current.item_id as string;
      await writeEvent(trx, {
        type: 'playback.progress',
        tsMs: nowMs,
        actorUserId: ctx.userId,
        payload: {
          sessionId: id,
          itemId,
          deviceId: current.device_id,
          positionMs: progress!.positionMs,
          durationMs: progress!.durationMs ?? null,
          updatedAtMs: nowMs,
        },
      });
    }

    return mapRow({ ...current, status: updated.status, updated_at_ms: updated.updated_at_ms, last_heartbeat_ms: updated.last_heartbeat_ms, last_progress_event_at_ms: updated.last_progress_event_at_ms });
  });
}

type EndReason = 'client-stopped' | 'idle-timeout' | 'server-error' | 'revoked' | 'completed';

async function finalizeSession(
  trx: Transaction<DB>,
  current: RawSessionRow,
  nowMs: number,
  options: { errorCode: string | null; reason: EndReason; finalPositionMs?: number | null }
): Promise<PlaybackSessionRow> {
  const nextStatus: PlaybackSessionStatus = options.errorCode !== null ? 'failed' : 'ended';

  // The caller's own "already terminal?" check (endPlaybackSession /
  // endStalePlaybackSession, above/below) was evaluated against ITS SELECT
  // and is stale by the time this UPDATE runs: under READ COMMITTED a
  // second actor (the sweeper, a racing second end call, the worker's
  // markSessionFailed) can commit its own terminal transition in that gap.
  // Repeating the guard here, on the UPDATE itself, is what actually closes
  // it — matching the idiom every other writer in this package applies on
  // its own UPDATE rather than trusting an earlier read.
  const updated = await trx
    .updateTable('playback_sessions')
    .set({
      status: nextStatus,
      error_code: options.errorCode,
      ended_at_ms: nowMs,
      updated_at_ms: nowMs,
    })
    .where('id', '=', current.id)
    .where('status', 'not in', ['ended', 'failed'] satisfies PlaybackSessionStatus[])
    .returningAll()
    .executeTakeFirst();

  if (!updated) {
    // Lost the race: someone else closed this session out first. Do NOT
    // emit a second playback.ended — re-read and return whatever the
    // winner actually wrote, the same idempotent contract the caller's
    // sequential already-terminal check already promises.
    const row = await baseSelect(trx).where('playback_sessions.id', '=', current.id).executeTakeFirstOrThrow();
    return mapRow(row);
  }

  await writeEvent(trx, {
    type: 'playback.ended',
    tsMs: nowMs,
    actorUserId: current.user_id,
    payload: {
      sessionId: current.id,
      ...(current.item_id !== null ? { itemId: current.item_id } : {}),
      deviceId: current.device_id,
      reason: options.reason,
      errorCode: options.errorCode,
      finalPositionMs: options.finalPositionMs ?? null,
      endedAtMs: nowMs,
    },
  });

  return mapRow({ ...current, status: updated.status, error_code: updated.error_code, ended_at_ms: updated.ended_at_ms, updated_at_ms: updated.updated_at_ms });
}

/**
 * Ends (or fails, when `errorCode` is supplied) a session owned by
 * `ctx.userId`. Idempotent: ending an already-ended/failed session is a
 * no-op that returns the existing row unchanged (no duplicate
 * `playback.ended` event). Returns `undefined` when the session does not
 * exist or is not owned by `ctx.userId`.
 */
export async function endPlaybackSession(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string,
  nowMs: number,
  errorCode: string | null = null
): Promise<PlaybackSessionRow | undefined> {
  return withTransaction(db, async (trx) => {
    const current = await baseSelect(trx)
      .where('playback_sessions.id', '=', id)
      .where('playback_sessions.user_id', '=', ctx.userId)
      .executeTakeFirst();
    if (!current) return undefined;

    if (current.status === 'ended' || current.status === 'failed') {
      return mapRow(current);
    }

    return finalizeSession(trx, current, nowMs, {
      errorCode,
      reason: errorCode !== null ? 'server-error' : 'client-stopped',
    });
  });
}

/**
 * Sweeper candidate set (docs/PLAYBACK.md §9): sessions still in any
 * NON-TERMINAL state whose last heartbeat (or, absent one, start time) is
 * older than `cutoffMs`. NOT ViewerContext-scoped (module header) — this is
 * a system-wide maintenance read.
 *
 * Widened for migrations/0012_transcode_sessions.sql (Phase 3 §11 step 6a):
 * Phase 2 only ever had sessions in `created`/`active` (direct-play has no
 * other state), so the original filter never needed the wider set. A
 * transcode session can now sit `starting`/`suspended`/`seeking` for
 * extended periods (e.g. throttled while the viewer is paused) — those must
 * remain 15-minute-sweepable exactly like `active`, or a session stuck
 * `suspended` would never be reaped. `ended`/`failed` stay excluded (already
 * terminal, nothing to sweep).
 */
export async function listStalePlaybackSessions(db: Kysely<DB>, cutoffMs: number): Promise<PlaybackSessionRow[]> {
  const rows = await baseSelect(db)
    .where('playback_sessions.status', 'in', ['created', 'starting', 'active', 'suspended', 'seeking'])
    .where((eb) =>
      eb.or([
        eb.and([
          eb('playback_sessions.last_heartbeat_ms', 'is not', null),
          eb('playback_sessions.last_heartbeat_ms', '<', cutoffMs),
        ]),
        eb.and([
          eb('playback_sessions.last_heartbeat_ms', 'is', null),
          eb('playback_sessions.started_at_ms', '<', cutoffMs),
        ]),
      ])
    )
    .execute();
  return rows.map(mapRow);
}

/**
 * System-side end for the heartbeat sweeper (no ViewerContext — module
 * header): always fails the session with `error_code = 'heartbeat-timeout'`
 * and emits `playback.ended` with `reason: 'idle-timeout'`. Idempotent like
 * endPlaybackSession; returns `undefined` if the session id no longer
 * exists.
 */
export async function endStalePlaybackSession(db: Kysely<DB>, id: string, nowMs: number): Promise<PlaybackSessionRow | undefined> {
  return withTransaction(db, async (trx) => {
    const current = await baseSelect(trx).where('playback_sessions.id', '=', id).executeTakeFirst();
    if (!current) return undefined;
    if (current.status === 'ended' || current.status === 'failed') {
      return mapRow(current);
    }
    const finalized = await finalizeSession(trx, current, nowMs, { errorCode: 'heartbeat-timeout', reason: 'idle-timeout' });
    await warnOnOrphanSignature(trx, id);
    return finalized;
  });
}

/**
 * THE ORPHAN SIGNATURE breadcrumb (process-lifecycle hardening wave,
 * 2026-08-11, item C7).
 *
 * Three facts together mean a detached ffmpeg is about to keep running
 * with nobody watching it: (1) the heartbeat sweeper just ended this
 * session, (2) the session still names a live pipeline — a `worker_pid`
 * recorded by migrations/0041 — and (3) a 'transcode' job-ledger row is
 * still 'active', i.e. some worker believes it is still driving a session.
 * That combination is exactly the state where the admission slot is
 * released (countActiveTranscodeSessions counts only non-terminal rows)
 * while a process is still burning a core.
 *
 * apps/worker/src/transcode/reaper.ts cleans this up on the NEXT worker
 * boot. The point of this log line is to make it visible BEFORE that — in
 * the logs of the process that caused it, at the moment it happens, with
 * the pid an operator would need to act on now.
 *
 * HONEST LIMITATION, stated rather than hidden: the jobs ledger has no
 * session_id column (0001_init.sql — it is queue-agnostic and carries only
 * `subject_item_id`), so fact (3) is an INSTANCE-level check, not a
 * per-row join to THIS session's job. It can therefore fire when a
 * different session's transcode job is legitimately active. That is
 * acceptable for a breadcrumb whose other two facts are exact and
 * per-session, and whose whole job is to make a rare pathology greppable —
 * it is deliberately not a metric and nothing keys behavior on it.
 *
 * console.warn from the query layer follows the precedent in
 * src/query/remote-active-path.ts (a system-level operational fact that
 * has no request to attach itself to). Never throws: a diagnostic must
 * never be able to fail a sweep.
 */
async function warnOnOrphanSignature(trx: Transaction<DB>, sessionId: string): Promise<void> {
  try {
    const session = await trx
      .selectFrom('playback_sessions')
      .select(['worker_pid', 'staging_dir'])
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session || session.worker_pid === null) return;

    const activeJob = await trx
      .selectFrom('jobs')
      .select('id')
      .where('type', '=', 'transcode')
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!activeJob) return;

    console.warn(
      `playback: heartbeat sweeper ended session ${sessionId} while it still named a live transcode ` +
        `pipeline (ffmpeg pid ${session.worker_pid}, staging ${session.staging_dir ?? 'unknown'}) and a ` +
        `'transcode' job ledger row is still active. That combination is the orphaned-encoder signature: ` +
        `the admission slot is now free while the process may still be running. The worker reclaims it at ` +
        `its next boot (apps/worker/src/transcode/reaper.ts); check the process now if the machine is busy.`,
    );
  } catch {
    /* a diagnostic must never fail the sweep */
  }
}

// ---------------------------------------------------------------------------
// Phase 3 §11 step 6a — transcode session control-channel columns
// (migrations/0012_transcode_sessions.sql). The functions below are the
// SERVER-WRITTEN half of the worker<->server seam documented in that
// migration's header and, verbatim, in apps/worker/src/transcode/index.ts (module header):
// Lane B (apps/server) drives a running transcode session ENTIRELY by
// writing these columns + creating rows — no other IPC. Own-session-scoped
// (ctx.userId) exactly like every other function in this file (module
// header) — a viewer can only steer their OWN session's pipeline.
// ---------------------------------------------------------------------------

/**
 * Records the highest HLS segment index the client has actually requested
 * (Lane B's future segment/playlist GET handler calls this on every
 * request). Worker throttle input (docs/PLAYBACK.md §9). A no-op (returns
 * undefined) for a nonexistent/foreign/already-terminal session — the
 * caller is expected to treat that as "nothing to steer", not an error.
 */
export async function updateRequestedSegment(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string,
  requestedSegment: number,
  nowMs: number
): Promise<PlaybackSessionRow | undefined> {
  const row = await db
    .updateTable('playback_sessions')
    .set({ requested_segment: requestedSegment, updated_at_ms: nowMs })
    .where('id', '=', id)
    .where('user_id', '=', ctx.userId)
    .where('status', 'not in', ['ended', 'failed'])
    .returningAll()
    .executeTakeFirst();
  if (!row) return undefined;
  return getPlaybackSessionForUser(db, ctx, id);
}

/**
 * Records a seek target OUTSIDE the session's currently-produced segment
 * range (docs/PLAYBACK.md §9 — Lane B decides "outside produced range"
 * using its own knowledge of `produced_segment` + policy.segmentDurationSec
 * and only calls this when a restart is actually needed; this function
 * itself does not re-derive that decision, matching every other
 * write-what-the-caller-already-decided function in this package, e.g.
 * createPlaybackSession's docstring above). The worker consumes (reads +
 * nulls) `seek_target_ms` atomically in its own restart transaction — see
 * migrations/0012_transcode_sessions.sql's column comment. `seekTargetMs`
 * is milliseconds (module-wide convention, CLAUDE.md invariant 5); the
 * worker divides by 1000 for ffmpeg's `-ss` seconds argument.
 */
export async function requestSeek(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string,
  seekTargetMs: number,
  nowMs: number
): Promise<PlaybackSessionRow | undefined> {
  const row = await db
    .updateTable('playback_sessions')
    .set({ seek_target_ms: seekTargetMs, updated_at_ms: nowMs })
    .where('id', '=', id)
    .where('user_id', '=', ctx.userId)
    .where('status', 'not in', ['ended', 'failed'])
    .returningAll()
    .executeTakeFirst();
  if (!row) return undefined;
  return getPlaybackSessionForUser(db, ctx, id);
}

/**
 * Heartbeat-staleness suspend candidates (docs/PLAYBACK.md §9: "no
 * heartbeat for 90s -> suspend"): sessions in `active` whose last heartbeat
 * (or, absent one, start time) is older than `cutoffMs`. NOT
 * ViewerContext-scoped (module header, same reasoning as
 * listStalePlaybackSessions) — a system-wide maintenance read for the
 * (future) extended sweeper. Deliberately scoped to `active` only:
 * `starting`/`seeking` are transient worker-driven states a heartbeat
 * timer has no business interrupting, and `suspended` is already
 * suspended (by either cause) so there is nothing new to do.
 */
export async function listHeartbeatStalePlaybackSessions(db: Kysely<DB>, cutoffMs: number): Promise<PlaybackSessionRow[]> {
  const rows = await baseSelect(db)
    .where('playback_sessions.status', '=', 'active')
    .where((eb) =>
      eb.or([
        eb.and([
          eb('playback_sessions.last_heartbeat_ms', 'is not', null),
          eb('playback_sessions.last_heartbeat_ms', '<', cutoffMs),
        ]),
        eb.and([
          eb('playback_sessions.last_heartbeat_ms', 'is', null),
          eb('playback_sessions.started_at_ms', '<', cutoffMs),
        ]),
      ])
    )
    .execute();
  return rows.map(mapRow);
}

/**
 * Marks a session `suspended` for a heartbeat-staleness cause (as opposed
 * to the worker's own throttle — see migrations/0012_transcode_sessions.sql's
 * header for the two-cause disambiguation). `suspended_by_throttle` is
 * explicitly set false here: this is never the worker's throttle cause.
 * Idempotent (a session already `suspended`/`ended`/`failed` is a no-op,
 * `WHERE status = 'active'` guards it) and does NOT touch
 * `last_heartbeat_ms`/emit any event — a suspend is not a session end, and
 * the NEXT real heartbeat (heartbeatPlaybackSession above) is what flips
 * status back to `active` unconditionally, exactly as it does today.
 */
export async function suspendStalePlaybackSession(db: Kysely<DB>, id: string, nowMs: number): Promise<PlaybackSessionRow | undefined> {
  const row = await db
    .updateTable('playback_sessions')
    .set({ status: 'suspended', suspended_by_throttle: false, updated_at_ms: nowMs })
    .where('id', '=', id)
    .where('status', '=', 'active')
    .returningAll()
    .executeTakeFirst();
  if (!row) return undefined;
  const current = await baseSelect(db).where('playback_sessions.id', '=', id).executeTakeFirst();
  return current ? mapRow(current) : undefined;
}

// ---------------------------------------------------------------------------
// Phase 3 §11 step 6b (Lane B) — admission control
// ---------------------------------------------------------------------------

/**
 * Global transcode-slot admission count (docs/PLAYBACK.md §9:
 * "Concurrency: global semaphore = `maxSimultaneousTranscodes`"). Counts
 * every session in a non-terminal state (`created`/`starting`/`active`/
 * `suspended`/`seeking`) whose STORED plan's `decision` is anything other
 * than `'direct-play'` — a direct-play session never runs a worker pipeline
 * at all (docs/PLAYBACK.md §9: "Direct-play sessions bypass all of this"),
 * so it never occupies a slot, matching apps/worker/src/transcode/index.ts's
 * own "one 'transcode' job per non-direct-play session" contract. NOT
 * ViewerContext-scoped — admission is a system-wide semaphore across every
 * user, the same class of read as listStalePlaybackSessions/
 * listHeartbeatStalePlaybackSessions above, not a per-viewer catalog read.
 */
export async function countActiveTranscodeSessions(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom('playback_sessions')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', 'in', ['created', 'starting', 'active', 'suspended', 'seeking'])
    .where(sql<string>`plan ->> 'decision'`, '!=', 'direct-play')
    .executeTakeFirst();
  return row ? Number(row.count) : 0;
}
