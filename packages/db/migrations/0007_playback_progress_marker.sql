-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0007_playback_progress_marker
--
-- Additive-only (mirrors 0002/0003/0004/0006's discipline): no column
-- drops, no type narrowing, no rewriting of prior migrations.
--
-- STATE.md P2.8/deliverable-E (websocket-presence lane): the heartbeat path
-- (PUT /progress/{itemId} with a sessionId, docs/PLAYBACK.md §9) must emit
-- `playback.progress` AT MOST ONCE PER 30s PER SESSION (plan §6.3 — "never
-- row-per-tick"), but heartbeats themselves can arrive far more often than
-- that. `last_heartbeat_ms` is unsuitable as the throttle marker because it
-- is overwritten on EVERY heartbeat call regardless of whether an event was
-- emitted — comparing consecutive heartbeats' deltas would never
-- accumulate to the 30s threshold if the client heartbeats more frequently
-- than that. A dedicated marker, updated ONLY when a `playback.progress`
-- event is actually written, is required.

ALTER TABLE playback_sessions ADD COLUMN last_progress_event_at_ms BIGINT NULL;

COMMENT ON COLUMN playback_sessions.last_progress_event_at_ms IS
  'Set to the heartbeat''s nowMs whenever heartbeatPlaybackSession actually '
  'emits a playback.progress outbox event (packages/db/src/query/'
  'playback-sessions.ts) — NOT bumped on every heartbeat, only on ones that '
  'clear the >=30s-since-last-emission throttle. NULL until the first '
  'progress event for this session.';
