// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Segment-ahead throttle (docs/PLAYBACK.md §9 — MANDATORY: "ahead > 10
 * segments (60s) suspend encode ... resume at ahead <= 5") and the P3.8
 * platform-mechanism decision (this step's binding constraints 2 and 4).
 *
 * ---------------------------------------------------------------------------
 * MECHANISM DECISION (P3.8, STATE.md): POSIX (darwin/linux) uses REAL
 * SIGSTOP/SIGCONT on the ffmpeg process group (apps/worker/src/transcode/
 * process.ts) — verified in this step's integration tests via `ps` state +
 * `produced_segment` stalling. Windows has NO new native dependency
 * available for job-object-based suspension (this step's binding
 * constraint 4 tried the no-new-dependency route FIRST and that is as far
 * as it goes without one) — the documented P3.8 fallback is `-readrate`
 * pacing: `injectReadrate(args, 1.2)` (args.ts) is applied to EVERY win32
 * ffmpeg run unconditionally, pacing the encode at ~1.2x realtime so it
 * structurally never races far enough ahead to need suspending in the
 * first place. Consequence, reported as a real behavioral difference (not
 * hidden): a win32 worker NEVER writes `suspended_by_throttle = true` and
 * NEVER SIGSTOPs anything — `reconcileThrottle` below always returns
 * `{ action: 'none' }` when `mechanism === 'readrate'`. If a future native
 * suspension helper lands, swapping it in only requires changing
 * `throttleMechanismForPlatform`'s win32 branch back to `'suspend'` and
 * plumbing a real suspend/resume through process.ts's already-platform-
 * generic `killProcessGroup` — this module's decision table does not
 * change at all, which is the point of keeping the two concerns (mechanism
 * selection vs. reconciliation logic) in separate, independently testable
 * functions.
 *
 * ---------------------------------------------------------------------------
 * RECONCILIATION (the `suspended` STATUS RACE, migrations/
 * 0012_transcode_sessions.sql's header): `status = 'suspended'` has two
 * independent causes sharing one enum value — THIS session's own
 * segment-ahead throttle (worker-authored, `suspendedByThrottle = true`)
 * and a stale-heartbeat suspend a future extended sweeper writes
 * (server-authored, `suspendedByThrottle = false`). The physical ffmpeg
 * process must be stopped whenever `status = 'suspended'` REGARDLESS OF
 * CAUSE (a heartbeat-stale viewer is not watching either), but the
 * worker's OWN throttle decision must remain authoritative over whether
 * IT thinks the session should resume — a heartbeat arriving (which
 * unconditionally flips `status` back to `active`,
 * packages/db/src/query/playback-sessions.ts's heartbeatPlaybackSession)
 * must not un-stick a still-way-too-far-ahead encode just because a
 * viewer's client happened to send a heartbeat before actually consuming
 * any more segments. The table below is exhaustive over
 * (suspendedByThrottle, rowStatus, ahead-vs-thresholds, processStopped).
 */

export type ThrottleMechanism = "suspend" | "readrate";

/** Fallback pacing multiplier for the win32 `-readrate` mechanism (P3.8,
 *  this step's binding constraint 4, verbatim value). */
export const WIN32_READRATE_MULTIPLIER = 1.2;

export function throttleMechanismForPlatform(platform: NodeJS.Platform): ThrottleMechanism {
  return platform === "win32" ? "readrate" : "suspend";
}

/** Registry defaults for transcode.segmentAheadSuspendThreshold/
 *  segmentAheadResumeThreshold (packages/shared/src/settings-registry.ts,
 *  Addendum A) — used as `reconcileThrottle`'s fallback when
 *  `ThrottleInputs.suspendAheadThreshold`/`resumeAheadThreshold` are
 *  omitted (every existing caller/test). docs/PLAYBACK.md §9 originally
 *  documented these as "MANDATORY ... not env-overridable" — the Addendum
 *  A registry decision supersedes that for THIS instance-configurability
 *  axis specifically (STATE.md is the authoritative record of the
 *  supersession; docs/PLAYBACK.md itself is out of this lane's edit scope
 *  — flagged in this lane's final report). */
export const THROTTLE_SUSPEND_AHEAD = 10;
export const THROTTLE_RESUME_AHEAD = 5;

export type ThrottleAction =
  | { kind: "none" }
  /** Issue SIGSTOP AND write status='suspended' + suspendedByThrottle=true
   *  — this session's own throttle newly kicking in. */
  | { kind: "suspend-for-throttle" }
  /** Issue SIGCONT AND write status='active' + suspendedByThrottle=false
   *  — this session's own throttle resuming (ahead dropped to <= 5). */
  | { kind: "resume-for-throttle" }
  /** Physical SIGSTOP only, no row write — the row is ALREADY
   *  status='suspended' for some other cause (heartbeat staleness); the
   *  process must still be stopped, but nothing about the row is this
   *  session's throttle to describe. */
  | { kind: "stop-process-only" }
  /** Row write only (status='suspended' + suspendedByThrottle=true), no
   *  new SIGSTOP — the process is ALREADY stopped (never resumed) but a
   *  heartbeat flipped the row back to 'active' out from under a
   *  still-too-far-ahead throttle; correct the row back rather than let a
   *  stopped process sit under an 'active' status. */
  | { kind: "rewrite-suspended-only" };

export interface ThrottleInputs {
  mechanism: ThrottleMechanism;
  /** Highest segment index produced across the SESSION's surviving
   *  segments (the served state's max, runner.ts's
   *  `highestProducedSegmentIndex` — NOT per-run); `undefined` if nothing
   *  has been produced yet (never throttles before any output). Session-
   *  wide is exactly why `currentRunStartSegment` below exists: after a
   *  restart this value still reflects the PREVIOUS run's tail. */
  producedSegment: number | undefined;
  /** The row's `requested_segment` — `null` (no request yet) is treated as
   *  0, never as "unbounded ahead is fine" (migrations/
   *  0012_transcode_sessions.sql's column comment). */
  requestedSegment: number | null;
  /** V8 (docs/PLAYBACK.md §9 throttle "Lead arithmetic"): the CURRENT
   *  run's `start_segment`, used as a floor under `requestedSegment`. A
   *  requested index below the current run's start is a numbering artifact
   *  of a pre-restart request — global numbering only moves forward, so
   *  after any restart (seek OR §9.1.4 handoff) the client's last
   *  requested index can sit far below the new run's start while the
   *  encoder has produced nothing. Read raw, that looks like a huge lead
   *  and SIGSTOPs the fresh run before its first segment, with resume
   *  arithmetically unreachable (QA 2026-08-12, "buffers forever").
   *  Omitted/0 preserves pre-V8 arithmetic exactly. */
  currentRunStartSegment?: number;
  /** The row's CURRENT `status` — this function is only ever meaningfully
   *  consulted while it is `'active'` or `'suspended'` (the runner's main
   *  loop handles starting/seeking transitions through dedicated code, not
   *  this reconciler) but accepts any value defensively. */
  rowStatus: "active" | "suspended" | string;
  suspendedByThrottle: boolean;
  /** The runtime's own tracked physical process state (there is no
   *  queryable "is this pid SIGSTOPped" API short of shelling out to `ps`
   *  — the runtime that ISSUES suspend()/resume() calls is the single
   *  source of truth for what it last told the process to do). */
  processStopped: boolean;
  /** transcode.segmentAheadSuspendThreshold (Addendum A registry) —
   *  defaults to THROTTLE_SUSPEND_AHEAD (10) when omitted. Resolved by the
   *  caller (runner.ts) ONCE per transcode session at session start (the
   *  natural "per transcode admission" boundary — see runner.ts's header)
   *  and passed in on every poll-tick call, so it never changes mid-poll
   *  for one session; a NEW session started after a settings change picks
   *  up the new value. */
  suspendAheadThreshold?: number;
  /** transcode.segmentAheadResumeThreshold — see suspendAheadThreshold's
   *  comment immediately above. Defaults to THROTTLE_RESUME_AHEAD (5). */
  resumeAheadThreshold?: number;
}

/**
 * Pure decision function — no I/O, no clock, matches this repo's
 * design-laws-as-property-tests spirit even outside packages/
 * playback-engine proper. See this module's header for the full
 * reasoning; the implementation below is a direct transcription of the
 * exhaustive case table described there.
 */
export function reconcileThrottle(input: ThrottleInputs): ThrottleAction {
  if (input.mechanism === "readrate") {
    // P3.8 win32 fallback structurally prevents racing ahead — never
    // suspends/resumes via this path (module header).
    return { kind: "none" };
  }

  const suspendAheadThreshold = input.suspendAheadThreshold ?? THROTTLE_SUSPEND_AHEAD;
  const resumeAheadThreshold = input.resumeAheadThreshold ?? THROTTLE_RESUME_AHEAD;
  // V8 floor: lead is measured against the CURRENT run, never against a
  // requested index that predates it (see currentRunStartSegment's doc
  // comment — the pre-restart numbering artifact, both seek and pure-switch
  // shapes).
  const requested = Math.max(input.requestedSegment ?? 0, input.currentRunStartSegment ?? 0);
  const ahead = input.producedSegment !== undefined ? input.producedSegment - requested : Number.NEGATIVE_INFINITY;

  if (!input.suspendedByThrottle) {
    if (ahead > suspendAheadThreshold && !input.processStopped) {
      return { kind: "suspend-for-throttle" };
    }
    if (input.rowStatus === "suspended" && !input.processStopped) {
      // Some other cause (heartbeat staleness) already marked the row
      // suspended; physically honor it without claiming the throttle flag.
      return { kind: "stop-process-only" };
    }
    if (input.rowStatus === "active" && input.processStopped) {
      // Defensive: process stopped but nothing (throttle nor row) wants it
      // stopped — resume physically, no row write needed (row already says
      // active).
      return { kind: "resume-for-throttle" };
    }
    return { kind: "none" };
  }

  // suspendedByThrottle === true: WE are the reason this is stopped.
  if (ahead <= resumeAheadThreshold) {
    return { kind: "resume-for-throttle" };
  }
  if (input.rowStatus === "active" && input.processStopped) {
    // A heartbeat resumed the ROW out from under a still-too-far-ahead
    // throttle (module header) — the process is unchanged (still stopped);
    // just correct the row back.
    return { kind: "rewrite-suspended-only" };
  }
  return { kind: "none" };
}
