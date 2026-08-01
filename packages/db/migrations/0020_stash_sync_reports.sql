-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0020_stash_sync_reports
--
-- Additive-only (mirrors 0002/.../0019's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Stash SQLite metadata sync (STATE.md mission "Stash SQLite metadata sync
-- + dedicated Restricted Content surface"), Lane C (sync engine, S8/K14).
-- Pre-assigned this migration number (K8 amended: A=0018, B=0019, C=0020,
-- E=0021). Two tables:
--
--   stash_sync_reports — one row per `stash-sync` job RUN (not per scene):
--   library_id/job_id/mode/status plus the five S8 counts
--   (matched/updated/unmatched/stale/skipped) and started/finished
--   timestamps. This is the admin-visible sync-report ARTIFACT (K14's
--   GET /admin/libraries/{id}/stash-sync-report reads the latest row per
--   library) — counts are a point-in-time SNAPSHOT recorded when the run
--   finished (or failed), same posture as scan.completed's own
--   itemsAdded/Updated/Removed. Deliberately does NOT duplicate the
--   unmatched/stale SCENE LISTS: those are computed LIVE from
--   stash_scene_links (item_id IS NULL / stale = TRUE — Lane A's table,
--   K10) at read time, via the new partial indexes below, so the report
--   table never goes stale relative to the live link table between syncs
--   (e.g. an admin fixing a path mapping and re-previewing without a full
--   resync).
--
--   stash_sync_checkpoints — resumable progress for an in-flight
--   `stash-sync` job (deliverable 2: "a full 33k sync survives worker
--   death and resumes without redoing completed work"). Mirrors
--   migrations/0002_phase1_catalog.sql's scan_checkpoints table SHAPE and
--   MECHANISM exactly (job_id PRIMARY KEY, same-job-id-on-retry: pg-boss
--   redispatches a failed job under the SAME job.id — see
--   packages/jobs/src/queue.ts's work() batch handler, `attempts =
--   job.retryCount + 1` — so a checkpoint keyed by job_id survives a
--   retry) but is its OWN table rather than a reuse of scan_checkpoints:
--   that table's columns (last_processed_path/files_seen/files_processed)
--   are scanner-specific by name and by its own COMMENT ("the scanner
--   reads ... to resume a crashed or restarted job") — reusing it here
--   would mean storing a Stash scene id in a column literally named
--   "path" and a scene count in a column literally named "files_seen",
--   which is exactly the kind of column-semantics drift CLAUDE.md
--   invariant 3 ("real columns... never JSONB-as-a-junk-drawer") argues
--   against in spirit. apps/worker/src/stash/sync-consumer.ts's own
--   header records this choice (vs. the image-backfill self-requeue-
--   cursor pattern) and why: `stash-sync` is registered LONG_RUNNING
--   (packages/jobs/src/types.ts, 23h expire) with retryLimit 2 — ONE job
--   holds its handler promise for the WHOLE run and pg-boss itself
--   retries it under the same id, exactly matching 'scan''s shape, not
--   image-backfill's BOUNDED short-batch-per-job-id shape.

-- ============================================================================
-- stash_sync_reports
-- ============================================================================

CREATE TYPE stash_sync_mode AS ENUM ('full', 'incremental');

CREATE TYPE stash_sync_report_status AS ENUM ('running', 'succeeded', 'failed', 'partial');

CREATE TABLE stash_sync_reports (
  id                UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id        UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  -- Not a FK to jobs(id), same posture as scan_checkpoints.job_id (this
  -- file's header) — the report row's lifecycle is independent of
  -- @loombre/jobs' own ledger row lifecycle.
  job_id            UUID NOT NULL,
  mode              stash_sync_mode NOT NULL,
  status            stash_sync_report_status NOT NULL DEFAULT 'running',
  matched_count     INT NOT NULL DEFAULT 0,
  updated_count     INT NOT NULL DEFAULT 0,
  unmatched_count   INT NOT NULL DEFAULT 0,
  stale_count       INT NOT NULL DEFAULT 0,
  skipped_count     INT NOT NULL DEFAULT 0,
  started_at_ms     BIGINT NOT NULL,
  finished_at_ms    BIGINT NULL
);

COMMENT ON TABLE stash_sync_reports IS
  'One row per stash-sync job RUN (S8) — counts + provenance, never the '
  'unmatched/stale SCENE LISTS themselves (those stay live queries over '
  'stash_scene_links, see this migration''s header). status starts '
  '''running'' at job start and is finalized to ''succeeded''/''failed''/ '
  '''partial'' in the SAME transaction that writes the paired '
  '`stash.sync.completed` event (K12) — a row is never left ''running'' '
  'forever except while a job is genuinely still in flight or has just '
  'crashed without reaching the terminal-failure hook yet.';

COMMENT ON COLUMN stash_sync_reports.job_id IS
  'The pg-boss job id this report row tracks (packages/jobs, meta.jobId) '
  '— NOT a foreign key (see this table''s own comment). Used to '
  'correlate a report row with its stash_sync_checkpoints row (same '
  'job_id) while the run is in flight.';

COMMENT ON COLUMN stash_sync_reports.status IS
  '''running'' from job start until a terminal write. ''succeeded'': '
  'the run completed with no unhandled error. ''partial'': the run '
  'completed but skipped_count > 0 for a reason short of a full failure '
  '(documented per-scene skip, e.g. a scene with no linked Stash file at '
  'all — never used to paper over a bug). ''failed'': the job exhausted '
  'its retries (apps/worker/src/stash/sync-consumer.ts''s onTerminalFailure '
  'hook, mirroring apps/worker/src/probe/terminal-failure-hook.ts''s '
  'precedent) — counts reflect whatever the checkpoint had recorded at '
  'that point, never fabricated to look complete.';

COMMENT ON COLUMN stash_sync_reports.matched_count IS
  'Scenes matched to a Loombre catalog item (S4, either tier) as of this '
  'run''s completion — a snapshot, not itself a live query.';

COMMENT ON COLUMN stash_sync_reports.updated_count IS
  'Matched scenes whose metadata actually CHANGED and were re-applied '
  'via the injected applyStashSceneMetadata (K11) this run — a matched-'
  'but-unchanged scene (incremental mode''s common case) does not '
  'increment this.';

COMMENT ON COLUMN stash_sync_reports.unmatched_count IS
  'Snapshot of stash_scene_links rows with item_id IS NULL for this '
  'library at run completion (S4 "visible by construction") — the live '
  'list itself is read fresh from stash_scene_links, this count is '
  'just this run''s own historical record of the same fact.';

COMMENT ON COLUMN stash_sync_reports.stale_count IS
  'Snapshot of stash_scene_links rows with stale = TRUE for this '
  'library at run completion (S8: scenes no longer seen in Stash, KEPT '
  'never deleted). A full sync recomputes staleness from scratch; an '
  'incremental sync only marks NEWLY-vanished scenes stale, so this '
  'count can include stale rows from a PRIOR run this one never '
  'revisited.';

COMMENT ON COLUMN stash_sync_reports.skipped_count IS
  'Scenes this run deliberately did not apply (e.g. matched-but-'
  'unchanged in incremental mode, or a scene apply the injected '
  'applyStashSceneMetadata reported as a documented no-op) — H3 '
  '"no-silent-anything": every scene this run looked at lands in exactly '
  'one of matched/updated/unmatched/stale/skipped, never uncounted.';

-- ============================================================================
-- stash_sync_checkpoints
-- ============================================================================

CREATE TABLE stash_sync_checkpoints (
  job_id                        UUID PRIMARY KEY,
  library_id                    UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  phase                         TEXT NOT NULL,
  last_processed_stash_scene_id TEXT NULL,
  scenes_seen                   INT NOT NULL DEFAULT 0,
  scenes_processed              INT NOT NULL DEFAULT 0,
  updated_at_ms                 BIGINT NOT NULL
);

COMMENT ON TABLE stash_sync_checkpoints IS
  'Resumable progress for an in-flight/crashed stash-sync job (deliverable '
  '2: a 33k-scene full sync survives a worker death and resumes without '
  'redoing completed work) — mirrors scan_checkpoints'' same-job-id-on- '
  'retry mechanism exactly (see this migration''s header for why this is '
  'a SEPARATE table rather than a reuse of scan_checkpoints itself). '
  '`phase` is one of ''inventory'' | ''matching'' | ''applying'' | '
  '''completed'' (apps/worker/src/stash/sync-consumer.ts''s own phase '
  'constants — not CHECK-constrained here, matching scan_checkpoints.phase''s '
  'own plain-TEXT precedent, since the checkpoint reader/writer is the '
  'sole owner of this column''s value set).';

COMMENT ON COLUMN stash_sync_checkpoints.last_processed_stash_scene_id IS
  'The last Stash scene id (ordered ASC, same ordering read-model.ts''s '
  'listSceneIds/listScenesForInventory already produce) this run fully '
  'processed through the apply phase — a resumed attempt re-walks from '
  'the beginning of its ordered scene list but SKIPS every scene up to '
  'and including this one, exactly mirroring scanner.ts''s '
  '`maybeCheckpoint`/resume-by-skip algorithm.';

-- ============================================================================
-- indexes (index law: land WITH the tables/queries that need them)
-- ============================================================================

-- getLatestStashSyncReport (packages/db/src/query/stash-sync-reports.ts,
-- K14): "the most recent report row for a library" — library_id-prefixed,
-- started_at_ms DESC so `ORDER BY started_at_ms DESC LIMIT 1` is a pure
-- index scan, never a sort over every historical row for a long-lived
-- library with many past sync runs.
CREATE INDEX stash_sync_reports_library_started_idx
  ON stash_sync_reports (library_id, started_at_ms DESC);

COMMENT ON INDEX stash_sync_reports_library_started_idx IS
  'getLatestStashSyncReport''s working set: library_id-prefixed, '
  'started_at_ms DESC, so the "latest report" read is an index-only '
  'walk instead of a sequential scan + sort over every historical run.';

-- The stash-sync onTerminalFailure hook (apps/worker/src/stash/
-- sync-consumer.ts) finds "the currently-running report row for this
-- library" from just {libraryId} (packages/jobs' onTerminalFailure hook
-- signature carries no jobId — see that file's header) — partial on
-- status = 'running' since that is always a small, transient set (at
-- most one row per library in normal operation, 'stash-sync' registers
-- concurrency:1) against a table that otherwise accumulates one row per
-- historical run.
CREATE INDEX stash_sync_reports_running_idx
  ON stash_sync_reports (library_id)
  WHERE status = 'running';

COMMENT ON INDEX stash_sync_reports_running_idx IS
  'Partial (status = ''running''): the terminal-failure hook''s '
  '"find the in-flight report for this library" lookup — small and '
  'transient by construction (stash-sync runs at queue concurrency:1), '
  'so this index stays tiny regardless of how many historical reports '
  'accumulate.';

-- K14's "live unmatched/stale list queries, keyset where lists can be
-- long" over Lane A''s stash_scene_links (migrations/0018). Composite
-- (library_id, stash_scene_id) partial indexes support the keyset
-- ordering (`WHERE library_id = $1 AND item_id IS NULL AND
-- stash_scene_id > $cursor ORDER BY stash_scene_id LIMIT $n`) as a pure
-- index range scan — 0018's own stash_scene_links_unmatched_idx
-- (library_id only, WHERE item_id IS NULL) already covers the plain
-- library_id filter but would still need a separate sort for the keyset
-- ORDER BY at the owner's 33k-scene scale; these are additive alongside
-- it (0018 is Lane A's migration, not edited here).
CREATE INDEX stash_scene_links_unmatched_keyset_idx
  ON stash_scene_links (library_id, stash_scene_id)
  WHERE item_id IS NULL;

CREATE INDEX stash_scene_links_stale_keyset_idx
  ON stash_scene_links (library_id, stash_scene_id)
  WHERE stale;

COMMENT ON INDEX stash_scene_links_unmatched_keyset_idx IS
  'K14''s live unmatched-scenes keyset list (packages/db/src/query/'
  'stash-sync-reports.ts''s listUnmatchedStashScenes): (library_id, '
  'stash_scene_id) WHERE item_id IS NULL supports the keyset '
  '`stash_scene_id > cursor ORDER BY stash_scene_id` range scan directly '
  '— proven against the 33k-scene synthetic fixture in '
  'packages/db/test/stash-sync-reports.spec.ts.';

COMMENT ON INDEX stash_scene_links_stale_keyset_idx IS
  'K14''s live stale-scenes keyset list (listStaleStashScenes): same '
  'shape as stash_scene_links_unmatched_keyset_idx, scoped to `stale` '
  '(S8) instead of `item_id IS NULL`.';
