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
 * Clears a pending seek target WITHOUT restarting anything — the
 * "absorb" counterpart to consumeSeekTarget above (process-lifecycle
 * hardening wave, 2026-08-11, continuation item 1).
 *
 * WHY A SECOND FUNCTION rather than a flag on consumeSeekTarget: the two
 * do genuinely different things to the row. consumeSeekTarget CLAIMS a
 * target — it bumps `discontinuity_count` and moves `status` to
 * `seeking`, because a real restart is about to produce a discontinuity in
 * the served playlist. Absorbing does neither: nothing restarts, the
 * playlist gains no discontinuity, and the session's status is whatever it
 * already was. Folding both into one function would mean a boolean that
 * changes what the row means.
 *
 * The redundant-request case it exists for: a client retrying a
 * 503-retry-after for one too-far-ahead segment makes the server record
 * the SAME seek target on every retry. The worker is already producing
 * exactly that position; consuming each repeat killed and respawned the
 * run before it could ever produce its first segment (a livelock — see
 * apps/worker/src/transcode/runner.ts's seek block).
 *
 * `WHERE seek_target_ms = $expected` is the whole safety property: if a
 * DIFFERENT target was written between the caller's read and this write,
 * zero rows match, nothing is cleared, and the caller sees the new target
 * on its next poll and restarts for it properly. A redundant request is
 * never able to swallow a real one.
 */
export async function absorbSeekTarget(
  db: DbOrTx,
  sessionId: string,
  expectedSeekTargetMs: number,
  nowMs: number
): Promise<boolean> {
  const result = await db
    .updateTable('playback_sessions')
    .set({ seek_target_ms: null, updated_at_ms: nowMs })
    .where('id', '=', sessionId)
    .where('seek_target_ms', '=', expectedSeekTargetMs)
    .where('status', 'in', NON_TERMINAL_STATUSES)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
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

// ---------------------------------------------------------------------------
// migrations/0041_playback_sessions_worker_process.sql (item C2) — the
// crash-survival bookkeeping. See that migration's header for the full
// rationale; the short version is that a hard-killed worker runs no
// shutdown code, so the only handle left on its orphaned ffmpeg children
// is what it wrote to the row before it died.
// ---------------------------------------------------------------------------

export interface RecordSessionWorkerProcessInput {
  /** The LIVE ffmpeg run's OS pid (apps/worker/src/transcode/process.ts's
   *  FfmpegRunHandle.pid). Rewritten on every seek-restart, since each
   *  restart is a new process. */
  workerPid: number;
  /** The SUPERVISING WORKER PROCESS's start time — the generation marker
   *  the boot reaper compares against its own start time. Not the
   *  ffmpeg's. */
  workerStartedAtMs: number;
  nowMs: number;
}

/**
 * Records which ffmpeg process, under which worker generation, is
 * currently driving this session. Guarded off the terminal states like
 * every other write in this file: a session someone else already closed
 * out must not acquire a pid that the next boot's reaper would then go
 * looking for.
 */
export async function recordSessionWorkerProcess(
  db: DbOrTx,
  sessionId: string,
  input: RecordSessionWorkerProcessInput
): Promise<TranscodeSessionRow | undefined> {
  return db
    .updateTable('playback_sessions')
    .set({
      worker_pid: input.workerPid,
      worker_started_at_ms: input.workerStartedAtMs,
      updated_at_ms: input.nowMs,
    })
    .where('id', '=', sessionId)
    .where('status', 'in', NON_TERMINAL_STATUSES)
    .returningAll()
    .executeTakeFirst();
}

export interface ReapableTranscodeSessionRow {
  id: string;
  worker_pid: number;
  worker_started_at_ms: number | null;
  staging_dir: string | null;
}

/**
 * The boot reaper's candidate set (apps/worker/src/transcode/reaper.ts):
 * every non-terminal session carrying a pid recorded by a worker
 * generation that started BEFORE `workerStartedBeforeMs` — in practice,
 * the booting worker's own start time.
 *
 * The horizon is a generation marker, not an age: the shipped topology is
 * one worker per database (worker-liveness.ts embeds the same
 * assumption), so a session still non-terminal from before this process
 * existed was orphaned by a dead predecessor no matter how recently it
 * was touched — exactly the reasoning jobs.ts's `activeStaleBeforeMs`
 * already uses for the job ledger. A row this process itself wrote
 * carries this process's own start time and can never qualify.
 *
 * Rows with `worker_started_at_ms IS NULL` (a pid recorded before this
 * column existed — impossible in practice, since both landed in the same
 * migration, but cheap to be exact about) are treated as belonging to an
 * unknown, therefore previous, generation.
 *
 * Not ViewerContext-scoped, like everything in this directory: the reaper
 * is instance-level maintenance with no requesting viewer.
 */
export async function listReapableTranscodeSessions(
  db: DbOrTx,
  input: { workerStartedBeforeMs: number }
): Promise<ReapableTranscodeSessionRow[]> {
  const rows = await db
    .selectFrom('playback_sessions')
    .select(['id', 'worker_pid', 'worker_started_at_ms', 'staging_dir'])
    .where('status', 'in', NON_TERMINAL_STATUSES)
    .where('worker_pid', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('worker_started_at_ms', 'is', null),
        eb('worker_started_at_ms', '<', input.workerStartedBeforeMs),
      ])
    )
    .execute();
  return rows.map((row) => ({
    id: row.id,
    worker_pid: row.worker_pid as number,
    worker_started_at_ms: row.worker_started_at_ms,
    staging_dir: row.staging_dir,
  }));
}

