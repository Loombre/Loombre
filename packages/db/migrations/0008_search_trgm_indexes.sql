-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0008_search_trgm_indexes
--
-- Additive-only (mirrors 0002/0003/0004/0006/0007's discipline): no column
-- drops, no type narrowing, no rewriting of prior migrations.
--
-- Gap-closure lane / perf exit-gate finding: searchCatalog
-- (packages/db/src/query/search.ts) breached the enforced p95 <=100ms
-- budget at the 50k-item seed (measured 147-159ms) — the person/tag
-- ILIKE '%q%' substring matches (item_people->people.name,
-- item_tags->tags.name) had no supporting index, so Postgres fell back to
-- a per-outer-row correlated-subquery scan (search.ts's own header already
-- flagged this as a documented Phase-1-scale tradeoff).
--
-- pg_trgm's GIN trigram index accelerates arbitrary substring ILIKE
-- matches (unlike a plain btree, which only helps prefix matches). Both
-- people.name and tags.name are CITEXT, not TEXT — CITEXT defines its OWN
-- `~~*`/`~~` (ILIKE/LIKE) operators distinct from the plain-text ones the
-- pg_trgm opclass registers strategies for, so an index built directly on
-- the citext column (`GIN (name gin_trgm_ops)`) is silently never chosen
-- by the planner for a `name ILIKE ...` query (verified empirically
-- against a 50k-row table: CREATE INDEX succeeds via citext's implicit
-- assignment cast to text, but EXPLAIN keeps choosing Seq Scan regardless
-- of table size). The fix is an EXPRESSION index on the explicit `::text`
-- cast, paired with search.ts casting the same way in its WHERE clause
-- (`people.name::text ILIKE ...` / `tags.name::text ILIKE ...`) so the
-- query's operator is the plain-text `~~*` the opclass actually supports.
-- Verified: Bitmap Index Scan, ~0.9ms vs ~14ms Seq Scan at 50k rows.
--
-- Phase-4 packaging note: `CREATE EXTENSION pg_trgm` requires the
-- extension to be present in the target Postgres install (bundled with
-- every mainstream distribution's contrib/postgresql-contrib package,
-- same tier as citext which 0001_init.sql already requires) — the
-- embedded-Postgres bundling decision (D1) must include contrib
-- extensions, not just core, when Phase 4 packages a zero-config install.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX people_name_trgm_idx ON people USING GIN ((name::text) gin_trgm_ops);
CREATE INDEX tags_name_trgm_idx ON tags USING GIN ((name::text) gin_trgm_ops);

COMMENT ON INDEX people_name_trgm_idx IS
  'Backs searchCatalog''s person-name ILIKE substring match '
  '(packages/db/src/query/search.ts) — expression index on name::text, '
  'see migration header for why a plain (name) index on this CITEXT '
  'column would never be chosen by the planner.';

COMMENT ON INDEX tags_name_trgm_idx IS
  'Backs searchCatalog''s tag-name ILIKE substring match '
  '(packages/db/src/query/search.ts) — same CITEXT/expression-index '
  'reasoning as people_name_trgm_idx.';
