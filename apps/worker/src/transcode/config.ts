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
 *  a short interval (<=1s)"). 250ms keeps throttle/seek reactions snappy
 *  well inside that bound while staying cheap (one row read + a directory
 *  scan per tick, per active session). Overridable for tests that want a
 *  tighter loop without waiting on the production default. */
export function resolveTranscodePollIntervalMs(): number {
  const raw = process.env["LOOMBRE_TRANSCODE_POLL_MS"];
  if (!raw) return 250;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1000 ? parsed : 250;
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

/** `ServerPolicy.segmentDurationSec` is a fixed literal `6` in
 *  @loombre/playback-engine's own type (§2.4: "fixed v1") — this runtime
 *  substitutes `{SEG_DUR}` with this constant directly rather than
 *  threading a policy object through, since there is only ever one value
 *  it could be. */
export const SEGMENT_DURATION_SEC = 6;
