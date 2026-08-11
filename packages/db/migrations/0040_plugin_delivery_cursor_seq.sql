-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0040_plugin_delivery_cursor_seq
--
-- Additive-only (mirrors 0002/.../0038/0039's discipline): no column
-- drops, no type narrowing, no rewriting of prior migrations.
--
-- Fixes a verified persisted-cursor skip hazard (opus-review LD wave,
-- Finding 1): packages/db/src/query/plugins-delivery.ts's
-- listCandidateEventsForDelivery read the outbox via `WHERE id > afterId
-- ORDER BY id ASC`, keyset-paginating on `events.id` against the SAME
-- persisted cursor (plugin_delivery_cursors.cursor_event_id) that
-- migrations/0039_events_seq.sql's header already proved is UNSAFE for
-- same-millisecond ordering: two events written in the same Postgres
-- clock millisecond tie on UUIDv7's time-ordered prefix and fall back to
-- comparing pure-random tail bits, uncorrelated with insertion order. For
-- 0039's ONE fixed reader (the websocket broadcaster) that "only" meant a
-- delivery-order hazard within a single already-connected tick. Here it is
-- worse: the cursor PERSISTS between ticks, so a same-millisecond sibling
-- event whose id happens to sort BEFORE the plugin's just-advanced cursor
-- is excluded by `id > afterId` on every subsequent tick FOREVER — a
-- silent, permanent skip, not a transient reordering — and
-- findOldestUnconsumedBeforeMs (this table's gap detector) does not catch
-- it: that function only flags events older than the retention window,
-- not same-millisecond siblings sitting right at the cursor's own advance
-- point, which is exactly where this hazard lives. That is a direct
-- violation of LPP v1 mission §3.2's "gaps reported, never skipped".
--
-- Fix: give plugin_delivery_cursors its own `events.seq` tie-break,
-- exactly the column 0039 minted for this purpose, and switch
-- listCandidateEventsForDelivery's keyset read to `WHERE seq > afterSeq
-- ORDER BY seq ASC` (packages/db/src/query/plugins-delivery.ts,
-- apps/worker/src/plugin-delivery/delivery-loop.ts). `seq` is a Postgres
-- identity-sequence value assigned synchronously at INSERT time with no
-- dependence on clock resolution, so same-millisecond siblings can never
-- tie and can never sort out of insertion order — see 0039's header for
-- the full mechanism.
--
-- KEPT, not dropped: cursor_event_id. Two production readers exist for
-- this table's cursor today (packages/db/src/query/events.ts's header,
-- updated by this same fix wave, documents both): the candidate-event read
-- this migration retargets at `seq`, AND findOldestUnconsumedBeforeMs's
-- gap detector, which stays keyed on `events.id > afterId` — gap detection
-- compares against `ts_ms < beforeMs` (the retention-window edge), a
-- comparison `seq` cannot help with (seq is an opaque insertion-order
-- counter with no relationship to wall-clock time), so converting IT to
-- `seq` would buy nothing while touching a second read path this finding
-- did not identify as broken. cursor_event_id also remains the
-- observability-facing value (a real, human-followable events.id) a
-- future admin delivery-stats panel (W5b) would show, where a bare `seq`
-- integer is meaningless outside this table. Every writer
-- (recordDeliverySuccess / advanceCursorPastFilteredEvents) now writes
-- BOTH columns together, in the same statement, so they can never
-- observably disagree about "how far did this plugin get" — the same
-- discipline plugins-delivery.ts's header already documents for
-- cursor_event_id vs. delivered_batches/delivered_events. This is the
-- lower-risk of the two options the review posed (keep-alongside vs.
-- drop): dropping cursor_event_id would require rewriting
-- findOldestUnconsumedBeforeMs's cursor semantics in the SAME migration
-- that fixes the listCandidateEventsForDelivery hazard, conflating two
-- independent changes and widening this migration's blast radius for no
-- corresponding benefit.
--
-- Backfill: `cursor_event_seq` is derived from the EXISTING
-- cursor_event_id via a subselect against `events.id`. This subselect is
-- guaranteed to resolve for every non-NULL cursor_event_id: `events` has
-- no pruning/retention mechanism (migrations/0016_plugin_delivery_
-- cursors.sql's header — "events has no pruning/retention path" — nothing
-- ever DELETEs an events row), so any id a cursor ever recorded is still
-- present. A cursor_event_id that is NULL (this plugin has never
-- successfully delivered a batch — migrations/0016's own "never
-- delivered" convention) backfills to a NULL cursor_event_seq, which
-- delivery-loop.ts treats identically to a fresh/never-delivered cursor
-- (afterSeq defaults to 0, the "from the beginning" value, the same way
-- baseAfterId already defaults to EPOCH_ZERO_BOUNDARY_UUID) — no separate
-- NULL-handling branch needed anywhere this column is read.
--
-- Cost on upgrade: `plugin_delivery_cursors` has at most one row per
-- installed plugin (migrations/0016's PRIMARY KEY), never a
-- high-cardinality table like `events` — this ADD COLUMN + UPDATE
-- backfill is cheap and bounded by installed-plugin count, unlike 0039's
-- table-rewrite cost on `events`.
ALTER TABLE plugin_delivery_cursors ADD COLUMN cursor_event_seq BIGINT NULL;

UPDATE plugin_delivery_cursors
SET cursor_event_seq = (SELECT seq FROM events WHERE events.id = plugin_delivery_cursors.cursor_event_id)
WHERE cursor_event_id IS NOT NULL;

COMMENT ON COLUMN plugin_delivery_cursors.cursor_event_seq IS
  'events.seq (migrations/0039_events_seq.sql) of the last event '
  'successfully included in a 2xx-acknowledged batch for this plugin — '
  'the value packages/db/src/query/plugins-delivery.ts''s '
  'listCandidateEventsForDelivery actually keysets the next read on '
  '(`WHERE seq > cursor_event_seq`), NOT cursor_event_id (see this '
  'migration''s header for why events.id is unsafe as a same-millisecond '
  'keyset tie-break). Always advanced together with cursor_event_id in '
  'the same statement — the two can never observably disagree about how '
  'far a plugin''s delivery cursor has advanced. NULL = never delivered '
  '(same convention as cursor_event_id) — a fresh cursor or one whose '
  'cursor_event_id backfilled to NULL because it had never recorded a '
  'success at migration time.';
