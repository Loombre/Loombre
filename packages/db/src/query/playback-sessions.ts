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
import { emitSessionStatusChanged, readSessionStatusSnapshot, withTransaction, writeEvent } from '../internal/index.js';

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
  /** migrations/0044 (docs/PLAYBACK.md §9.1.3) — the ladder rung the live
   *  pipeline is encoding. NULL means "no rung applies" (direct-play,
   *  ladder-empty, pre-C2), NEVER rung 0. */
  activeRungIndex: number | null;
  /** migrations/0044 — a requested rung switch awaiting the worker's next
   *  poll tick. */
  pendingRungIndex: number | null;
  /** migrations/0045 (d4-f2) — the highest segment index this session has
   *  ever SERVED (200 + real bytes), monotonic, written only on that
   *  success path. PROGRESS, as opposed to `requestedSegment`'s DEMAND.
   *  NULL means "never served a segment", never index 0. */
  highestServedSegment: number | null;
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
  active_rung_index: number | null;
  pending_rung_index: number | null;
  highest_served_segment: number | null;
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
    activeRungIndex: row.active_rung_index,
    pendingRungIndex: row.pending_rung_index,
    highestServedSegment: row.highest_served_segment,
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
      'playback_sessions.active_rung_index as active_rung_index',
      'playback_sessions.pending_rung_index as pending_rung_index',
      'playback_sessions.highest_served_segment as highest_served_segment',
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
      active_rung_index: inserted.active_rung_index,
      pending_rung_index: inserted.pending_rung_index,
      highest_served_segment: inserted.highest_served_segment,
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
    // A heartbeat is accepted from a session that is created/active, OR one
    // the SWEEPER suspended for heartbeat staleness (`suspended` with
    // `suspended_by_throttle = false`) — the viewer slept the laptop and
    // came back. Reviving it here (status -> active) is what lets the
    // worker's reconciler SIGCONT the encoder (its 'active && stopped ->
    // resume' branch) and what keeps a returning viewer out of the SPF-9
    // admission-eviction candidate set, whose staleness test reads
    // last_heartbeat_ms. A THROTTLE-suspended row (flag true) stays the
    // worker's alone: a heartbeat says nothing about encoder lead.
    const current = await baseSelect(trx)
      .where('playback_sessions.id', '=', id)
      .where('playback_sessions.user_id', '=', ctx.userId)
      .where((eb) =>
        eb.or([
          eb('playback_sessions.status', 'in', ['created', 'active']),
          eb.and([eb('playback_sessions.status', '=', 'suspended'), eb('playback_sessions.suspended_by_throttle', '=', false)]),
        ])
      )
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
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['created', 'active'] satisfies PlaybackSessionStatus[]),
          eb.and([eb('status', '=', 'suspended' satisfies PlaybackSessionStatus), eb('suspended_by_throttle', '=', false)]),
        ])
      )
      .returningAll()
      .executeTakeFirst();
    // Lost the race: someone else closed the session first. "A heartbeat
    // cannot revive a dead session" (docstring) — undefined, no event.
    if (!updated) return undefined;

    if (current.status === 'suspended') {
      await emitSessionStatusChanged(
        trx,
        id,
        { status: current.status, suspended_by_throttle: current.suspended_by_throttle },
        { status: updated.status, suspended_by_throttle: updated.suspended_by_throttle },
        'heartbeat-resume',
        nowMs
      );
    }

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

