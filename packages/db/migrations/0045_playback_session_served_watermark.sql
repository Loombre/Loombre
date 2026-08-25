-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0045_playback_session_served_watermark
--
-- Additive-only (mirrors 0002/.../0044's discipline): one new nullable
-- column, no drops, no type narrowing, no rewriting of prior migrations,
-- no contract surface.
--
-- WHY (QA backlog #104, d4-f2). Migration 0012 gave the worker/server seam
-- one column for "where is the client": `requested_segment`, written by
-- apps/server on EVERY segment GET. That is the right input for the
-- segment-ahead throttle — a request is DEMAND, and demand is exactly what
-- should un-throttle a stopped encoder, whether or not it can be answered.
-- It is the wrong input for the two consumers that ask a DIFFERENT
-- question: "how far has this client actually got?"
--
--   * apps/server's backward-jump gate (hls-file.controller.ts, gap-F6
--     round 3 / d3-f2) treats an ENOENT index far below the session's
--     progression as a real backward seek. Because `requested_segment`
--     records 503'd and speculative far-ahead requests verbatim, a routine
--     forward probe inside the live window raised the baseline, and the
--     client's OWN next fragment — pruned out from under it — then read as
--     a backward jump and restarted the run. The same column also PINS
--     itself: a 503 writes the index it just refused, so a retry sits
--     inside the backward-jump hysteresis of itself.
--   * apps/worker's retention prune floor (d3-f1: never delete a segment
--     the viewer has not reached) had to reconstruct progression from the
--     same column, and could only approximate it — "trust it while it is
--     at or below the produced edge" — which still let a speculative index
--     that happened to be below the produced edge authorise deleting
--     everything under it.
--
-- WHAT THIS COLUMN IS. The highest segment index this session has ever
-- actually SERVED to the client, i.e. answered with a 200 and a real file
-- body. Monotonic by construction (the write is a GREATEST), server-written
-- on the success path only, worker-read. NULL means "this session has never
-- served a segment", which is a real and common state (a client that has
-- only ever 503'd), never "index 0".
--
-- WHY NOT REUSE `requested_segment`. The two columns answer different
-- questions and both answers are needed at once: the throttle must see a
-- far-ahead request (it is the signal that the client wants more), while
-- retention and the seek gate must not. Narrowing `requested_segment` to
-- 200s would silently break the throttle's un-suspend path (docs/
-- PLAYBACK.md §9 "Lead arithmetic"); widening the prune floor to demand
-- would reopen d3-f1. Two columns, two write rules, both cheap.
--
-- REAL COLUMN, NOT JSONB, for the same reason 0012's control columns are:
-- CLAUDE.md invariant 3 whitelists JSONB for ffprobe output, event
-- payloads, serialized plans, item_attributes values, device capability
-- profiles, user settings prefs, server_settings.value and plugin
-- manifest/config. This is none of those — it is a control-channel scalar
-- two processes poll.
--
-- NO INDEX. Every read is by primary key (the worker polls its own session
-- row; the server resolves one session it already authorized), so an index
-- would cost writes on the hottest table in the playback path and buy
-- nothing.

ALTER TABLE playback_sessions ADD COLUMN highest_served_segment INTEGER;

COMMENT ON COLUMN playback_sessions.highest_served_segment IS
  'The highest HLS segment index this session has ever SERVED (answered '
  '200 with a real file body) — d4-f2. Server-written on the success path '
  'of GET /playback/sessions/{id}/hls/{file} only, under a GREATEST so it '
  'is monotonic: an out-of-order or repeated fetch never moves it '
  'backward. Worker-read as the retention prune floor (apps/worker/src/'
  'transcode/playlist.ts pruneRetention''s viewer floor, d3-f1) and '
  'server-read as the backward-jump gate''s progression baseline '
  '(hls-file.controller.ts). Deliberately NOT the same column as '
  'requested_segment: that one records DEMAND (every GET, including 503''d '
  'and far-ahead ones) because the segment-ahead throttle must react to '
  'demand, while these two consumers must react to PROGRESS. NULL means '
  '"never served a segment", never index 0.';
