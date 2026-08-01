-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0022_stash_sync_report_snapshot
--
-- Additive-only (mirrors 0002/.../0021's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- FX4 fix wave (STATE.md FIX WAVE queue, 2026-08-01 docs-lane gap audit):
-- S2's snapshot-copy fallback (apps/worker/src/stash/adapter.ts's
-- StashConnection.readingFrom === 'snapshot' — the WAL-locked-past-retry-
-- budget path) is a real, observed fact about how a sync run read the
-- Stash database, but nothing durable ever recorded it: not the
-- stash.sync.completed event (additive optional field, same migration
-- session, packages/contract/event-schemas/stash.sync.completed.schema.json)
-- and not the admin-visible sync-report artifact. This migration adds the
-- durable half.
--
-- Nullable BOOLEAN, not NOT NULL DEFAULT false: `false` would be a
-- fabricated claim of "read from source" for every report row that
-- existed before this column did, and for a run finalized by
-- createStashSyncTerminalFailureHook (apps/worker/src/stash/
-- sync-consumer.ts), which never obtains a connection for the failed
-- attempt and genuinely does not know the answer (H3 "no-silent-anything"
-- — an unknown fact stays NULL, never a guessed default).

ALTER TABLE stash_sync_reports
  ADD COLUMN used_snapshot_fallback BOOLEAN NULL;

COMMENT ON COLUMN stash_sync_reports.used_snapshot_fallback IS
  'FX4 fix wave (S2): whether this run''s Stash connection had to fall '
  'back to a snapshot copy (apps/worker/src/stash/adapter.ts''s '
  'readingFrom = ''snapshot'', the WAL-locked-past-retry-budget path) '
  'rather than reading the source database file directly. Written once, '
  'at finalization (packages/db/src/query/stash-sync-reports.ts''s '
  'finishStashSyncReport), from the SAME connectToStashLibrary call the '
  'sync itself used. NULL means unknown — a report finalized by the '
  'onTerminalFailure hook (no access to the failed attempt''s '
  'connection) or a row written before this column existed — never a '
  'false claim of ''read from source''.';
