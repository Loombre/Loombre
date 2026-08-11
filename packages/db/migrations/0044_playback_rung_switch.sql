-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0044_playback_rung_switch
--
-- Additive-only (mirrors 0002/.../0043's discipline): three new nullable
-- columns, no drops, no type narrowing, no rewriting of prior migrations.
--
-- WHY (docs/PLAYBACK.md §9.1, Wave C2 — LD-6 governed by LD-16). The master
-- playlist advertises every rung of the session's stored plan, and a client
-- ABR switch surfaces to the server as a GET whose path names a DIFFERENT
-- rung (`v{K}/media.m3u8`, `v{K}/runN/sNNNNNN.m4s`). LD-16 forbids that
-- starting a second pipeline: "every quality rung is a separate workload
-- governed by the existing admission capacity limit; a quality change HANDS
-- THE EXISTING SLOT from one rung to another — it never starts an
-- additional unrestricted transcode."
--
-- Handing the slot over is a restart of the one live pipeline with
-- different rung args, so it needs exactly the same shape of control
-- channel a seek already has (migration 0012): a server-written REQUEST
-- column the worker consumes, plus a worker-written fact about what is
-- actually running. Those are `pending_rung_index` and `active_rung_index`.
-- `transcode_runs.ladder_rung_index` records which rung each spawned run
-- encoded, so a session's run history says not just WHERE each run started
-- but WHAT quality it was producing.
--
-- WRITE-OWNERSHIP SPLIT (the same seam contract 0012's header states, with
-- no new channel — apps/server writes rows and columns, apps/worker reads
-- and answers; there is no IPC between them):
--   active_rung_index    worker-written at EVERY spawn (run 0 records the
--                        plan's own top rung; a handoff records the rung it
--                        just handed the slot to). Server-read.
--   pending_rung_index   server-written (requestRungSwitch), worker-consumed
--                        under compare-and-clear. Absorb-on-match at the
--                        WRITE side: a request naming the already-active
--                        rung is never recorded, which is the switch
--                        analogue of seek absorption and kills request
--                        storms at the door rather than at the poll tick.
--   ladder_rung_index    worker-written once per spawned run, alongside
--                        start_segment/source_origin_ms.
--
-- WHY NULLABLE, AND WHY THAT IS NOT A "MAYBE" COLUMN: NULL means "no rung
-- applies", a real and common state — direct-play sessions run no pipeline
-- at all, ladder-empty sessions (direct-stream copy, audio-only transcode)
-- have no rung to name, and every pre-C2 row predates the concept. A
-- consumer must read NULL as "not applicable", never as rung 0: rung 0 is
-- the TOP of the ladder and the rung a session normally starts on, so
-- conflating the two would silently claim every legacy row was serving top
-- quality.
--
-- REAL COLUMNS, NOT JSONB, for the same reason 0012's control columns are:
-- CLAUDE.md invariant 3 whitelists JSONB for ffprobe output, event payloads,
-- serialized plans, item_attributes values, device capability profiles, user
-- settings prefs, server_settings.value and plugin manifest/config. This is
-- none of those — it is a control channel two processes poll.
--
-- NO INDEX. Every read here is by primary key (the worker polls its own
-- session row; the server resolves one session it already authorized), so
-- an index would cost writes on the hottest table in the playback path and
-- buy nothing. `transcode_runs.ladder_rung_index` is likewise never a
-- lookup key — the existing (session_id, start_segment DESC) index answers
-- the only question that table is asked.

ALTER TABLE playback_sessions ADD COLUMN active_rung_index INTEGER;
ALTER TABLE playback_sessions ADD COLUMN pending_rung_index INTEGER;

COMMENT ON COLUMN playback_sessions.active_rung_index IS
  'Index into the stored plan''s `ladder` of the rung the live ffmpeg run '
  'is currently encoding (docs/PLAYBACK.md §9.1.3). Worker-written at every '
  'spawn — run 0 writes the plan''s own top rung, a §9.1.4 slot handoff '
  'writes the rung it handed the slot to — so the row always names what is '
  'really running. Server-read: a `v{K}` GET whose K differs from this is '
  'the ABR switch signal. NULL for direct-play, ladder-empty and pre-C2 '
  'sessions; NULL means "no rung applies", NEVER rung 0.';

COMMENT ON COLUMN playback_sessions.pending_rung_index IS
  'A requested rung switch awaiting the worker''s next poll tick (docs/'
  'PLAYBACK.md §9.1.3). Server-written by requestRungSwitch, validated '
  '0 <= K < ladder.length at the controller and absorbed at the WRITE side '
  'when it names the already-active rung. Worker-consumed under the same '
  'compare-and-clear discipline as seek_target_ms: the UPDATE is guarded on '
  'the exact value read, so a different rung written in between survives to '
  'the next tick instead of being swallowed. A PURE switch never changes '
  '`status` and never bumps `discontinuity_count` — the union playlist stays '
  'fully servable across a handoff, and its discontinuities come from run '
  'folding, not from this channel.';

ALTER TABLE transcode_runs ADD COLUMN ladder_rung_index INTEGER;

COMMENT ON COLUMN transcode_runs.ladder_rung_index IS
  'Which rung of the stored plan''s ladder this run encoded, at spawn time '
  '(docs/PLAYBACK.md §9.1.3). Bookkeeping only — the boot reaper never '
  'reads it, and segment ownership still follows start_segment alone, '
  'which stays correct under ABR precisely because this delivery model '
  'never runs two rungs in parallel. NULL for pre-C2 rows and ladder-empty '
  'sessions.';
