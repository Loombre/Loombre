-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0006_playback_sessions
--
-- Additive-only (mirrors 0002/0003/0004's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md P2.14 audit mismatch: the contract's PlaybackSession schema
-- already exposes status/errorCode, and Progress already exposes
-- durationMs, but neither had a backing column. Migration slot per P2.15
-- (0005 is reserved for images.dominant_color on a concurrent lane; this
-- lane's slot is 0006 regardless of landing order).

CREATE TYPE playback_session_status AS ENUM ('created', 'active', 'ended', 'failed');

ALTER TABLE playback_sessions ADD COLUMN status playback_session_status NOT NULL DEFAULT 'created';
ALTER TABLE playback_sessions ADD COLUMN error_code TEXT NULL;
ALTER TABLE playback_sessions ADD COLUMN updated_at_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE playback_sessions ADD COLUMN last_heartbeat_ms BIGINT NULL;

-- Backfill for any pre-existing rows (none expected pre-Phase-2, but an
-- additive migration must never leave a NOT NULL column's real value
-- hidden behind a placeholder DEFAULT) then drop the temporary default so
-- every future insert must supply it explicitly, mirroring every other
-- `_ms` column in this schema (e.g. progress.updated_at_ms).
UPDATE playback_sessions SET updated_at_ms = started_at_ms WHERE updated_at_ms = 0;
ALTER TABLE playback_sessions ALTER COLUMN updated_at_ms DROP DEFAULT;

COMMENT ON COLUMN playback_sessions.status IS
  'Session lifecycle state (docs/PLAYBACK.md §9). Phase 2 (direct-play only) '
  'only ever sets created/active/ended/failed; the contract''s wider '
  'PlaybackSessionStatus enum (+starting/suspended/seeking) is reserved for '
  'the Phase 3 HLS session state machine and intentionally not a value this '
  'column''s type admits yet.';

COMMENT ON COLUMN playback_sessions.error_code IS
  'Set when status = ''failed'' (e.g. the heartbeat-timeout sweeper, '
  'docs/PLAYBACK.md §9). NULL otherwise.';

COMMENT ON COLUMN playback_sessions.updated_at_ms IS
  'Bumped on every state transition (heartbeat, end/fail) — separate from '
  'started_at_ms, which never changes after creation.';

COMMENT ON COLUMN playback_sessions.last_heartbeat_ms IS
  'Set by PUT /progress/{itemId} when the request body carries this '
  'session''s id (P2.14/P2.18 heartbeat). NULL until the first heartbeat; '
  'the sweeper falls back to started_at_ms when NULL (docs/PLAYBACK.md §9, '
  '15-minute no-heartbeat cutoff).';

CREATE INDEX playback_sessions_active_idx ON playback_sessions (status)
  WHERE status IN ('created', 'active');

ALTER TABLE progress ADD COLUMN duration_ms BIGINT NULL;

COMMENT ON COLUMN progress.duration_ms IS
  'Snapshot of the played file''s duration at the time of the last '
  'progress write (contract Progress.durationMs) — client-supplied via '
  'ProgressUpdate, not independently probed by this table.';
