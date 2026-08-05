-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0033_scan_checkpoint_item_counters
--
-- Additive-only (mirrors 0002/.../0032's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Fix Wave 2 FW2-E / AUD-A2d-003 (low, opus V2 review): `scan_checkpoints`
-- (0002_phase1_catalog.sql) already carries `files_processed` across a
-- resumed scan attempt, with a comment explaining why — "files skipped
-- this run because they were already processed in a prior attempt still
-- count as processed." The scan.completed event's itemsAdded/itemsUpdated/
-- itemsRemoved counters never got the same treatment: they live only in
-- an in-memory `counters` object that starts at zero on every runScan()
-- call, so a job resumed after a crash (same job.id, pg-boss retry —
-- apps/worker/src/scan/scanner.ts) reports only the LAST attempt's own
-- work in the one scan.completed event an admin/the web UI ever sees.
--
-- These three columns are the same real-integer-column treatment as
-- files_seen/files_processed (no JSONB — invariant 3): the scanner reads
-- them back on resume to seed `counters`, and re-persists the running
-- total on every checkpoint write (apps/worker/src/scan/scanner.ts's
-- maybeCheckpoint + the final post-walk writeCheckpoint call), so the
-- terminal scan.completed reports the total across every attempt.

ALTER TABLE scan_checkpoints
  ADD COLUMN items_added   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN items_updated INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN items_removed INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN scan_checkpoints.items_added IS
  'Running itemsAdded total across every attempt of this job (FW2-E/'
  'AUD-A2d-003) — mirrors files_processed''s carry-over-on-resume '
  'semantics. Seeded into scan.completed''s payload on resume so the '
  'terminal event reports the sum, not just the last attempt''s own work.';

COMMENT ON COLUMN scan_checkpoints.items_updated IS
  'Running itemsUpdated total across every attempt of this job — see '
  'items_added''s comment.';

COMMENT ON COLUMN scan_checkpoints.items_removed IS
  'Running itemsRemoved total across every attempt of this job — see '
  'items_added''s comment. Note: itemsRemoved is only ever incremented in '
  '`full` mode''s post-walk missing-file sweep, which (unlike the '
  'per-file walk loop) always re-derives its result from the WHOLE '
  'current catalog on every attempt rather than resuming a partial pass — '
  'see scanner.ts''s runScan for why that sweep needs no resume logic of '
  'its own; this column still exists because its count still needs to '
  'accumulate into the same cross-attempt scan.completed total as the '
  'other two.';
