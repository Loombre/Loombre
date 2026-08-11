-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0043_transcode_runs
--
-- Additive-only (mirrors 0002/.../0041's discipline): one new table, no
-- column drops, no type narrowing, no rewriting of prior migrations, no
-- contract surface.
--
-- WHY. A transcode session is served as ONE playlist whose segment indices
-- are a single global counter (docs/PLAYBACK.md §9: a seek-restart's run
-- continues the previous run's numbering, `{START_SEG}` =
-- producedSegment+1). But each seek run is spawned with `-ss` and no
-- `-copyts`, so its OWN output timeline restarts at zero. The two facts
-- were never connected by anything durable, which made a whole class of
-- questions unanswerable for any run after the first:
--   "segment 57 is playing — what SOURCE position is that?"
-- Presentation time (what the player reports) and source time (what
-- progress, resume points and seek targets are expressed in) diverge by
-- exactly the run's source origin, and nothing recorded that origin.
--
-- Each row is one spawned run: the run index, the segment index it began
-- numbering at, and where it starts in SOURCE time (0 for run 0; the
-- consumed seek target for every restart). A server-side consumer maps a
-- served segment index to its owning run — the row with the greatest
-- start_segment <= that index — and reads the origin from it.
--
-- REAL COLUMNS, REAL FK, deliberately NOT JSONB: CLAUDE.md invariant 3
-- whitelists JSONB for ffprobe output, event payloads, serialized plans,
-- item_attributes values, device capability profiles, user settings prefs,
-- server_settings.value and plugin manifest/config. This is none of those
-- — it is queryable relational state with an owner, and it is read by an
-- index lookup on a hot path.
--
-- BACKWARD SEEKS ARE WHY OWNERSHIP FOLLOWS THE SEGMENT COUNTER, NOT THE
-- CLOCK: run 2 can have a source origin EARLIER than run 1's while its
-- segment numbering still moves forward. `start_segment` is therefore the
-- only monotonic key across a session's runs, and the lookup orders by it.

CREATE TABLE transcode_runs (
  id                UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  session_id        UUID NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
  run_index         INTEGER NOT NULL,
  start_segment     INTEGER NOT NULL,
  source_origin_ms  BIGINT NOT NULL,
  created_at_ms     BIGINT NOT NULL,
  UNIQUE (session_id, run_index)
);

COMMENT ON TABLE transcode_runs IS
  'One row per ffmpeg run spawned for a transcode session (apps/worker/src/'
  'transcode/runner.ts), including run 0. Exists so a served segment index '
  'can be mapped back to a SOURCE-time position: segment numbering is '
  'global across a session''s runs while each seek run''s own output '
  'timeline restarts at zero. Worker-written, server-read; rows die with '
  'their session.';

COMMENT ON COLUMN transcode_runs.run_index IS
  'Zero-based, monotonic per session; matches the run''s staging '
  'subdirectory name (`run0`, `run1`, ...) and the run-relative URI prefix '
  'in the served playlist.';

COMMENT ON COLUMN transcode_runs.start_segment IS
  'The absolute segment index this run begins numbering at ({START_SEG}, '
  'docs/PLAYBACK.md §6): 0 for run 0, previous producedSegment+1 for each '
  'seek restart. The ONLY monotonic ordering key across a session''s runs — '
  'source_origin_ms is not monotonic, because a backward seek starts a '
  'later run at an earlier source position.';

COMMENT ON COLUMN transcode_runs.source_origin_ms IS
  'Where this run starts in the SOURCE timeline, milliseconds (CLAUDE.md '
  'invariant 5). 0 for run 0; the seek target the worker actually consumed '
  '(post-clamp) for a seek restart. Segment N''s source position is this '
  'value plus N''s offset within the owning run — the run''s own output '
  'timestamps start at zero, since runs are spawned with `-ss` and without '
  '`-copyts`.';

-- The one read this table exists for: "which run owns segment N for this
-- session?" — greatest start_segment <= N, scoped to one session. DESC
-- matches the ORDER BY ... LIMIT 1 the query uses, so it is a single index
-- step rather than a scan of the session's runs.
CREATE INDEX transcode_runs_session_start_segment_idx
  ON transcode_runs (session_id, start_segment DESC);
