// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/db/src/internal/transcode-sessions.ts
//
// WORKER-WRITTEN half of the transcode session control-channel seam
// (docs/PLAYBACK.md §9, Phase 3 §11 step 6a — see migrations/
// 0012_transcode_sessions.sql's header for the full column-ownership split,
// and apps/worker/src/transcode/index.ts (module header) for the verbatim seam contract
// this pairs with). Guard-free by the same reasoning as every other file in
// this directory (module header, src/internal/index.ts): a running
// transcode job already has its one sessionId from the job payload — it is
// not a viewer-scoped catalog read, it is the worker's own bookkeeping for a
// pipeline it is authoritatively supervising.
//
// Every transition below that can race against the row already having
// reached a TERMINAL state (`ended`/`failed`, written by Lane B's DELETE
// endpoint or its sweeper) is guarded with `WHERE status NOT IN ('ended',
// 'failed')` so the worker never resurrects or overwrites a session some
// other actor has already closed out — it just finds zero rows updated and
// the runtime treats that exactly like discovering `status` is already
// terminal on its next poll (local teardown only, no further row writes).
//
// Single-writer note: exactly one worker process ever runs a given
// session's job (one 'transcode' job = one sessionId, docs/PLAYBACK.md §9),
// and that process's own poll loop is sequential (never two concurrent
// writes to the SAME session from the SAME worker) — so, unlike
// `suspended_by_throttle` (genuinely racing against a server-authored
// heartbeat-staleness suspend), the functions below use plain
// last-write-wins UPDATEs rather than compare-and-swap arithmetic. The only
// cross-actor race every function here defends against is "has this
// session already been closed out by someone else" (the status guard),
// never "am I racing my own other write".

import type { Selectable, Transaction } from 'kysely';
import type { DB, PlaybackSessionStatus } from '../types.js';
import type { DbOrTx } from './tx.js';
import { withTransaction } from './tx.js';
import { writeEvent } from './events.js';

export type TranscodeSessionRow = Selectable<DB['playback_sessions']>;

const NON_TERMINAL_STATUSES: readonly PlaybackSessionStatus[] = [
  'created',
  'starting',
  'active',
  'suspended',
  'seeking',
];

/** Plain by-id read — everything the worker's runtime needs from the row on
 *  each poll tick. Returns `undefined` if the session no longer exists. */
