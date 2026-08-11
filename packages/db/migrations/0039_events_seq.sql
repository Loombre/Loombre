-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0039_events_seq
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007/0010/0038's discipline):
-- no column drops, no type narrowing, no rewriting of prior migrations.
--
-- Fixes a verified ordering defect (packages/jobs/test/ledger-events.spec.ts
-- "'pg-upgrade' can also record a failed upgrade attempt" flaked once under
-- a parallel gate:full run: events came back ['queued','failed','active']
-- instead of ['queued','active','failed']).
--
-- Root cause: every read that orders the outbox by `events.id` (this
-- migration's sibling reads in packages/db/src/query/events.ts, and the
-- ledger-events spec's own inline helper) rests on the assumption, stated
-- explicitly in events.ts's header, that "UUIDv7's layout ... makes
-- Postgres's byte-wise UUID ordering equivalent to insertion-time order".
-- That assumption is FALSE within a tied millisecond: loombre_uuidv7()
-- (this file's schema.sql, `loombre_uuidv7()`) stamps bytes 0-5 from
-- clock_timestamp() truncated to the millisecond, but fills every
-- remaining bit (byte 6's low nibble, byte 7, byte 8's low 6 bits, bytes
-- 9-15 — the vast majority of the value) from bare `random()`, with NO
-- monotonic-counter fallback for same-millisecond collisions (RFC 9562
-- §6.2's "Method 1: Fixed-Length Dedicated Counter Bits" or "Method 3:
-- Replace Left-Most Random Bits with Increased Clock Precision" — neither
-- implemented here). Two events written back-to-back within the same
-- Postgres clock millisecond (routine under concurrent load: two awaited
-- local round-trips easily land inside 1ms) therefore tie on the ordered
-- byte prefix and fall back to comparing PURE RANDOM tail bytes — a coin
-- flip uncorrelated with which INSERT actually ran first. `ORDER BY id`
-- is consequently NOT a valid tie-break for emission order; it only LOOKS
-- valid because same-millisecond collisions are rare outside load.
--
-- Fix: `seq` is a BIGINT populated by Postgres's own per-column identity
-- sequence (nextval(), same primitive backing SERIAL/BIGSERIAL). Sequence
-- values are handed out synchronously, in the exact order nextval() is
-- invoked, with no two callers ever receiving the same value — this holds
-- regardless of clock resolution or transaction commit order, so for any
-- row INSERTed FROM THIS MIGRATION ONWARD, `seq` is a GUARANTEED total
-- order over insertion attempts, not merely a lower-probability-of-
-- collision one. For any caller that awaits each INSERT (commit included)
-- before issuing the next — every packages/jobs/src/ledger.ts
-- recordQueued/recordActive/recordCompleted/recordFailed transition,
-- called sequentially in the ledger-events spec — the second INSERT's
-- nextval() call happens strictly after the first's, so `seq` strictly
-- increases in exactly the emission order, with no possible tie.
--
-- Pre-existing rows (any database that already had an events table before
-- this migration ran) are NOT covered by that guarantee: `ADD COLUMN ...
-- GENERATED ALWAYS AS IDENTITY` is a volatile-default column addition, so
-- Postgres backfills every existing row's `seq` in one pass, in PHYSICAL
-- HEAP scan order — NOT insertion order. Those two orders provably diverge
-- here: events rows are UPDATEd after insertion by markEventsProcessed
-- (packages/db/src/query/events.ts, sets processed_at_ms once a batch has
-- been broadcast), and a Postgres UPDATE writes a new row version rather
-- than rewriting in place, so a row's heap position reflects its last
-- UPDATE, not its original INSERT. Pre-existing rows therefore get a `seq`
-- value that is arbitrary-but-unique relative to true insertion order —
-- fine as an opaque tie-break key (still never repeats, still totally
-- orders every row), but not a retroactive proof of when a pre-migration
-- row was actually written. Only rows inserted after this migration carry
-- the strong "matches insertion order" guarantee above.
--
-- Cost on upgrade: because the ADD COLUMN has a volatile default (identity
-- backfill, effectively DEFAULT nextval(...) evaluated per row), Postgres
-- cannot do the fast metadata-only add it does for a constant/NULL
-- default — this rewrites the ENTIRE table under an ACCESS EXCLUSIVE lock
-- (blocks all reads and writes on `events` for the duration). `events` has
-- no pruning/retention path (nothing ever DELETEs from it), so on any
-- install that has been running a while it is a strong candidate for the
-- largest table in the database, and this is a one-time, unavoidable-at-
-- this-migration cost on upgrade. Considered and rejected: splitting this
-- into the standard zero-downtime sequence (ADD COLUMN nullable, backfill
-- in batches, ADD ... NOT NULL, SET default, all as separate migrations)
-- — rejected for v0.9.0-rc: pre-1.0 installs are testers on small/disposable
-- databases where the extra migrations' complexity costs more than the
-- lock they'd avoid; revisit before a 1.0 release once install sizes are
-- real.
--
-- UNIQUE is redundant with identity-sequence semantics (values are never
-- reused) but stated explicitly rather than left implicit, and doubles as
-- the index the new `ORDER BY ... seq` read wants.
ALTER TABLE events ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE;

COMMENT ON COLUMN events.seq IS
  'Postgres identity-sequence tie-break for outbox read ordering. Unlike '
  '`id` (UUIDv7 — time-ordered only to the millisecond; ties within a '
  'millisecond resolve on random bits, NOT insertion order — see this '
  'migration''s header), `seq` is assigned by a strictly-increasing '
  'per-column sequence at INSERT time, so ORDER BY seq is a real, gap-'
  'tolerant-but-never-tied total order over insertion order — for rows '
  'inserted AFTER this migration ran. Rows that pre-date this migration '
  'were backfilled in physical heap order (NOT insertion order: events '
  'rows are UPDATEd post-insert by markEventsProcessed, so heap order had '
  'already diverged from insertion order) — their seq values are unique '
  'and totally ordered relative to each other but arbitrary relative to '
  'when they were actually written. Not a replacement for `id` as primary '
  'key/cursor token (UUIDv7 stays opaque and unguessable for that role) — '
  'this column exists ONLY to give ordering reads a tie-break that cannot '
  'lie under load, for post-migration rows.';
