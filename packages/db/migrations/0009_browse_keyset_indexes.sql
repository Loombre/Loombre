-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: 0009_browse_keyset_indexes.sql
--
-- Covering indexes for listCatalogItems' keyset pagination (plan §6.2:
-- "every list-endpoint access path has a covering index reviewed at PR
-- time" — the sort/order params landed in the gap-closure pass without
-- these, caught by the ENFORCING perf-t0 CI job's first run: browse p95
-- 209.8ms > 100ms budget @ 50k items on the ubuntu runner).
--
-- EXPLAIN before this migration: the planner picks
-- catalog_items_library_type_idx (library_id, item_type), then FILTERS
-- AND SORTS the library's entire row set ("Rows Removed by Filter:
-- 50000") on EVERY page request. With these composite indexes the scan
-- streams already-ordered rows and stops at LIMIT.
--
-- Only the two NOT-NULL sorts are covered here ('added' — the default
-- browse path the perf budget measures — and 'title'). The nullable
-- 'rating'/'year' sorts use order-dependent COALESCE-sentinel
-- expressions (see catalog-detail.ts sortKeyExpr) that would need four
-- expression indexes or a query redesign — logged as Open in STATE.md,
-- not silently skipped.

CREATE INDEX catalog_items_library_type_added_keyset_idx
  ON catalog_items (library_id, item_type, added_at_ms DESC, id DESC);

COMMENT ON INDEX catalog_items_library_type_added_keyset_idx IS
  'Keyset browse, default sort=added: listCatalogItems orders by '
  '(added_at_ms, id) within a library_id + item_type prefix '
  '(packages/db/src/query/catalog-detail.ts). DESC matches the default '
  'order so the scan streams without a sort node.';

CREATE INDEX catalog_items_library_type_title_keyset_idx
  ON catalog_items (library_id, item_type, sort_title, id);

COMMENT ON INDEX catalog_items_library_type_title_keyset_idx IS
  'Keyset browse, sort=title: same shape for the (sort_title, id) '
  'keyset. ASC index serves both directions (backward scan for desc).';
