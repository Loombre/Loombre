// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Segment-ahead throttle (docs/PLAYBACK.md §9 — MANDATORY: "ahead > 10
 * segments (60s) suspend encode ... resume at ahead <= 5", stated there in
 * the original 6 s-segment terms; SPF-1 re-bases the SECONDS meaning onto
 * 2 s segments, so the thresholds below read "ahead > 30 segments (60s)
 * ... resume at ahead <= 15 (30s)") and the P3.8 platform-mechanism
 * decision (this step's binding constraints 2 and 4).
 *
 * ---------------------------------------------------------------------------
 * MECHANISM DECISION (P3.8, STATE.md): POSIX (darwin/linux) uses REAL
 * SIGSTOP/SIGCONT on the ffmpeg process group (apps/worker/src/transcode/
 * process.ts) — verified in this step's integration tests via `ps` state +
 * `produced_segment` stalling. Windows has NO new native dependency
 * available for job-object-based suspension (this step's binding
 * constraint 4 tried the no-new-dependency route FIRST and that is as far
 * as it goes without one) — the documented P3.8 fallback is `-readrate`
 * pacing: `injectReadrate(args, 1.2, WIN32_READRATE_BURST_SEC)` (args.ts)
 * is applied to EVERY win32 ffmpeg run unconditionally, pacing the encode
 * at ~1.2x realtime so it structurally never races far enough ahead to
 * need suspending in the first place. SPF-2 (2026-09-03) added the burst:
 * the first `WIN32_READRATE_BURST_SEC` of EACH RUN's own output — which
 * covers the client's forward-buffer target — encode at full speed before
 * the 1.2x pacing engages, so a win32 seek-restart's first segment is no
 * longer paced at all (measured: 6.4s -> 0.3s to first segment on a
 * synthetic 1x-realtime source) while the steady-state lead bound is
 * exactly what it was before. Consequence, reported as a real behavioral
 * difference (not hidden): a win32 worker NEVER writes
 * `suspended_by_throttle = true` and
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
 *
 * ---------------------------------------------------------------------------
 * THE STOP IS BOUNDED IN TIME (d3-f3, QA 2026-08-24). Everything above
 * decides WHETHER the encoder should be stopped; nothing in it bounded HOW
 * LONG. For a paused viewer the resume condition (lead <= 15) never arrives,
 * so a stopped process stayed stopped for the whole pause — minutes — and a
 * stopped process still owns every out-of-process resource it opened. A
 * VideoToolbox compression session held that way is the leading suspected
 * trigger for browser-player-F2's `kVTSessionMalfunctionErr` death. So a
 * fourth dimension joins the table: once `stoppedForMs >= maxStoppedMs` the
 * process is RELEASED (`release-stopped-process` — terminate, no row write),
 * at most once, and the caller restarts the pipeline at the §9.1.4
 * continuation origin when the resume condition finally arrives. The
 * ordinary cycle is untouched: resume takes priority over release, so a
 * viewer returning inside the bound still gets a plain SIGCONT.
 */

export type ThrottleMechanism = "suspend" | "readrate";

/** Fallback pacing multiplier for the win32 `-readrate` mechanism (P3.8,
 *  this step's binding constraint 4, verbatim value). */
export const WIN32_READRATE_MULTIPLIER = 1.2;

/**
 * SPF-2: how many seconds of EACH win32 run's own output encode at full
 * speed (ffmpeg's `-readrate_initial_burst`, injected alongside the
 * multiplier above) before the 1.2x pacing engages at all. Sized to the
 * client's forward-buffer target (30s, apps/web's buffer-cap constant) —
 * a fresh start and every seek-restart fill that whole target at full
 * speed, then 1.2x pacing bounds the lead exactly as it did before this
 * existed. The head of every run is what a viewer is waiting on; the tail
 * is what the pacing exists to bound, and those are disjoint.
 */
export const WIN32_READRATE_BURST_SEC = 30;

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
/** 60 s at 2 s segments (SPF-1; was 10 segments = 60 s at the old 6 s
 *  segment size — the SECONDS meaning is preserved, not the count). */
export const THROTTLE_SUSPEND_AHEAD = 30;
/** 30 s at 2 s segments (SPF-1; was 5 segments = 30 s at the old 6 s
 *  segment size). */
export const THROTTLE_RESUME_AHEAD = 15;

export type ThrottleAction =
  | { kind: "none" }
  /** Issue SIGSTOP AND write status='suspended' + suspendedByThrottle=true
   *  — this session's own throttle newly kicking in. */
  | { kind: "suspend-for-throttle" }
  /** Issue SIGCONT AND write status='active' + suspendedByThrottle=false
   *  — this session's own throttle resuming (ahead dropped to <= 15). */
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
  | { kind: "rewrite-suspended-only" }
  /** d3-f3: TERMINATE the stopped process — it has now been SIGSTOPped for
   *  `maxStoppedMs` and a stop that long is itself a hazard (see
   *  `stoppedForMs` below). NO row write: the session stays suspended for
   *  whatever cause suspended it, and stays this throttle's to resume; only
   *  the physical encoder goes away. Everything it already produced remains
   *  on disk and in the served playlist, and the caller restarts the
   *  pipeline at the §9.1.4 continuation origin when the resume condition
   *  finally arrives. Issued at most once per stopped run
   *  (`processReleased`). */
  | { kind: "release-stopped-process" };

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
   *  defaults to THROTTLE_SUSPEND_AHEAD (30) when omitted. Resolved by the
   *  caller (runner.ts) ONCE per transcode session at session start (the
   *  natural "per transcode admission" boundary — see runner.ts's header)
   *  and passed in on every poll-tick call, so it never changes mid-poll
   *  for one session; a NEW session started after a settings change picks
   *  up the new value. */
  suspendAheadThreshold?: number;
  /** transcode.segmentAheadResumeThreshold — see suspendAheadThreshold's
   *  comment immediately above. Defaults to THROTTLE_RESUME_AHEAD (15). */
  resumeAheadThreshold?: number;
  /** d3-f3: how long the process has been PHYSICALLY stopped, in ms
   *  (`undefined`/0 when it is running or the caller does not track it).
   *  The clock is an argument here for the same reason it is everywhere
   *  else in this repo: this function stays pure and the whole rule is
   *  testable as a table. */
  stoppedForMs?: number;
  /** d3-f3: the bound on `stoppedForMs` — past it the stopped process is
   *  released rather than left SIGSTOPped (config.ts's
   *  THROTTLE_MAX_SUSPEND_MS; runner.ts resolves it once per session).
   *  OMITTED MEANS UNBOUNDED, i.e. exactly the pre-d3-f3 behaviour — a
   *  caller that does not track stop duration cannot accidentally opt into
   *  a bound it has no clock for. */
  maxStoppedMs?: number;
  /** d3-f3: this stopped process has already been released — the action is
   *  issued at most once per run, and the run then sits terminated (but
   *  still 'stopped' as far as this reconciler is concerned: nothing is
   *  producing) until the resume condition arrives. */
  processReleased?: boolean;
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
  // d3-f3: a SIGSTOP is bounded in TIME, independently of what caused it —
  // the hazard is the physically stopped process holding an out-of-process
  // encode session, and a heartbeat-cause stop holds one exactly as long as
  // a throttle-cause stop does. `maxStoppedMs` omitted = unbounded (see its
  // doc comment), which is why every pre-d3-f3 caller/table case is
  // unaffected.
  const stoppedTooLong =
    input.processStopped &&
    input.processReleased !== true &&
    input.maxStoppedMs !== undefined &&
    (input.stoppedForMs ?? 0) >= input.maxStoppedMs;

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
    // Row-caused stop (heartbeat staleness) that has now lasted too long:
    // the row keeps saying 'suspended' — nothing here disputes that — but
    // the encoder itself does not get to sit stopped for it (d3-f3).
    if (stoppedTooLong) {
      return { kind: "release-stopped-process" };
    }
    return { kind: "none" };
  }

  // suspendedByThrottle === true: WE are the reason this is stopped.
  if (ahead <= resumeAheadThreshold) {
    // Resume WINS over release: a viewer who comes back inside the bound
    // gets their still-live encoder SIGCONTed, with no restart at all.
    return { kind: "resume-for-throttle" };
  }
  if (stoppedTooLong) {
    return { kind: "release-stopped-process" };
  }
  if (input.rowStatus === "active" && input.processStopped) {
    // A heartbeat resumed the ROW out from under a still-too-far-ahead
    // throttle (module header) — the process is unchanged (still stopped);
    // just correct the row back.
    return { kind: "rewrite-suspended-only" };
  }
  return { kind: "none" };
}
