-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0012_transcode_sessions
--
-- Additive-only (mirrors 0002/.../0011's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- docs/PLAYBACK.md §9, Phase 3 §11 step 6a (worker-side transcode session
-- runtime). This migration is the shared substrate for BOTH lanes of step
-- 6: lane A (this one — apps/worker/src/transcode/**, the pipeline
-- supervisor) and lane B (apps/server, HTTP endpoints + admission, landing
-- after this one) drive the same rows.
--
-- ---------------------------------------------------------------------------
-- EXISTING-COLUMN AUDIT (performed before writing this file, reported per
-- this step's instructions):
--   - id/user_id/device_id/file_id/plan/engine_version/started_at_ms/
--     ended_at_ms: migrations/0001_init.sql. `plan` JSONB already exists —
--     P2.4's "verify the column exists" is CONFIRMED, no action needed. The
--     stored plan is Phase 2's `{decision:'direct-play', ...}` shape today;
--     lane B's session-create path is what will start storing a REAL
--     PlaybackPlan there. See this migration's trailing comment block for a
--     documented ADDITIONAL requirement this lane places on that JSONB
--     payload (a `selection` sidecar key) — no schema change needed for
--     that, JSONB already whitelisted for serialized plans (CLAUDE.md
--     invariant 3), just a payload-shape contract lane B must honor.
--   - status/error_code/updated_at_ms/last_heartbeat_ms:
--     migrations/0006_playback_sessions.sql. The `playback_session_status`
--     enum there is Phase-2-narrow (created/active/ended/failed) BY
--     COMMENT, explicitly reserving the contract's wider
--     {starting,suspended,seeking} for this phase — this migration adds
--     exactly those three, in the SAME order the contract's
--     PlaybackSessionStatus enum lists them (packages/contract/openapi.yaml:
--     created, starting, active, suspended, seeking, ended, failed).
--   - last_progress_event_at_ms: migrations/0007 — unrelated throttle
--     marker for the heartbeat->event path, untouched here.
--   - Audit CONCLUSION (the delta this migration adds): nothing above
--     covers (a) where the session's ffmpeg pipeline runs on disk, (b) the
--     server<->worker control channel's THREE signal columns (requested
--     segment, seek target, and the worker's own produced-segment
--     observability counter), (c) discontinuity bookkeeping for the served
--     playlist, (d) which of the two possible causes put a session into
--     'suspended' (server heartbeat-staleness vs worker throttle), (e)
--     failure diagnostics (stderr tail). All seven are net-new columns
--     below. Every one is NULLable (or DEFAULTed to an inert value) with NO
--     backfill needed — direct-play sessions (Phase 2's whole session
--     population) never touch any of them, so there is no pre-existing row
--     whose "real value" would otherwise hide behind a placeholder.
--
-- ---------------------------------------------------------------------------
-- OWNERSHIP (the worker<->server seam this migration encodes — see also the
-- verbatim module-header contract in apps/worker/src/transcode/index.ts (module header)
-- for the full write-path narrative; this comment is the SQL-level summary):
--
--   staging_dir            worker-written (set once, at session start)
--   requested_segment      server-written (Lane B; throttle input)
--   produced_segment       worker-written (throttle input + first-segment
--                          observability for Lane B's blocking playlist GET)
--   seek_target_ms         server-written (Lane B, on an outside-produced-
--                          range seek); worker NULLS it in the SAME
--                          transaction that bumps discontinuity_count and
--                          begins the restart — "consumed" atomically, never
--                          left dangling for a second restart to re-trigger
--   discontinuity_count    worker-written (incremented exactly once per
--                          seek-restart, in the seek-consuming transaction)
--   suspended_by_throttle  worker-written (true exactly while `status =
--                          'suspended'` for THIS session's OWN segment-ahead
--                          throttle decision; false — including while
--                          `status = 'suspended'` for a heartbeat-staleness
--                          cause the (future) extended sweeper writes — see
--                          the disambiguation note below)
--   stderr_tail            worker-written (only on a worker-detected ffmpeg
--                          failure; last 4 KB ring, docs/PLAYBACK.md §9)
--
--   `status = 'suspended'` has TWO possible causes sharing one enum value
--   (the contract's PlaybackSessionStatus has no room for a second axis):
--   this session's own segment-ahead throttle (worker-authored,
--   suspended_by_throttle = true) OR a stale-heartbeat suspend the extended
--   sweeper will write (server-authored, suspended_by_throttle = false).
--   `suspended_by_throttle` is precisely that disambiguator, and it is what
--   lets the worker's poll loop reconcile the two independent causes
--   correctly on resume (see apps/worker/src/transcode/throttle.ts's header
--   for the exact reconciliation table) without a second status-like
--   column.

ALTER TYPE playback_session_status ADD VALUE 'starting' AFTER 'created';
ALTER TYPE playback_session_status ADD VALUE 'suspended' AFTER 'active';
ALTER TYPE playback_session_status ADD VALUE 'seeking' AFTER 'suspended';

ALTER TABLE playback_sessions ADD COLUMN staging_dir TEXT NULL;
ALTER TABLE playback_sessions ADD COLUMN requested_segment INT NULL;
ALTER TABLE playback_sessions ADD COLUMN produced_segment INT NULL;
ALTER TABLE playback_sessions ADD COLUMN seek_target_ms BIGINT NULL;
ALTER TABLE playback_sessions ADD COLUMN discontinuity_count INT NOT NULL DEFAULT 0;
ALTER TABLE playback_sessions ADD COLUMN suspended_by_throttle BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE playback_sessions ADD COLUMN stderr_tail TEXT NULL;

COMMENT ON COLUMN playback_sessions.staging_dir IS
  'Absolute path of this session''s private working directory under the '
  'LOOMBRE_TRANSCODE_DIR staging root (apps/worker/src/transcode/staging.ts), '
  'e.g. "<root>/<sessionId>". NULL until the worker''s "starting" transition '
  'creates it; NULL forever for direct-play sessions. Deleted (guarded: '
  'refuses to remove anything outside the staging root) on end/fail.';

COMMENT ON COLUMN playback_sessions.requested_segment IS
  'Server-written (Lane B): the highest HLS segment index the client has '
  'actually requested so far (0-based, matching the {START_SEG} numbering '
  'space). Worker throttle input (docs/PLAYBACK.md §9) — NULL is treated '
  'as 0 (no request yet) by the worker''s throttle math, never as '
  '"unbounded ahead is fine".';

COMMENT ON COLUMN playback_sessions.produced_segment IS
  'Worker-written: the highest HLS segment index this session''s CURRENT '
  'ffmpeg run has finished writing (0-based, matching {START_SEG} — the '
  'index is already globally continuous across seek-restarts because '
  '{START_SEG} continues the numbering, so no run-relative offset is '
  'needed). NULL means no segment has been produced yet since the last '
  '(re)start — Lane B''s first-playlist-request block polls for this '
  'flipping non-NULL as the "init + first segment produced" observable '
  '(docs/PLAYBACK.md §9), rather than touching the filesystem itself.';

COMMENT ON COLUMN playback_sessions.seek_target_ms IS
  'Server-written (Lane B): set when a client requests a playhead position '
  'outside this session''s currently-produced segment range. The worker '
  'consumes it (reads + sets back to NULL) in the SAME transaction that '
  'starts the seek-restart (discontinuity_count += 1) — so a seek target '
  'is atomically "claimed" exactly once, never double-restarted by two '
  'poll ticks racing. Precision: milliseconds in, {SEEK_SECONDS} out is '
  'this value / 1000 (seconds, up to millisecond precision passed straight '
  'through to ffmpeg''s -ss, e.g. 12345 -> "12.345").';

COMMENT ON COLUMN playback_sessions.discontinuity_count IS
  'Worker-written: number of seek-restarts this session has undergone. '
  'Bumped exactly once per restart in the seek_target_ms-consuming '
  'transaction. Lane B''s served-playlist reader can use this purely as a '
  'diagnostic counter; the actual #EXT-X-DISCONTINUITY tags live in the '
  'worker-maintained media.m3u8 wrapper file on disk (docs/PLAYBACK.md §9 — '
  'see apps/worker/src/transcode/playlist.ts), not reconstructed from this '
  'number.';

COMMENT ON COLUMN playback_sessions.suspended_by_throttle IS
  'Worker-written: true exactly while `status = ''suspended''` is THIS '
  'session''s own segment-ahead throttle decision (docs/PLAYBACK.md §9 — '
  'ahead > 10 segments suspends, ahead <= 5 resumes); false at every other '
  'time, INCLUDING while `status = ''suspended''` for a heartbeat-staleness '
  'cause a future extended sweeper may write. Disambiguates the two causes '
  'that share the one `suspended` status value — see this migration''s '
  'header comment.';

COMMENT ON COLUMN playback_sessions.stderr_tail IS
  'Worker-written: the last 4 KB (ring buffer) of this session''s ffmpeg '
  'stderr, captured only when the pipeline exits non-zero for a reason the '
  'worker did not itself cause (docs/PLAYBACK.md §9 audit requirement). '
  'NULL for every session that never failed, and for direct-play sessions.';
