// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ═══════════════════════════════════════════════════════════════════════
 * Loombre :: apps/worker/src/transcode — the HLS transcode session runtime
 * (docs/PLAYBACK.md §9, Phase 3 §11 step 6, LANE A of two).
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This is the WORKER-SIDE half. Lane B (apps/server: HTTP endpoints,
 * admission control, contract wiring) lands after this and drives
 * everything below EXCLUSIVELY through (1) writing/reading
 * `playback_sessions` rows and (2) enqueueing a `'transcode'` job
 * (packages/jobs) — there is NO other channel between the two lanes, no
 * new IPC, no shared in-memory state, no direct function calls across the
 * apps/server <-> apps/worker process boundary. Read this header
 * end-to-end before wiring Lane B; it is the authoritative seam contract.
 *
 * ---------------------------------------------------------------------------
 * 1. STARTING A SESSION (Lane B's job, this lane just reacts)
 * ---------------------------------------------------------------------------
 * Lane B: (a) runs admission control (semaphore + 429
 * `transcode-slots-exhausted` — this step's binding constraint 8, entirely
 * Lane B's), (b) calls `@loombre/playback-engine`'s `plan()`, (c) inserts a
 * `playback_sessions` row with `status = 'created'` and
 * `plan = { ...planResult, selection }` — **the `selection` sidecar key is
 * REQUIRED, not part of the engine's own §5 output** (see
 * plan-shape.ts's header for exactly why: this runtime's seek-restart path
 * needs the original §2.6 TrackSelection back and has no other way to
 * reconstruct it), (d) enqueues `queue.enqueue('transcode', { sessionId })`.
 *
 * This runtime then: reads the row, resolves the media file's path
 * (`media_files.path` via `file_id`) and ffmpeg (`LOOMBRE_FFMPEG`/PATH,
 * `apps/worker/src/probe/ffprobe.ts`'s `resolveFfmpeg`), creates
 * `<LOOMBRE_TRANSCODE_DIR>/<sessionId>` (config.ts/staging.ts), transitions
 * `created -> starting`, substitutes the closed five-token set
 * (docs/PLAYBACK.md §6) into the STORED `plan.ffmpegArgs` (already fully
 * built by `plan()` — this lane never re-derives ffmpeg flags, only
 * substitutes tokens into what the pure engine already produced), and
 * spawns ffmpeg for "run 0" into `<sessionDir>/run0/`.
 *
 * OBSERVABILITY (this step's own instruction: "make init + first segment
 * produced OBSERVABLE" for Lane B's <=8s first-playlist-request block,
 * docs/PLAYBACK.md §9): the moment this runtime's poll loop sees the
 * run's own ffmpeg-written playlist contain its first segment, it writes
 * `status = 'active'` AND `produced_segment = <that index>` in the SAME
 * update. **Lane B's blocking-GET handler should poll the row for exactly
 * `status = 'active' AND produced_segment IS NOT NULL`** — never touch
 * the filesystem itself; this runtime owns every file under `staging_dir`.
 *
 * ---------------------------------------------------------------------------
 * 2. THE CONTROL CHANNEL — column ownership (THE seam)
 * ---------------------------------------------------------------------------
 * Every column below is `playback_sessions` (migrations/
 * 0012_transcode_sessions.sql has the SQL-level version of this same
 * table; this is the narrative version with the WHY attached).
 *
 *   staging_dir            WORKER writes once (session start). Lane B:
 *                           read-only (useful for ops/debugging only —
 *                           Lane B should never need to touch the
 *                           filesystem to serve a request; see §4 below
 *                           for how it serves files instead).
 *   requested_segment       LANE B writes, on EVERY segment/playlist GET
 *                           the client makes ("the highest segment index
 *                           actually requested so far" —
 *                           packages/db/src/query/playback-sessions.ts's
 *                           `updateRequestedSegment(db, ctx, id, n, now)`,
 *                           already implemented by this lane for Lane B to
 *                           call). WORKER reads it every poll tick as
 *                           throttle input; NULL is treated as 0, never as
 *                           "no limit". DEMAND, not progress — see the
 *                           column below.
 *   highest_served_segment  LANE B writes, ONLY when a segment GET is
 *                           answered 200 with a real file body, under a
 *                           SQL-side GREATEST (migration 0045 / d4-f2 —
 *                           `recordServedSegment`). WORKER reads it every
 *                           poll tick as the RETENTION PRUNE FLOOR (d3-f1:
 *                           never delete a segment the viewer has not
 *                           reached). It is a separate column from
 *                           `requested_segment` because the two consumers
 *                           want opposite things: the throttle must react
 *                           to a far-ahead request (that IS the signal to
 *                           un-suspend), retention must not (nobody has
 *                           been handed those bytes). NULL means "never
 *                           served a segment", and prunes NOTHING.
 *   produced_segment         WORKER writes (§1's observability + ongoing
 *                           throttle input). Lane B: read-only.
 *   seek_target_ms           LANE B writes when a client's requested
 *                           playhead position falls OUTSIDE the currently
 *                           produced segment range — Lane B decides
 *                           "outside" using `produced_segment` (already
 *                           readable) and the fixed `segmentDurationSec`
 *                           (2s, SPF-1) it already has from policy;
 *                           `packages/db/src/query/playback-sessions.ts`'s
 *                           `requestSeek(db, ctx, id, seekTargetMs, now)`
 *                           is already implemented for Lane B to call.
 *                           Milliseconds in. WORKER consumes (reads +
 *                           NULLS) it ATOMICALLY, in the same transaction
 *                           that bumps `discontinuity_count` and flips
 *                           `status -> 'seeking'` — a seek target is
 *                           claimed exactly once no matter how either
 *                           side's polling is timed.
 *   discontinuity_count     WORKER writes (bumped once per seek-restart).
 *                           Lane B: diagnostic read-only — the actual
 *                           `#EXT-X-DISCONTINUITY` tags live in the served
 *                           `media.m3u8` file this runtime maintains, not
 *                           reconstructed from this counter.
 *   suspended_by_throttle   WORKER writes EXCLUSIVELY. Lane B must NEVER
 *                           set this true. See §3.
 *   stderr_tail             WORKER writes, only on a worker-detected
 *                           ffmpeg failure (§5).
 *   status                  BOTH sides write, to DIFFERENT values — this
 *                           is the one column with two writers, and it is
 *                           safe ONLY because the two sides' write sets
 *                           are disjoint:
 *                             WORKER writes: starting, active (from
 *                             starting/seeking), suspended (throttle
 *                             cause, suspended_by_throttle=true), seeking,
 *                             failed.
 *                             LANE B writes: created (initial insert),
 *                             ended (its DELETE endpoint, or its EXISTING
 *                             15-min sweeper — extend it, per §6 below, to
 *                             also cover starting/suspended/seeking, which
 *                             this lane already made query-layer-ready via
 *                             the widened `listStalePlaybackSessions`
 *                             filter), and — THE ONE OVERLAP —
 *                             `suspended` for a HEARTBEAT-STALENESS cause
 *                             (90s no heartbeat, docs/PLAYBACK.md §9),
 *                             always with `suspended_by_throttle = false`
 *                             (this lane implemented
 *                             `listHeartbeatStalePlaybackSessions` +
 *                             `suspendStalePlaybackSession` in
 *                             packages/db/src/query/playback-sessions.ts
 *                             for exactly this — Lane B's sweeper extension
 *                             just needs to call them on a ~30-60s tick).
 *                           The worker's poll loop reconciles the shared
 *                           `suspended` value correctly regardless of which
 *                           side wrote it last — see throttle.ts's header
 *                           for the exhaustive case table. Nothing about
 *                           this requires the two sides to coordinate
 *                           beyond "read column, react" — that IS the
 *                           whole point of a DB-row control channel.
 *
 * ---------------------------------------------------------------------------
 * 3. THROTTLE (docs/PLAYBACK.md §9, mandatory)
 * ---------------------------------------------------------------------------
 * Every poll tick (<=1s, config.ts defaults to 250ms) while `status` is
 * `active`/`suspended`: `ahead = produced_segment - (requested_segment ??
 * 0)`. `ahead > 10` -> SIGSTOP the ffmpeg process group + write
 * `suspended`/`suspended_by_throttle=true`. `ahead <= 5` -> SIGCONT +
 * write `active`/`suspended_by_throttle=false`. POSIX
 * (darwin/linux): real SIGSTOP/SIGCONT (process.ts), integration-verified
 * via `ps` state + `produced_segment` stalling. Windows: NO new native
 * dependency was introduced (this step's binding constraint 4 tried the
 * no-new-dep route first and stopped there) — the P3.8 documented fallback
 * is `-readrate 1.2` pacing applied to every win32 ffmpeg run
 * unconditionally (throttle.ts/args.ts), which structurally prevents
 * racing far enough ahead to need suspending; a win32 worker therefore
 * never SIGSTOPs anything and never sets `suspended_by_throttle = true` —
 * see throttle.ts's header for exactly how a future native suspension
 * helper would slot in without touching the reconciliation table.
 *
 * ---------------------------------------------------------------------------
 * 4. SERVING FILES (entirely Lane B — this lane defines the ON-DISK LAYOUT
 * Lane B's file-serving handler must resolve requests against)
 * ---------------------------------------------------------------------------
 * `<staging_dir>/media.m3u8` — the ONE playlist Lane B serves for this
 * session (this runtime maintains it; ffmpeg never writes to this exact
 * path — see playlist.ts's header). Its segment/init URIs are
 * RUN-RELATIVE, e.g. `run0/s000000.m4s`, `run0/init.mp4`, and (after a
 * seek) `run1/s000043.m4s` with an `#EXT-X-DISCONTINUITY` immediately
 * before the first `run1` entry. Lane B's GET handler for a segment/init
 * request therefore just needs `path.join(staging_dir, requestedRelativePath)`
 * — GUARDED exactly like this lane's own `staging.ts` guards session-dir
 * deletion (resolve + verify strictly under `staging_dir`, refuse
 * otherwise; never trust a client-supplied relative path blindly). Lane B
 * should call `updateRequestedSegment` (already implemented, §2) on every
 * segment GET so this runtime's throttle has real input.
 *
 * ---------------------------------------------------------------------------
 * 5. FAILURE + TEARDOWN
 * ---------------------------------------------------------------------------
 * A worker-detected ffmpeg failure (non-zero exit NOT caused by this
 * runtime's own `terminate()` call) writes `status='failed'`,
 * `error_code='transcode-failed'`, `stderr_tail` (last 4 KB), emits
 * `playback.ended` itself (nobody else would for a worker-detected
 * failure), then deletes `staging_dir`. A session ending via ANY OTHER
 * path (Lane B's DELETE endpoint, or its sweeper — both already emit
 * `playback.ended` themselves via `endPlaybackSession`/
 * `endStalePlaybackSession`, UNCHANGED by this lane) is picked up by this
 * runtime's poll loop noticing `status IN ('ended','failed')`: it kills
 * the ffmpeg process and deletes `staging_dir` WITHOUT writing anything
 * to the row or emitting any event — the event was already emitted by
 * whoever changed the status. **`playback.ended` is therefore never
 * double-emitted for one session**: exactly one of {this runtime's own
 * failure path, Lane B's DELETE, Lane B's sweeper} ever transitions a
 * given session out of its non-terminal states, and only that one path
 * writes the event.
 *
 * ---------------------------------------------------------------------------
 * Module map: config.ts (env knobs) · staging.ts (guarded directory
 * lifecycle) · process.ts (ffmpeg spawn/suspend/resume/kill) · args.ts
 * (token substitution + P3.8 readrate injection) · playlist.ts (per-run
 * playlist parsing + served-wrapper rendering + retention pruning) ·
 * throttle.ts (pure suspend/resume decision table) · plan-shape.ts
 * (parses the stored plan JSONB, incl. the `selection` sidecar
 * requirement) · rebuild-args.ts (seek-restart arg regeneration via
 * `buildFfmpegArgs`) · runner.ts (the state machine wiring all of the
 * above together) · consumer.ts (the `queue.work('transcode', ...)` entry
 * point wired into apps/worker/src/index.ts).
 */

export { createTranscodeConsumerHandler } from "./consumer.js";
export { runTranscodeSession, type RunSessionDeps } from "./runner.js";
export {
  activeTranscodeRunCount,
  registerTranscodeRun,
  terminateAllTranscodeRuns,
  type TerminableRun,
} from "./run-registry.js";
export {
  createProcessInspector,
  reapOrphanedTranscodeSessions,
  type ProcessInspection,
  type ProcessInspector,
  type ReapableSession,
  type ReapedSession,
  type ReapOutcome,
} from "./reaper.js";
export {
  resolveTranscodeStagingRoot,
  resolveTranscodeWorkerConcurrency,
  resolveTranscodePollIntervalMs,
} from "./config.js";
