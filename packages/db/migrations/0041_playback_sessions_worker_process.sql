-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0041_playback_sessions_worker_process
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007/0010/0038's discipline):
-- two nullable columns and one partial index. No column drops, no type
-- narrowing, no rewriting of prior migrations, no contract surface — these
-- columns are worker-internal bookkeeping and are never serialized into an
-- API response (packages/db/src/query/playback-sessions.ts's
-- PlaybackSessionRow deliberately does not carry them).
--
-- WHY. Every transcode run's ffmpeg is spawned `detached: true` on POSIX
-- (apps/worker/src/transcode/process.ts) so suspend/resume/terminate can
-- signal the whole process group. The price of that is that the child does
-- NOT die with its worker. A GRACEFUL shutdown now kills its children
-- explicitly (apps/worker/src/transcode/run-registry.ts), but a hard kill
-- — SIGKILL, an OOM kill, a power cut — runs no code at all, and the
-- surviving ffmpeg then encodes at full rate forever: nothing is left to
-- throttle it (docs/PLAYBACK.md §9's ahead>10 SIGSTOP needs a supervisor),
-- to seek it, or to end it. Its admission slot, meanwhile, is freed the
-- moment the server's heartbeat sweeper ends the session
-- (countActiveTranscodeSessions counts only non-terminal rows), so the
-- next viewer is admitted on top of it. On Tier-0 hardware (N100/4GB,
-- docs/PLAN.md §9) two of those is the whole machine.
--
-- The next worker boot is the only remaining place to clean that up, and
-- the database row is the only thing that survived the crash — so the pid
-- has to be ON the row. apps/worker/src/transcode/reaper.ts reads these
-- two columns at boot, verifies the pid is BOTH alive AND actually this
-- session's ffmpeg (pid + cmdline against staging_dir — pids are reused,
-- and SIGKILLing an unrelated process would be a worse bug than the one
-- being fixed), SIGKILLs the process group if so, and fails the session.

ALTER TABLE playback_sessions
  ADD COLUMN worker_pid            INTEGER NULL,
  ADD COLUMN worker_started_at_ms  BIGINT NULL;

COMMENT ON COLUMN playback_sessions.worker_pid IS
  'OS process id of the ffmpeg run currently supervising this session, '
  'written by apps/worker/src/transcode/runner.ts at every spawn (initial '
  'run and every seek-restart, so it always names the LIVE process). '
  'NULL for a direct-play session, for a session whose pipeline never '
  'started, and for every row predating this migration. Read only by the '
  'boot-time orphan reaper (apps/worker/src/transcode/reaper.ts) — never '
  'by a request path, never serialized into an API response. A pid alone '
  'is not proof of identity (pids are reused): the reaper additionally '
  'verifies the process''s command line contains this row''s staging_dir '
  'before it is willing to signal anything.';

COMMENT ON COLUMN playback_sessions.worker_started_at_ms IS
  'Start time (epoch ms) of the WORKER PROCESS that spawned worker_pid — '
  'the generation marker, not the ffmpeg''s own start time. The shipped '
  'topology is one worker per database (every installer + '
  'docker-compose.prod.yml; packages/db/src/query/worker-liveness.ts '
  'embeds the same assumption), so any non-terminal session whose '
  'worker_started_at_ms predates the CURRENTLY booting worker was '
  'orphaned by a dead predecessor — even if its ffmpeg is still running '
  'happily, because the supervisor that could throttle, seek, or end it '
  'is gone. Same generation-horizon reasoning as jobs-ledger '
  'reconciliation''s activeStaleBeforeMs (packages/db/src/internal/'
  'jobs.ts).';

-- The reaper''s boot query, and nothing else, reads these columns. It is a
-- narrow slice of a table that grows without bound (one row per playback
-- session, ever), so it gets a partial index rather than a sequential scan
-- on a Tier-0 box''s boot path. `status` is enumerated inline instead of
-- using NOT IN so the predicate stays trivially matchable by the planner.
CREATE INDEX playback_sessions_reapable_idx
  ON playback_sessions (worker_started_at_ms)
  WHERE worker_pid IS NOT NULL
    AND status IN ('created', 'starting', 'active', 'suspended', 'seeking');
