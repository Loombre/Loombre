-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: 0036_admin_list_indexes.sql
--
-- Audit fafa47f Fix Wave 6 (lane FW6-F): closes AUD-A8b-001, AUD-A8b-002,
-- and AUD-V2-M3 (validated/V2.md). Two admin list endpoints shipped without
-- the covering index plan §6.2 requires ("every list-endpoint access path
-- has a covering index reviewed at PR time"), and two 0001/0002-era indexes
-- are strict column-prefixes of their own tables' UNIQUE constraint indexes.
--
-- Method note: numbers below were measured with EXPLAIN (ANALYZE, BUFFERS)
-- against a dedicated evidence database on the dev postgres:18 container
-- (schema = migrations 0001–0035, seed.mjs + seed-large.mjs's 50k movies,
-- plus 100k synthetic probe/image jobs rows and provider_ids rows marking
-- 80% of the movies matched — the "one jobs row per scanned file, never
-- pruned" growth profile AUD-A8b-001 documents). Warm cache, this hardware.
--
-- ============================================================================
-- AUD-A8b-001: GET /admin/jobs had NO supporting index — sequential scan +
-- sort on every page, on a table that grows one row per scanned/probed/
-- imaged file with no retention. The only audit finding that gets worse on
-- its own over time.
-- ============================================================================
--
-- listJobsAdmin (packages/db/src/query/admin.ts) is an UNFILTERED keyset
-- list ordered by (created_at_ms DESC, id DESC). Neither existing index
-- serves it: jobs_status_priority_idx leads with status (no status
-- predicate exists on this path) and jobs_pkey is (id). Measured @ 100k
-- jobs rows: page 1 was a Parallel Seq Scan + top-N heapsort, 1379 buffers,
-- 12.1ms -> with this index a plain ordered Index Scan, 6 buffers, 0.045ms
-- (planner-preferred, no enable_seqscan coaxing).
--
-- The same fix wave switches listJobsAdmin's cursor from the OR-form
-- keyset comparison to the ROW() form (catalog-detail.ts's established
-- pattern) — measured @ the ~row-50,000 cursor, the OR-form was applied as
-- a per-row Filter even WITH this index (50,001 rows removed by filter,
-- 918 buffers, 5.4ms); the ROW() form lands as an Index Cond b-tree seek
-- (4 buffers, 0.022ms, flat regardless of page depth).

CREATE INDEX jobs_created_at_keyset_idx ON jobs (created_at_ms DESC, id DESC);

COMMENT ON INDEX jobs_created_at_keyset_idx IS
  'AUD-A8b-001: keyset index for the unfiltered GET /admin/jobs ledger '
  'list (packages/db/src/query/admin.ts listJobsAdmin, also polled by the '
  'desktop IPC bridge''s listRecentJobs). Orders by (created_at_ms, id) '
  'with no leading filter column — jobs_status_priority_idx cannot serve '
  'this path because it leads with status. DESC matches the only order '
  'this query ever issues, so the scan streams without a sort node. '
  'Measured @ 100k rows: page 1 seq-scan+sort 12.1ms/1379 buffers -> '
  'index scan 0.045ms/6 buffers; deep-page ROW() cursor seek 0.022ms.';

-- ============================================================================
-- AUD-A8b-002: GET /admin/libraries/{id}/unmatched lost its keyset
-- index-order because item_type is a 4-value IN().
-- ============================================================================
--
-- listUnmatchedLibraryItemsForViewer filters one library to the four
-- enrichable item types (movie/series/artist/album) and orders by
-- (added_at_ms DESC, id DESC). 0021's header records the planner
-- limitation that bites here: a btree serves col IN (...) but only
-- preserves index ORDER on trailing columns when the multi-value predicate
-- binds EXACTLY ONE value. 0009's (library_id, item_type, added_at_ms,
-- id) composite therefore stops preserving order the moment item_type is
-- a 4-value IN(), and the plan grows an explicit Sort (measured @ 50k
-- items: an Incremental Sort over a content_class-index walk, 20.3ms,
-- 3425 buffers, with the true "unmatched" selectivity invisible to the
-- planner ahead of the NOT EXISTS).
--
-- The fix applies 0021's own remedy to this shape: take the multi-value
-- column OUT of the key columns and pin it in a partial predicate instead.
-- Unlike 0021's case, library_id CAN lead here — this endpoint is
-- per-library, so the leading predicate is always a single-value equality
-- (never the multi-value ANY() that made 0021 drop library_id). The four
-- enrichable types become the partial WHERE; (added_at_ms DESC, id DESC)
-- stay the only real order columns. Measured @ 50k items (10k unmatched):
-- the Sort node is GONE — an ordered Index Scan feeds the anti-join and
-- Limit directly, and the deep-page ROW() cursor (switched in admin.ts in
-- this same wave) is an Index Cond seek (0.073ms).
--
-- SYNC INVARIANT: the type list below mirrors ENRICHABLE_ITEM_TYPES in
-- packages/db/src/query/admin.ts (which itself mirrors the metadata
-- consumer's enrichable set). If a type is ever added there, this partial
-- predicate must be widened in a new migration or the planner will
-- silently fall back to sort-based plans for the wider IN() (predicate
-- implication fails, the index is simply not used — wrong plans, never
-- wrong rows).

CREATE INDEX catalog_items_library_added_enrichable_idx
  ON catalog_items (library_id, added_at_ms DESC, id DESC)
  WHERE item_type IN ('movie', 'series', 'artist', 'album');

COMMENT ON INDEX catalog_items_library_added_enrichable_idx IS
  'AUD-A8b-002: keyset index for GET /admin/libraries/{id}/unmatched '
  '(admin.ts listUnmatchedLibraryItemsForViewer, the Fix Match panel). '
  'PARTIAL on the four enrichable item types so the multi-value IN() '
  'lives in the predicate, not the key columns — Postgres only preserves '
  'index order past a multi-value IN() key column when it binds one value '
  '(0021''s documented limitation; here library_id leads legitimately '
  'because this per-library endpoint always binds it to exactly one '
  'value). MUST stay in sync with admin.ts ENRICHABLE_ITEM_TYPES — see '
  'migration 0036''s sync-invariant note. Measured @ 50k items/10k '
  'unmatched: Incremental Sort eliminated, ordered index scan feeds '
  'LIMIT directly; deep-page ROW() cursor seeks in 0.073ms.';

-- ============================================================================
-- AUD-V2-M3: two redundant indexes, each a strict column-prefix of its own
-- table's UNIQUE constraint index — pure write/storage overhead.
-- ============================================================================
--
-- A btree serves any query that filters on a prefix of its columns, so:
--   * images_entity_idx (entity_type, entity_id, kind) is fully subsumed
--     by the UNIQUE (entity_type, entity_id, kind, width) constraint index
--     from the same 0001 CREATE TABLE. Every real reader filters on
--     (entity_type, entity_id) only — verified across all six call sites
--     (packages/db/src/query/images.ts et al.), and EXPLAIN confirms the
--     lookup lands on images_entity_type_entity_id_kind_width_key with
--     both columns as Index Cond once the redundant index is gone.
--   * metadata_provenance_item_id_idx (item_id) is fully subsumed by
--     UNIQUE (item_id, field) from the same 0002 CREATE TABLE; the sole
--     reader (src/internal/provenance.ts) filters on item_id alone and is
--     served by metadata_provenance_item_id_field_key (EXPLAIN-confirmed).
-- Both tables are written by every scan/backfill; each drop removes one
-- whole btree's maintenance cost per write and returns its storage. No
-- behavior change — 0018's "index law" (land WITH the queries that need
-- them) applied retroactively to two pre-existing 0001/0002 indexes that
-- never had a query of their own.

DROP INDEX images_entity_idx;

DROP INDEX metadata_provenance_item_id_idx;