// ---------------------------------------------------------------------------
// migrations/0043_transcode_runs.sql (continuation item 2) — per-run
// source-origin recording. See that migration's header for why segment
// indices alone cannot answer "what source position is this?" for any run
// after the first.
// ---------------------------------------------------------------------------

export interface RecordTranscodeRunInput {
  sessionId: string;
  /** Zero-based, matching the run's `runN` staging subdirectory. */
  runIndex: number;
  /** The absolute segment index this run begins numbering at ({START_SEG}). */
  startSegment: number;
  /** Where this run starts in the SOURCE timeline: 0 for run 0, the
   *  consumed (already clamped) seek target for a restart, and — Wave C2,
   *  docs/PLAYBACK.md §9.1.4 step 3 — `old.sourceOriginMs + old.producedMs`
   *  for a slot handoff. */
  sourceOriginMs: number;
  /** Wave C2 (migration 0044): which rung of the stored plan's ladder this
   *  run encoded. OMITTED (-> NULL) for ladder-empty sessions — never
   *  defaulted to 0, which is the ladder's TOP rung and would falsely claim
   *  top quality. */
  ladderRungIndex?: number;
  nowMs: number;
}

/**
 * Records one spawned run. Idempotent per `(session_id, run_index)`: a
 * redelivered 'transcode' job re-spawning run 0 must update the row rather
 * than fail on the unique constraint or leave a stale origin behind.
 *
 * Deliberately NOT guarded on the session's status, unlike every other
 * write in this file: this is an audit fact about a process that really was
 * spawned. If the session is closed out in the same instant, the row is
 * still true, still needed to interpret whatever segments that run wrote
 * before teardown, and dies with the session anyway (ON DELETE CASCADE).
 */
export async function recordTranscodeRun(db: DbOrTx, input: RecordTranscodeRunInput): Promise<void> {
  const rungIndex = input.ladderRungIndex ?? null;
  await db
    .insertInto('transcode_runs')
    .values({
      session_id: input.sessionId,
      run_index: input.runIndex,
      start_segment: input.startSegment,
      source_origin_ms: input.sourceOriginMs,
      ladder_rung_index: rungIndex,
      created_at_ms: input.nowMs,
    })
    .onConflict((oc) =>
      oc.columns(['session_id', 'run_index']).doUpdateSet({
        start_segment: input.startSegment,
        source_origin_ms: input.sourceOriginMs,
        ladder_rung_index: rungIndex,
        created_at_ms: input.nowMs,
      })
    )
    .execute();
}

// ---------------------------------------------------------------------------
// migrations/0044_playback_rung_switch.sql (Wave C2, docs/PLAYBACK.md §9.1) —
// the WORKER half of the slot-handoff control channel. The server half
// (`requestRungSwitch`) lives in src/query/playback-sessions.ts, exactly as
// `requestSeek` and `consumeSeekTarget` are split.
// ---------------------------------------------------------------------------

