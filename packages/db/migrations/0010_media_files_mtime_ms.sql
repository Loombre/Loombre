-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0010_media_files_mtime_ms
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007's discipline): no column
-- drops, no type narrowing, no rewriting of prior migrations.
--
-- STATE.md P3.10: the scanner's incremental fast path (apps/worker/src/
-- scan/scanner.ts's processOneFile) short-circuited an existing path match
-- as "unchanged" whenever path+size matched, because media_files had no
-- mtime column to compare (see the now-superseded comment this migration's
-- companion worker change replaces). A same-byte-size in-place edit (e.g.
-- an in-place mux/remux that preserves the exact file length) was therefore
-- never re-hashed or re-probed — a false-negative "unchanged" that would
-- persist until the file's size happened to change. `mtime_ms` closes that
-- gap: the scanner now also compares the filesystem's mtime, so a same-size
-- edit (which always bumps mtime) falls through to the hash path instead of
-- being silently skipped.
--
-- ALSO NULL for a second, unrelated reason: it doubles as a legacy marker.
-- Every media_files row that existed before this column landed has
-- mtime_ms = NULL (no ALTER TABLE backfill — there is no historical mtime
-- to backfill from), and the scanner treats a NULL as "not yet observed
-- since this column landed" rather than "unchanged", forcing exactly one
-- re-hash per legacy row to establish a baseline going forward.

ALTER TABLE media_files ADD COLUMN mtime_ms BIGINT NULL;

COMMENT ON COLUMN media_files.mtime_ms IS
  'Filesystem mtime (stat().mtimeMs), truncated to an integer millisecond '
  'count, as observed at the file''s last successful hash or probe '
  '(apps/worker/src/scan/scanner.ts). Compared alongside size_bytes in the '
  'incremental fast path: a path+size match with a matching mtime_ms is '
  'unchanged; a path+size match with a differing or NULL mtime_ms falls '
  'through to re-hash. NULL means either a legacy row that predates this '
  'column (not yet observed since it landed — the scanner re-hashes once '
  'to establish a baseline) or a row whose file has never been '
  'hashed/probed.';
