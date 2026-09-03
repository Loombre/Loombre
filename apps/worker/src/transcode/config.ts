// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Config knobs for the transcode session runtime (docs/PLAYBACK.md §9,
 * Phase 3 §11 step 6a binding constraint 3). Every value has an
 * env-overridable default so a bare `pnpm dev`/`node dist/index.js` just
 * works, matching every other env convention in this repo
 * (LOOMBRE_FFMPEG/LOOMBRE_SCAN_CONCURRENCY/...).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Staging root all session directories live under
 *  (`<root>/<sessionId>`, binding constraint 3). Default:
 *  `os.tmpdir()/loombre-transcode` — an NVMe-backed tmpfs in a real
 *  deployment is a deployment/ops concern (docs/PLAYBACK.md §9's "NVNe path
 *  from config"), not something this default needs to guess at. */
export function resolveTranscodeStagingRoot(): string {
  const override = process.env["LOOMBRE_TRANSCODE_DIR"];
  if (override && override.length > 0) return override;
  return join(tmpdir(), "loombre-transcode");
}

/**
 * How many 'transcode' jobs THIS worker process runs concurrently
 * (pg-boss `work()` concurrency, packages/jobs). Deliberately generous by
 * default: real admission control is Lane B's semaphore + 429 at session
 * CREATE time (this step's binding constraint 8) — a session row/job is
 * only ever created after that gate passes, so the worker itself does not
 * need to re-enforce `maxSimultaneousTranscodes` a second time. This knob
 * exists purely so a single worker process doesn't accept an unbounded
 * pile of concurrent ffmpeg children if several are enqueued in a tight
 * window (e.g. a restart replaying a backlog).
 */
export function resolveTranscodeWorkerConcurrency(): number {
  const raw = process.env["LOOMBRE_TRANSCODE_WORKER_CONCURRENCY"];
  if (!raw) return 8;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
}

/** Poll interval for the worker's own per-session control loop (docs/
 *  PLAYBACK.md §9 / binding constraint 1: "polls its own sessions' rows at
 *  a short interval (<=1s)"). SPF-3b (2026-09-03) tightened the default
 *  from 250ms to 100ms: BOTH seek detection (how soon a written
 *  `seek_target_ms` is noticed) and the fold that publishes a run's FIRST
 *  segment (how soon `markSessionActive` fires once ffmpeg has one) ride
 *  this same tick, so shrinking it takes ~300ms of ticks-and-waiting off
 *  every hard-seek restart at the cost of one extra primary-key read per
 *  tick per active session — a Tier-0-cheap trade against a
 *  perceived-latency win. Still well inside the <=1s spec bound.
 *  Overridable for tests that want a tighter loop without waiting on the
 *  production default. */
export function resolveTranscodePollIntervalMs(): number {
  const raw = process.env["LOOMBRE_TRANSCODE_POLL_MS"];
  if (!raw) return 100;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1000 ? parsed : 100;
}

// Segment-ahead throttle thresholds used to live here as fixed constants
// (docs/PLAYBACK.md §9's original "ahead > 10 segments (60s), suspend ...
// resume at ahead <= 5", once documented as "not env-overridable").
// Addendum A (STATE.md) made them instance-configurable
// (transcode.segmentAheadSuspendThreshold/segmentAheadResumeThreshold,
// packages/shared/src/settings-registry.ts) — lane S3 removed the dead
// duplicate constants that used to live here (nothing imported them; the
// REAL, still-used defaults are throttle.ts's own THROTTLE_SUSPEND_AHEAD/
// THROTTLE_RESUME_AHEAD, which reconcileThrottle() falls back to when a
// caller omits the new per-session ThrottleInputs.suspendAheadThreshold/
// resumeAheadThreshold fields) so a future reader never finds two
// definitions of "the" threshold and wonders which one is real.

/**
 * d3-f3 (QA 2026-08-24, F/throttle-suspend-duration): the LONGEST a
 * segment-ahead throttle may leave an ffmpeg process group physically
 * SIGSTOPped before the runtime releases it (terminates it cleanly, to be
 * restarted at the §9.1.4 continuation origin when the viewer comes back).
 *
 * The throttle's resume condition is "the client's lead dropped to <= 5
 * segments", which for a PAUSED viewer never happens — so the stop lasted
 * as long as the pause did, minutes at a time. A stopped process still owns
 * every out-of-process resource it opened, and a VideoToolbox compression
 * session held that way is the leading suspected trigger for the encoder
 * death of browser-player-F2 (`kVTSessionMalfunctionErr`); the recovery
 * ladder added there handles the death but does not remove the trigger.
 *
 * Two minutes is deliberately WELL PAST any ordinary buffering pause (the
 * throttle only stops an encoder that is already >60 s ahead, so an
 * everyday pause-and-resume never reaches this at all) while keeping the
 * dangerous state — a stopped encoder holding a hardware session — down to
 * minutes rather than the whole heartbeat window. Releasing costs one
 * ordinary restart against a client that is holding ~60 s of buffer.
 */
export const THROTTLE_MAX_SUSPEND_MS = 120_000;

export function resolveTranscodeMaxSuspendMs(): number {
  const raw = process.env["LOOMBRE_TRANSCODE_MAX_SUSPEND_MS"];
  if (!raw) return THROTTLE_MAX_SUSPEND_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : THROTTLE_MAX_SUSPEND_MS;
}

/**
 * d3-f5 (QA 2026-08-24, verify-A): how long a RUNG-DRIVEN restart is
 * deferred after a SEEK restart of the same session.
 *
 * hls.js re-evaluates its ABR level the instant a seek empties the buffer,
 * and on a marginal link it flaps: one observed POST /seek spawned runs 7
 * (rung 1) and 8 (rung 0) 0.9s apart, and the session reached 23 runs —
 * 2-3 full ffmpeg restarts per seek, each killing the previous run before
 * it could produce anything, while the client 503'd on the abandoned run's
 * segments and eventually showed a false "Seek timed out" toast. A restart
 * is the most expensive thing this runtime does; paying it three times for
 * one intention is how a session produces nothing at all.
 *
 * Deferring is also what makes a flap FOLD rather than accumulate:
 * `requestRungSwitch` absorbs a switch naming the ACTIVE rung, and while
 * nothing restarts the active rung does not move — so 1 -> 0 -> 1 collapses
 * to the one pending value the cool-down finally consumes. Long enough to
 * cover an ABR settle, short enough that a deliberate quality pick right
 * after a seek still feels immediate; a seek arriving inside the window
 * still carries the pending rung into its own single restart (§9.1.7), so
 * nothing is ever merely postponed behind a queue.
 */
export const RUNG_SWITCH_SEEK_COOLDOWN_MS = 3_000;

export function resolveTranscodeRungSwitchCooldownMs(): number {
  const raw = process.env["LOOMBRE_TRANSCODE_RUNG_SWITCH_COOLDOWN_MS"];
  if (!raw) return RUNG_SWITCH_SEEK_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : RUNG_SWITCH_SEEK_COOLDOWN_MS;
}

/** Heartbeat thresholds (docs/PLAYBACK.md §9) — DOCUMENTATION ONLY, kept
 *  as the historical fixed numbers this step's spec named; the REAL
 *  effective values now live in packages/shared/src/settings-registry.ts's
 *  sessions.staleCutoffMs/sessions.heartbeatSuspendCutoffMs entries and are
 *  read by apps/server/src/playback/session-sweeper.service.ts (the
 *  SERVER-side sweeper — this worker package never reads them directly).
 *  An admin-configured override will NOT be reflected in these two
 *  constants; do not rely on them for anything but the historical default. */
export const HEARTBEAT_SUSPEND_AFTER_MS = 90_000;
export const HEARTBEAT_END_AFTER_MS = 15 * 60_000;

/** Segment retention window (docs/PLAYBACK.md §9: "segments beyond 120s
 *  behind the produced live edge are deleted"). */
export const SEGMENT_RETENTION_SEC = 120;

/**
 * d4-f1 (QA backlog #103): THE COPY-SHAPE PRODUCE-AHEAD CAP.
 *
 * Every other bound on how far production may run ahead of the viewer is
 * enforced by the runner's poll loop — the segment-ahead throttle SIGSTOPs
 * an encode more than `transcode.segmentAheadSuspendThreshold` segments
 * ahead. That is a bound with a 250ms granularity, and a run that FINISHES
 * inside one tick is never bounded by it at all. A copy shape does exactly
 * that: nothing is being video-encoded, so the remux is limited only by
 * disk throughput and reaches `#EXT-X-ENDLIST` on a whole feature in well
 * under a second (apps/worker/test/transcode/session.integration.spec.ts's
 * own header has said so since it was written). The entire file lands in
 * staging, and since d3-f1 floored retention on VIEWER EVIDENCE it stays
 * there until the viewer walks past it or the session is torn down — on a
 * tmpfs staging root, which is the deployment shape docs/PLAYBACK.md §9
 * recommends, that is the whole film in RAM.
 *
 * The only lever with sub-poll-interval granularity is inside ffmpeg, so
 * the cap is `-readrate` (args.ts's `injectReadrate`) — the same mechanism
 * P3.8 already applies unconditionally on win32, where this hazard
 * therefore never existed. `-readrate_initial_burst` is what makes it free:
 * the first `COPY_SHAPE_READRATE_BURST_SEC` of EACH RUN's own output are
 * produced at full speed, so startup, seek discovery (V8's 3s budget) and
 * post-restart buffer refill are untouched, and only the tail is paced.
 *
 * The burst is deliberately SEGMENT_RETENTION_SEC: staging then holds at
 * most one retention window ahead of the viewer plus one behind it —
 * ~240s of content, INDEPENDENT OF SOURCE SIZE, which is the property the
 * finding asks for. The multiplier is 4x realtime: comfortably faster than
 * any client consumes (so a viewer never waits on the cap) while making
 * the lead grow slowly enough that the ordinary throttle catches it at its
 * next tick, exactly as it does for a real transcode.
 *
 * Set `LOOMBRE_TRANSCODE_COPY_READRATE=0` to disable the cap entirely
 * (pre-d4-f1 behaviour) on a box with staging space to burn.
 */
export const COPY_SHAPE_READRATE = 4;
export const COPY_SHAPE_READRATE_BURST_SEC = SEGMENT_RETENTION_SEC;

export function resolveTranscodeCopyShapeReadrate(): number {
  const raw = process.env["LOOMBRE_TRANSCODE_COPY_READRATE"];
  if (!raw) return COPY_SHAPE_READRATE;
  const parsed = Number.parseFloat(raw);
  // >= 0 rather than > 0: zero is the documented "no cap" escape hatch.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : COPY_SHAPE_READRATE;
}

export function resolveTranscodeCopyShapeBurstSec(): number {
  const raw = process.env["LOOMBRE_TRANSCODE_COPY_READRATE_BURST_SEC"];
  if (!raw) return COPY_SHAPE_READRATE_BURST_SEC;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : COPY_SHAPE_READRATE_BURST_SEC;
}

/** `ServerPolicy.segmentDurationSec` is a fixed literal `2` in
 *  @loombre/playback-engine's own type (§2.4: "fixed v1") — this runtime
 *  substitutes `{SEG_DUR}` with this constant directly rather than
 *  threading a policy object through, since there is only ever one value
 *  it could be.
 *
 *  SPF-1: was 6. The first playable segment of every run needs a full
 *  segment of CONTENT encoded before ffmpeg closes it and writes the
 *  playlist entry (measured: Tier-0 model 1x software encoder 6.9 s at
 *  6 s segments -> 2.9 s at 2 s segments). The GOP is already 2 s
 *  (`-g 2*fps` in args.ts) so cutting segments at 2 s adds no extra
 *  keyframes -- it only shortens how much content each segment needs. */
export const SEGMENT_DURATION_SEC = 2;