/**
 * Records which ladder rung the live pipeline is encoding — written at
 * EVERY spawn (run 0's initial rung and every §9.1.4 handoff alike), so the
 * row always names what is really running. That is the same discipline
 * `recordSessionWorkerProcess` follows for the pid, and for the same
 * reason: the server decides whether an incoming `v{K}` GET is a switch
 * signal by comparing K against this column, so a stale value would make it
 * either miss a real switch or manufacture a phantom one.
 *
 * SELF-CLEARS AN ALREADY-SATISFIED REQUEST. A `pending_rung_index` equal to
 * the rung being recorded is a request this very spawn fulfils, and nothing
 * else in the system would ever clear it: the worker's restart block only
 * reacts to a pending rung that DIFFERS from the running one (§9.1.7's
 * `switchPending`), so an equal value is skipped on every tick from then on.
 * It arises from a real, narrow window — the worker consumes the pending
 * rung and only afterwards records the new active one, so a `v{K}` GET
 * landing between those two writes still sees the OLD active rung, passes
 * `requestRungSwitch`'s absorb-on-match, and re-writes the rung that is at
 * that moment being spawned. Harmless to playback, but the row then claims a
 * pending switch that will never happen, to `GET /playback/sessions/{id}`
 * and to anyone reading it during an incident.
 *
 * The clear is a COMPARE-and-clear, in this same statement: a pending rung
 * naming something ELSE is a genuine newer request that must survive to the
 * next tick, exactly as `consumePendingRungIndex`'s own guard guarantees.
 *
 * Guarded off the terminal states like every other write in this file.
 */
export async function recordActiveRungIndex(
  db: DbOrTx,
  sessionId: string,
  ladderRungIndex: number,
  nowMs: number
): Promise<TranscodeSessionRow | undefined> {
  return db
    .updateTable('playback_sessions')
    .set((eb) => ({
      active_rung_index: ladderRungIndex,
      pending_rung_index: eb
        .case()
        .when('pending_rung_index', '=', ladderRungIndex)
        .then(null)
        .else(eb.ref('pending_rung_index'))
        .end(),
      updated_at_ms: nowMs,
    }))
    .where('id', '=', sessionId)
    .where('status', 'in', NON_TERMINAL_STATUSES)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Atomically claims a pending rung switch (docs/PLAYBACK.md §9.1.3),
 * mirroring `consumeSeekTarget`'s transaction shape — with two deliberate
 * differences that are the whole reason it is a separate function rather
 * than a flag:
 *
 *   1. It does NOT move `status` to `seeking`. A pure rung switch leaves
 *      the union playlist fully servable: everything the old rung produced
 *      stays on disk and stays correct, and only the LIVE EDGE waits while
 *      the new rung spawns (§9.1.4's status rule). A seek is different in
 *      kind — its restart INVALIDATES the forward timeline, which is what
 *      `seeking` announces.
 *   2. It does NOT bump `discontinuity_count`. That counter is
 *      seek-restart bookkeeping; the served playlist's own
 *      `EXT-X-DISCONTINUITY` tags come from run FOLDING
 *      (apps/worker/src/transcode/playlist.ts inserts one before every run
 *      after the first), not from this column. Bumping it here would also
 *      double-count the §9.1.7 coincident seek+switch tick, which is ONE
 *      restart.
 *
 * The UPDATE is guarded on the EXACT value the SELECT read, not merely on
 * `IS NOT NULL`: under READ COMMITTED a client can request a different rung
 * between the two statements, and clearing the column then would swallow a
 * request nothing else will ever re-send. Zero rows matched returns
 * `undefined` and the newer value survives to the next tick.
 *
 * Returns the rung index (0 IS a valid, common answer — it is the ladder's
 * top rung) or `undefined` when there is nothing to consume.
 */
export async function consumePendingRungIndex(db: DbOrTx, sessionId: string, nowMs: number): Promise<number | undefined> {
  return withTransaction(db, async (trx: Transaction<DB>) => {
    const current = await trx
      .selectFrom('playback_sessions')
      .select(['pending_rung_index'])
      .where('id', '=', sessionId)
      .where('status', 'in', NON_TERMINAL_STATUSES)
      .where('pending_rung_index', 'is not', null)
      .executeTakeFirst();
    if (!current || current.pending_rung_index === null) return undefined;

    const updated = await trx
      .updateTable('playback_sessions')
      .set({ pending_rung_index: null, updated_at_ms: nowMs })
      .where('id', '=', sessionId)
      .where('pending_rung_index', '=', current.pending_rung_index)
      .where('status', 'in', NON_TERMINAL_STATUSES)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) return undefined;

    return current.pending_rung_index;
  });
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
