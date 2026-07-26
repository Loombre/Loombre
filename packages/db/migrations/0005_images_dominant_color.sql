-- SPDX-License-Identifier: AGPL-3.0-only
-- ============================================================================
-- Loombre migration 0005 — images.dominant_color (P2.11, slot per P2.15)
-- ============================================================================
-- Expand step (docs/PLAN.md §4.2: expand -> migrate -> contract). Adds the
-- column only; the one-time backfill of existing rows is a worker job
-- (apps/worker/src/image/backfill-consumer.ts), not part of this migration
-- — CLAUDE.md invariant 6 (long-running work goes through the job queue,
-- nothing does bulk work inline) applies to a library-wide image rescan
-- exactly as it does to any other CPU/IO-heavy sweep.
--
-- Format: '#rrggbb' lowercase hex, extracted worker-side from the decoded
-- original at image-ingest time (never on a request path, never
-- client-side) via sharp's histogram-derived dominant colour (see
-- apps/worker/src/image/variant-job.ts's computeDominantColor). NULL means
-- "not yet computed" (pre-migration rows awaiting backfill). The backfill
-- consumer additionally uses '' (empty string) as a distinct sentinel for
-- "computed, but the source file was missing/unreadable — permanently
-- skipped, never retried"; the read path (packages/db/src/query/
-- catalog-detail.ts) treats both NULL and '' as a null dominantColor.
-- Nothing enforces the '#rrggbb' shape at the DB layer (TEXT, matching
-- blurhash's own convention on this table) — the worker is the only writer
-- (CLAUDE.md invariant 4/8 style: this column is never client-writable).

ALTER TABLE images ADD COLUMN dominant_color TEXT NULL;

COMMENT ON COLUMN images.dominant_color IS
  'Hex ''#rrggbb'' dominant colour extracted worker-side at ingest '
  '(sharp stats().dominant), alongside blurhash. NULL = not yet computed '
  '(pre-migration row pending the one-time backfill job). Empty string '
  '('''') = computed-but-unavailable sentinel (source file missing/unreadable '
  'at backfill time) — distinct from NULL so the backfill never retries it. '
  'Both NULL and '''' read back as a null dominantColor at the query layer.';