type EndReason = 'client-stopped' | 'idle-timeout' | 'server-error' | 'revoked' | 'completed' | 'admission-eviction';

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
async function warnOnOrphanSignature(trx: Transaction<DB>, sessionId: string, causeLabel: string = 'heartbeat sweeper'): Promise<void> {
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
      `playback: ${causeLabel} ended session ${sessionId} while it still named a live transcode ` +
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
 *
 * DEMAND, NOT PROGRESS (d4-f2 / migration 0045). This is written on EVERY
 * segment GET, including ones answered 503 and ones naming an index far
 * ahead of anything produced — deliberately, because that is exactly the
 * signal the segment-ahead throttle must react to (a client asking for
 * more is the reason to un-suspend an encoder). Consumers that need "how
 * far has this client actually GOT" read `highest_served_segment` instead;
 * see `recordServedSegment` below.
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
 * d4-f2 (migration 0045): records that a segment index was actually SERVED
 * — 200 with a real file body. The PROGRESS watermark, as opposed to
 * `updateRequestedSegment`'s DEMAND.
 *
 * MONOTONIC IN SQL, not in the caller: the write is a `GREATEST` against
 * the stored value, so concurrent/out-of-order fragment loads (hls.js
 * issues parallel loads and retries a segment or two out of order as a
 * matter of course) can never walk the watermark backward, and no caller
 * has to read-then-write. `NULL` — never served anything — is the identity
 * for that GREATEST, hence the COALESCE to the incoming index.
 *
 * Returns nothing and re-reads nothing: this runs on the hot segment-
 * serving path (CLAUDE.md invariant 9), where `updateRequestedSegment`'s
 * convenience re-read would be a second round trip for a value no caller
 * wants. A no-op for a nonexistent/foreign/already-terminal session, the
 * same "nothing to steer" contract as its sibling above.
 */
export async function recordServedSegment(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string,
  servedSegment: number,
  nowMs: number
): Promise<void> {
  await db
    .updateTable('playback_sessions')
    .set({
      highest_served_segment: sql<number>`greatest(coalesce(highest_served_segment, ${servedSegment}), ${servedSegment})`,
      updated_at_ms: nowMs,
    })
    .where('id', '=', id)
    .where('user_id', '=', ctx.userId)
    .where('status', 'not in', ['ended', 'failed'])
    .execute();
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
 * Records a rung-switch request — the SERVER half of the §9.1 slot-handoff
 * control channel (migrations/0044_playback_rung_switch.sql), and the exact
 * counterpart of `requestSeek` above: same own-session scoping, same
 * terminal-state guard, same "write what the caller already decided"
 * posture. The caller (apps/server's hls-file.controller.ts) is what
 * decides a `v{K}` GET names a rung other than the active one, and what
 * validates `0 <= K < ladder.length` against the stored plan; this function
 * re-derives neither.
 *
 * ABSORB-ON-MATCH, and this is the one thing it does that `requestSeek`
 * does not. A client pinned to a rung fetches EVERY playlist and segment
 * under that rung's `v{K}/` prefix, so without this guard a steady,
 * switch-free stream would write a "pending switch" on every single GET —
 * a request storm the worker would then have to read and discard once per
 * poll tick, forever. `WHERE active_rung_index IS DISTINCT FROM $K` makes
 * a request naming the already-active rung write nothing at all. It is the
 * write-side analogue of the seek absorption the worker performs at the
 * read side (`absorbSeekTarget`), placed at the door because that is where
 * this particular storm originates.
 *
 * `IS DISTINCT FROM` rather than `<>` deliberately: `active_rung_index` is
 * NULL until the worker's first spawn records one, and a NULL comparison
 * with `<>` is NULL — i.e. not true — which would silently drop every
 * switch request arriving in that window. A session with no recorded rung
 * yet has nothing to match, so every request is genuinely new.
 *
 * Returns `undefined` for a nonexistent/foreign/terminal session. An
 * ABSORBED request is NOT undefined — the session exists and the client's
 * intent is already satisfied — so it returns the row, whose
 * `pendingRungIndex` is simply unchanged.
 */
export async function requestRungSwitch(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string,
  ladderRungIndex: number,
  nowMs: number
): Promise<PlaybackSessionRow | undefined> {
  const existing = await getPlaybackSessionForUser(db, ctx, id);
  if (!existing || existing.status === 'ended' || existing.status === 'failed') return undefined;

  await db
    .updateTable('playback_sessions')
    .set({ pending_rung_index: ladderRungIndex, updated_at_ms: nowMs })
    .where('id', '=', id)
    .where('user_id', '=', ctx.userId)
    .where('status', 'not in', ['ended', 'failed'])
    .where(sql<boolean>`active_rung_index IS DISTINCT FROM ${ladderRungIndex}`)
    .execute();

  return getPlaybackSessionForUser(db, ctx, id);
}

/**
 * BOTH intentions of ONE request, in ONE statement (docs/PLAYBACK.md
 * §9.1.7) — the write-side counterpart of the worker's single-restart rule.
 *
 * A single segment GET can carry a seek AND a switch: a far-ahead index
 * under a `v{K}` naming a rung other than the active one. hls.js produces
 * exactly that whenever an ABR level change coincides with a scrub, or when
 * a level switch's first fragment request lands past the produced edge.
 * The worker already reads both columns in the same tick and spawns ONE run
 * for the pair; issuing the two writes as separate statements left a window
 * in which a poll tick observes only the first, so the session pays a
 * handoff restart at the live-edge continuation origin AND THEN a seek
 * restart at the requested origin — two of the most expensive operations
 * this runtime performs for one client intention, with an intermediate run
 * producing bytes nobody asked for. One statement makes that interleaving
 * inexpressible rather than merely unlikely.
 *
 * THE RUNG HALF KEEPS `requestRungSwitch`'s ABSORB-ON-MATCH, and the seek
 * half must NOT inherit it — which is why the absorb lives in a CASE
 * expression rather than the WHERE clause. Hoisting `active_rung_index IS
 * DISTINCT FROM K` into the WHERE would make a pinned client's seek within
 * its own rung (K == active, a very common shape) write nothing at all,
 * silently dropping a real seek. The CASE also leaves an unconsumed pending
 * rung for a DIFFERENT rung untouched: an absorbed rung half is a no-op on
 * the column, never a clear.
 *
 * Own-session scoping, terminal guard, and the "write what the caller
 * already decided" posture are identical to both halves it replaces.
 */
export async function requestSeekWithRungSwitch(
  db: Kysely<DB>,
  ctx: ViewerContext,
  id: string,
  seekTargetMs: number,
  ladderRungIndex: number,
  nowMs: number
): Promise<PlaybackSessionRow | undefined> {
  const row = await db
    .updateTable('playback_sessions')
    .set({
      seek_target_ms: seekTargetMs,
      pending_rung_index: sql<number | null>`CASE WHEN active_rung_index IS DISTINCT FROM ${ladderRungIndex} THEN ${ladderRungIndex} ELSE pending_rung_index END`,
      updated_at_ms: nowMs,
    })
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
 * `last_heartbeat_ms` — a suspend is not a session end, and the NEXT real
 * heartbeat (heartbeatPlaybackSession above) is what flips status back to
 * `active` unconditionally, exactly as it does today.
 *
 * d4-f5 (E/d3-e5 follow-up) — IT DOES EMIT NOW. d3-e5 gave every
 * non-terminal status write a `playback.session-status-changed` event so
 * the admin now-playing surfaces stop learning about transitions from a
 * 30s poll; this write was left out only because it lives in apps/server's
 * sweeper rather than the worker's pipeline, and it is the single most
 * admin-visible transition of the lot (the abandoned-session shape d3-e3
 * renders). `reason: 'heartbeat-stale'` plus `suspendedByThrottle: false`
 * is what tells an admin surface this apart from the throttle's healthy
 * park. Emitted through the SAME shared helper the worker's writes use
 * (internal/transcode-sessions.ts), inside the same transaction as the
 * UPDATE, and only when the pair actually moved — so the sweeper's
 * per-tick re-read of its candidate set cannot produce a duplicate.
 *
 * The sweeper's OTHER pass (the 15-minute cutoff -> END) deliberately does
 * NOT emit this: a terminal transition already emits playback.ended, and
 * two events for one moment make an admin surface race itself (the schema's
 * own rule).
 *
 * `heartbeatStale` on AdminSession stays per-request-derived regardless —
 * whether a CLIENT is still there is not something this row records — so
 * the fallback poll remains necessary; this only removes the up-to-30s lag
 * on the STATUS pill.
 */
export async function suspendStalePlaybackSession(db: Kysely<DB>, id: string, nowMs: number): Promise<PlaybackSessionRow | undefined> {
  return withTransaction(db, async (trx) => {
    const before = await readSessionStatusSnapshot(trx, id);
    const row = await trx
      .updateTable('playback_sessions')
      .set({ status: 'suspended', suspended_by_throttle: false, updated_at_ms: nowMs })
      .where('id', '=', id)
      .where('status', '=', 'active')
      .returningAll()
      .executeTakeFirst();
    if (!row) return undefined;
    await emitSessionStatusChanged(
      trx,
      id,
      before,
      { status: row.status, suspended_by_throttle: row.suspended_by_throttle },
      'heartbeat-stale',
      nowMs
    );
    const current = await baseSelect(trx).where('playback_sessions.id', '=', id).executeTakeFirst();
    return current ? mapRow(current) : undefined;
  });
}

// ---------------------------------------------------------------------------
// migrations/0043_transcode_runs.sql — segment index -> source time
//
// The reads a server-side consumer needs to interpret a served segment
// index. Segment numbering is GLOBAL across a session's runs (docs/
// PLAYBACK.md §9: a seek restart continues the previous run's numbering)
// while each seek run's own output timeline restarts at zero, because runs
// are spawned with `-ss` and without `-copyts`. The two are reconnected by
// the run's recorded source origin, and nothing else can do it: the served
// playlist's own durations describe PRESENTATION time, which is exactly
// what diverges.
//
// Not ViewerContext-scoped, and deliberately so — matching
// getMediaFileForPlaybackSession above: authorization for this session was
// already established by the caller resolving it through
// getPlaybackSessionForUser, and these are plain lookups keyed by that
// session id, not a second guard gate. The worker-side WRITER lives in
// src/internal/transcode-sessions.ts (recordTranscodeRun).
// ---------------------------------------------------------------------------

export interface TranscodeRunRow {
  runIndex: number;
  /** The absolute segment index this run begins numbering at. */
  startSegment: number;
  /** Where this run starts in the SOURCE timeline, milliseconds. */
  sourceOriginMs: number;
}

/**
 * The run that owns `segmentIndex` — the one with the greatest
 * `start_segment` at or below it.
 *
 * Ownership follows the SEGMENT COUNTER, never the source clock: a
 * backward seek starts a later run at an EARLIER source origin, so
 * `source_origin_ms` is not monotonic across a session's runs and ordering
 * by it would hand back the wrong run. `start_segment` is the only
 * monotonic key, which is why the index is on it.
 *
 * Returns `undefined` when the session has no recorded runs (a direct-play
 * session, a session whose pipeline never started, or one predating
 * migration 0043) — callers should treat that as "no source anchor
 * available", never as "origin 0".
 *
 * ---------------------------------------------------------------------------
 * THE EXTENT RULE (docs/PLAYBACK.md §9.1.3, normative — stated HERE, at the
 * call site, rather than only in the spec, because this is where the trap
 * is walked into).
 *
 * A `transcode_runs` row records where a run STARTS. It records NOTHING
 * about where it ends. Deriving a run's extent from one row alone — e.g.
 * "the run's segments are the ones with `index >= start_segment`" — is
 * FORBIDDEN: that predicate sweeps in every LATER run's segments too, and
 * under ABR (Wave C2) later runs are routinely a DIFFERENT rung and a
 * different region of the source.
 *
 * A consumer needing a run's extent MUST use one of exactly two derivations:
 *   (a) the served playlist's own `runN/` URI prefix — the on-disk truth,
 *       which is what apps/server/src/common/served-playlist.ts's
 *       `deriveSegmentStartMs`/`presentationToSourceMs` already do; or
 *   (b) the NEXT run's `start_segment − 1` as the closed upper bound, taken
 *       from the session's full ordered run set (`listTranscodeRuns` below).
 *       Valid because `{START_SEG} = producedSegment + 1` makes consecutive
 *       runs' segment ranges partition the counter with no gaps and no
 *       overlaps; the CURRENT run is unbounded above.
 * ---------------------------------------------------------------------------
 */
export async function getTranscodeRunForSegment(
  db: Kysely<DB>,
  sessionId: string,
  segmentIndex: number
): Promise<TranscodeRunRow | undefined> {
  const row = await db
    .selectFrom('transcode_runs')
    .select(['run_index', 'start_segment', 'source_origin_ms'])
    .where('session_id', '=', sessionId)
    .where('start_segment', '<=', segmentIndex)
    .orderBy('start_segment', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return undefined;
  return { runIndex: row.run_index, startSegment: row.start_segment, sourceOriginMs: row.source_origin_ms };
}

/** Every recorded run for a session, in run order — the whole segment->
 *  source map in one read, for a caller that needs to interpret more than
 *  a single index (rendering a playlist, reconstructing a resume point). */
export async function listTranscodeRuns(db: Kysely<DB>, sessionId: string): Promise<TranscodeRunRow[]> {
  const rows = await db
    .selectFrom('transcode_runs')
    .select(['run_index', 'start_segment', 'source_origin_ms'])
    .where('session_id', '=', sessionId)
    .orderBy('run_index', 'asc')
    .execute();
  return rows.map((row) => ({ runIndex: row.run_index, startSegment: row.start_segment, sourceOriginMs: row.source_origin_ms }));
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

/**
 * SPF-9 admission-time reclamation: ends the SINGLE stalest
 * heartbeat-suspended transcode session so admission has a slot to hand to
 * a NEW request, instead of refusing it outright while a paused-and-
 * walked-away viewer sits on one indefinitely.
 *
 * Candidate set, all three required:
 *   - `status = 'suspended'` AND `suspended_by_throttle = false` — a
 *     heartbeat-cause suspend (the client stopped polling), never the
 *     worker's own segment-ahead throttle park (that session's encoder is
 *     deliberately paused mid-watch, not abandoned — the A5 law below still
 *     protects it as a live viewer's slot).
 *   - `plan ->> 'decision' != 'direct-play'` — direct-play never occupies a
 *     slot (countActiveTranscodeSessions' own rule); nothing to reclaim.
 *   - no heartbeat (or none ever recorded) for at least `cutoffMs` — the
 *     SAME predicate/cutoff the sweeper's own
 *     listHeartbeatStalePlaybackSessions uses, passed in by the caller so
 *     this stays in lockstep with sessions.heartbeatSuspendCutoffMs
 *     (settings-registry.ts) rather than a second hardcoded number.
 *
 * Never touches an ACTIVE session (the A5 law: no setting/admission
 * decision may drop a session someone is actively watching) — only a row
 * already resting in `suspended` for a heartbeat cause is eligible at all.
 *
 * `FOR UPDATE OF playback_sessions ... SKIP LOCKED` (restricted to
 * playback_sessions, not the LEFT JOINed media_files — Postgres refuses
 * FOR UPDATE against the nullable side of an outer join) makes this safe
 * to call from inside transcode-admission.ts's own serialized critical
 * section: a concurrent caller racing the same cutoff skips a row this
 * transaction already holds rather than blocking on it, and `ORDER BY
 * last_heartbeat_ms ASC NULLS FIRST LIMIT 1` always picks the single
 * longest-idle candidate first.
 *
 * Returns the finalized (now `failed`, `error_code = 'evicted-for-
 * admission'`) row, or `undefined` when no session qualifies.
 */
export async function evictStalestSuspendedTranscodeSession(
  db: Kysely<DB>,
  { cutoffMs, nowMs }: { cutoffMs: number; nowMs: number }
): Promise<PlaybackSessionRow | undefined> {
  return withTransaction(db, async (trx) => {
    const current = await baseSelect(trx)
      .where('playback_sessions.status', '=', 'suspended')
      .where('playback_sessions.suspended_by_throttle', '=', false)
      .where(sql<string>`playback_sessions.plan ->> 'decision'`, '!=', 'direct-play')
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
      .orderBy('playback_sessions.last_heartbeat_ms', (ob) => ob.asc().nullsFirst())
      .limit(1)
      .forUpdate('playback_sessions')
      .skipLocked()
      .executeTakeFirst();

    if (!current) return undefined;

    const finalized = await finalizeSession(trx, current, nowMs, {
      errorCode: 'evicted-for-admission',
      reason: 'admission-eviction',
    });
    await warnOnOrphanSignature(trx, current.id, 'admission-time reclamation');
    return finalized;
  });
}