export async function getTranscodeSessionRow(db: DbOrTx, sessionId: string): Promise<TranscodeSessionRow | undefined> {
  return db.selectFrom('playback_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst();
}

/**
 * First worker-owned transition: `created` -> `starting`, recording the
 * staging directory. Idempotent/resumable by construction: the UPDATE only
 * ever fires while `status = 'created'`; if the row has already moved past
 * that (e.g. a crashed worker's job got redelivered and a previous attempt
 * already recorded `staging_dir`), this is a harmless no-op and the
 * function simply returns whatever the row already says — never a second,
 * possibly-different `staging_dir` clobbering the first. Returns
 * `undefined` only if the session id does not exist at all.
 */
export async function markSessionStarting(
  db: DbOrTx,
  sessionId: string,
  input: { stagingDir: string; nowMs: number }
): Promise<TranscodeSessionRow | undefined> {
  await db
    .updateTable('playback_sessions')
    .set({ status: 'starting', staging_dir: input.stagingDir, updated_at_ms: input.nowMs })
    .where('id', '=', sessionId)
    .where('status', '=', 'created')
    .execute();
  return getTranscodeSessionRow(db, sessionId);
}

/**
 * `starting`/`seeking` -> `active`, recording the just-observed produced
 * segment (the "init + first segment produced" OBSERVABLE this step's
 * instructions require — Lane B's blocking first-playlist-request poll
 * watches for exactly this: `status = 'active' AND produced_segment IS NOT
 * NULL`). Guarded against a session that already reached a terminal state
 * — returns `undefined` in that case (caller: stop driving this pipeline,
 * proceed to local teardown).
 */
export async function markSessionActive(
  db: DbOrTx,
  sessionId: string,
  input: { producedSegment: number; nowMs: number }
): Promise<TranscodeSessionRow | undefined> {
  return db
    .updateTable('playback_sessions')
    .set({ status: 'active', produced_segment: input.producedSegment, updated_at_ms: input.nowMs })
    .where('id', '=', sessionId)
    .where('status', 'in', NON_TERMINAL_STATUSES)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Pure observability write: bumps `produced_segment` without touching
 * `status` (throttle input; does not by itself imply active/suspended).
 * Guarded off the terminal states only — safe to call on every poll tick
 * regardless of whether the session is currently active/suspended/seeking.
 */
export async function updateProducedSegment(
  db: DbOrTx,
  sessionId: string,
  producedSegment: number,
  nowMs: number
): Promise<TranscodeSessionRow | undefined> {
  return db
    .updateTable('playback_sessions')
    .set({ produced_segment: producedSegment, updated_at_ms: nowMs })
    .where('id', '=', sessionId)
    .where('status', 'in', NON_TERMINAL_STATUSES)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Throttle suspend/resume (docs/PLAYBACK.md §9 — mandatory, ahead > 10
 * suspends, ahead <= 5 resumes; see apps/worker/src/transcode/throttle.ts
 * for the full reconciliation this backs). Always writes
 * `suspended_by_throttle` alongside `status` — this function is the ONLY
 * writer of `suspended_by_throttle = true` in the whole system (migrations/
 * 0012_transcode_sessions.sql's header). Guarded off `seeking` too (a seek
 * restart in progress owns the status column until it reaches `active`
 * again) as well as the terminal states.
 */
export async function setThrottleSuspended(
  db: DbOrTx,
  sessionId: string,
  input: { suspended: boolean; nowMs: number }
): Promise<TranscodeSessionRow | undefined> {
  return db
    .updateTable('playback_sessions')
    .set({
      status: input.suspended ? 'suspended' : 'active',
      suspended_by_throttle: input.suspended,
      updated_at_ms: input.nowMs,
    })
    .where('id', '=', sessionId)
    .where('status', 'in', ['active', 'suspended'] satisfies PlaybackSessionStatus[])
    .returningAll()
    .executeTakeFirst();
}

export interface ConsumedSeekTarget {
  seekTargetMs: number;
  discontinuityCount: number;
}

/**
 * Atomically claims a pending seek target (docs/PLAYBACK.md §9 / migrations/
 * 0012_transcode_sessions.sql's column comment). Reads the CURRENT
 * `seek_target_ms`/`discontinuity_count` and, in the SAME transaction,
 * nulls the target + bumps the counter + moves `status` to `seeking` — so a
 * seek target is consumed exactly once no matter how the poll loop is
 * timed (a second call before the restart completes finds `seek_target_ms
 * IS NULL` and is a no-op). Returns `undefined` when there is nothing to
 * consume (no pending target, or the session is already terminal) — the
 * caller's normal steady-state path. The terminal-state guard is repeated
 * on the UPDATE itself, not just the leading SELECT: under READ COMMITTED
 * a second actor's close can commit between them, and only the UPDATE's
 * own WHERE clause is re-evaluated against the row as it stands at write
 * time — omitting it there would let this UPDATE still match on `id +
 * seek_target_ms IS NOT NULL` alone and resurrect a session someone else
 * just closed out (module header).
 */
export async function consumeSeekTarget(db: DbOrTx, sessionId: string, nowMs: number): Promise<ConsumedSeekTarget | undefined> {
  return withTransaction(db, async (trx: Transaction<DB>) => {
    const current = await trx
      .selectFrom('playback_sessions')
      .select(['seek_target_ms', 'discontinuity_count'])
      .where('id', '=', sessionId)
      .where('status', 'in', NON_TERMINAL_STATUSES)
      .where('seek_target_ms', 'is not', null)
      .executeTakeFirst();
    if (!current || current.seek_target_ms === null) return undefined;

    const nextCount = current.discontinuity_count + 1;
    const updated = await trx
      .updateTable('playback_sessions')
      .set({ seek_target_ms: null, discontinuity_count: nextCount, status: 'seeking', updated_at_ms: nowMs })
      .where('id', '=', sessionId)
      .where('seek_target_ms', 'is not', null)
      .where('status', 'in', NON_TERMINAL_STATUSES)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) return undefined;

    return { seekTargetMs: current.seek_target_ms, discontinuityCount: nextCount };
  });
}

/**
 * Sets `staging_dir` iff it is currently NULL (Phase 3 §11 step 6b,
 * P3.9(e)). Two consumers can independently need this session's staging
 * directory recorded: the transcode runtime's own `markSessionStarting`
 * (above, unconditional — a transcode session ALWAYS gets one) and the
 * NEW 'subtitle-extract' consumer (apps/worker/src/subtitles/**), which
 * needs a private working directory for a session that may never run a
 * transcode pipeline at all (a direct-play session carrying an hls-vtt
 * subtitle track — docs/PLAYBACK.md §9's "direct-play sessions bypass all
 * of this" is about the ENCODE pipeline, not subtitle extraction). Both
 * consumers resolve the SAME deterministic `sessionDirFor(stagingRoot,
 * sessionId)` path (apps/worker/src/transcode/staging.ts), so whichever one
 * runs first "wins" recording it and the second call here is a harmless
 * no-op (`WHERE staging_dir IS NULL` — never a clobber, since the value is
 * identical either way). Guarded off the terminal states like every other
 * write in this file.
 */
export async function ensureSessionStagingDir(
  db: DbOrTx,
  sessionId: string,
  stagingDir: string,
  nowMs: number
): Promise<TranscodeSessionRow | undefined> {
  return db
    .updateTable('playback_sessions')
    .set({ staging_dir: stagingDir, updated_at_ms: nowMs })
    .where('id', '=', sessionId)
    .where('staging_dir', 'is', null)
    .where('status', 'in', NON_TERMINAL_STATUSES)
    .returningAll()
    .executeTakeFirst();
}

export interface MarkSessionFailedInput {
  errorCode: string;
  /** Last 4 KB ring of ffmpeg stderr (docs/PLAYBACK.md §9 audit
   *  requirement) — may be empty string, never null, when the pipeline
   *  produced no stderr output at all before failing. */
  stderrTail: string;
  nowMs: number;
}

/**
 * Worker-detected failure (ffmpeg exited non-zero for a reason the worker
 * did not itself cause — i.e. not its own graceful-kill-for-seek/teardown).
 * Idempotent exactly like packages/db/src/query/playback-sessions.ts's
 * finalizeSession: a session already `ended`/`failed` (someone else closed
 * it out first — Lane B's DELETE endpoint, or the sweeper) is a no-op that
 * returns `undefined` and emits NOTHING, so `playback.ended` is never
 * double-written for one session (this step's binding constraint 6: "don't
 * double-emit"). itemId recovery mirrors that same file's documented
 * limitation: a hard-deleted file since session start omits `itemId` from
 * the payload rather than guessing.
 */
export async function markSessionFailed(db: DbOrTx, sessionId: string, input: MarkSessionFailedInput): Promise<TranscodeSessionRow | undefined> {
  return withTransaction(db, async (trx: Transaction<DB>) => {
    const current = await trx
      .selectFrom('playback_sessions')
      .leftJoin('media_files', 'media_files.id', 'playback_sessions.file_id')
      .select(['playback_sessions.id as id', 'playback_sessions.user_id as user_id', 'playback_sessions.device_id as device_id', 'media_files.item_id as item_id'])
      .where('playback_sessions.id', '=', sessionId)
      .where('playback_sessions.status', 'in', NON_TERMINAL_STATUSES)
      .executeTakeFirst();
    if (!current) return undefined;

    const updated = await trx
      .updateTable('playback_sessions')
      .set({
        status: 'failed',
        error_code: input.errorCode,
        stderr_tail: input.stderrTail,
        ended_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
      })
      .where('id', '=', sessionId)
      .where('status', 'in', NON_TERMINAL_STATUSES)
      .returningAll()
      .executeTakeFirst();
    // The leading SELECT's guard is already stale by the time this UPDATE
    // runs (a concurrent close — Lane B's DELETE endpoint or the sweeper —
    // can commit in between under READ COMMITTED), so the guard has to be
    // repeated here too: zero rows matched means someone else closed the
    // session first, in which case this is the documented no-op — same
    // idiom as consumeSeekTarget above.
    if (!updated) return undefined;

    await writeEvent(trx, {
      type: 'playback.ended',
      tsMs: input.nowMs,
      actorUserId: current.user_id,
      payload: {
        sessionId,
        ...(current.item_id !== null ? { itemId: current.item_id } : {}),
        deviceId: current.device_id,
        reason: 'server-error',
        errorCode: input.errorCode,
        finalPositionMs: null,
        endedAtMs: input.nowMs,
      },
    });

    return updated;
  });
}
