-- 0037: index for "newest ledger row of a given type" (W1/D-1 2026-08-07).
--
-- GET /admin/capabilities derives its three-state probe status from the
-- latest 'hwprobe' jobs row (packages/db/src/query/admin.ts
-- getLatestJobOfTypeAdmin: WHERE type = $1 ORDER BY created_at_ms DESC,
-- id DESC LIMIT 1). jobs has indexes on (status, priority, created_at_ms),
-- (created_at_ms DESC, id DESC) and subject_item_id — none lead with
-- `type`, so that lookup seq-scans the whole ledger (measured: parallel
-- seq scan at 200k rows), on an endpoint the setup wizard polls every 4s
-- and on exactly the install shape W1 is about. jobs is the
-- fastest-growing table in the schema (one probe row per media file);
-- this makes the lookup a direct b-tree seek.

CREATE INDEX jobs_type_created_at_keyset_idx
  ON jobs (type, created_at_ms DESC, id DESC);
