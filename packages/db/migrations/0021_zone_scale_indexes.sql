-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: 0021_zone_scale_indexes.sql
--
-- STATE.md Stash run (S10, K8-amended: Lane E owns 0021). EVIDENCE-DRIVEN —
-- Lane D measured EXPLAIN (ANALYZE, BUFFERS) against a 33k-scene synthetic
-- restricted library ("Zone Scale 33k": 2000 performers, 150 studios, 40
-- genres, 95% probed files, 70% premiere dates) and wrote up seven findings
-- (reports/stash/explain-findings-0021.md). Lane E re-seeded the SAME
-- fixture shape fresh on its own database (scratchpad/lane-e/seed-zone-33k.mjs,
-- explain-zone.mjs — both Lane D originals, re-run verbatim), then went
-- further and EXPLAIN'd the REAL compiled Kysely SQL the query modules
-- themselves emit (not just the hand-flattened harness), because the
-- harness's `= ANY($n::uuid[])` approximation of restricted-browse.ts's
-- `.where('library_id', 'in', restrictedLibraryIds)` clause turned out to
-- matter a great deal — see finding 1 below.
--
-- Method note for future re-measurement: this migration's numbers were
-- taken with the viewer entitled to TWO restricted libraries (the seed
-- fixture's small "Restricted" library plus "Zone Scale 33k") — i.e.
-- restrictedLibraryIds.length === 2, not 1. This matters (see finding 1);
-- re-measuring with a single-restricted-library viewer will look even
-- better and should not be mistaken for a regression.
--
-- ============================================================================
-- Finding 1 (root cause of the majority of T0 breaches, LANDED): no index
-- lets restricted-browse.ts's default/title sorts stream in order.
-- ============================================================================
--
-- restricted-browse.ts's guard applies TWO independent `library_id`
-- predicates: applyGuard()'s `library_id = ANY(ctx.allowedLibraryIds)`
-- (every library the viewer can see at all) AND this file's own
-- `.where('library_id', 'in', restrictedLibraryIds)` (just the viewer's
-- ENTITLED restricted libraries). migration 0009 already has
-- (library_id, item_type, added_at_ms DESC, id DESC) for the general browse
-- path, and it looks like it should serve this query too — but it doesn't,
-- for a Postgres-specific reason worth recording so nobody "fixes" this by
-- re-adding a library_id-leading composite:
--
--   Postgres's planner will use a btree index to serve `col = ANY(array)`/
--   `col IN (...)`, but it only preserves the index's ORDER on trailing
--   columns when the leading predicate binds to EXACTLY ONE value (proven
--   empirically: `library_id = ANY(ARRAY[oneUuid])` and `library_id IN
--   (oneUuid)` both drive a plain ordered Index (Only) Scan feeding LIMIT
--   directly; `library_id IN (twoUuids)` on the SAME index instead plans a
--   Bitmap/plain Index Scan FOLLOWED BY an explicit Sort node, which forces
--   the two leftJoinLateral subqueries (primary file, primary video stream)
--   to evaluate for every matched row BEFORE the sort discards down to
--   LIMIT 50 — the actual 33,000-times-instead-of-~50-times cost D's
--   finding described). A library_id-LEADING index therefore only pays off
--   when a viewer is entitled to exactly one restricted library; with two
--   (this migration's measured case) it provides zero benefit over what
--   0009 already has.
--
--   The fix: DROP library_id from the index key entirely and rely on the
--   `WHERE item_type = 'movie'` partial predicate (a single, constant
--   equality — never multi-valued) to anchor the scan, leaving
--   `added_at_ms DESC, id DESC` as the only real key columns and
--   `library_id` as a cheap per-row Filter (same shape 0009's own
--   (item_type, sort_title) index already uses successfully for the
--   general catalog's title sort, which is why sort=title was NEVER in
--   D's breach list — proven, not assumed, below).
--
-- Measured (33k synthetic + seed's own small "Restricted" library, this
-- hardware, warm cache — T0 will be slower; two-restricted-library viewer):
--
--   | Path                                  | Before    | After    |
--   |----------------------------------------|-----------|----------|
--   | browse sort=added page 1               | 253-290ms | 11-33ms  |
--   | browse sort=added deep keyset (~pg100)  | 249-253ms | 7-9ms    |
--   | browse resolution=FHD (default sort)    | 212-231ms | 7-11ms   |
--   | browse sort=title                       | 8-13ms    | 8-11ms   |  (never breached — 0009 already sufficient, no new index needed)
--
-- resolution-band filtering (finding 5) is fixed as a direct side effect:
-- it rides the same default added-sort path finding 1 fixes, and needs no
-- index of its own.

CREATE INDEX catalog_items_added_movie_idx
  ON catalog_items (added_at_ms DESC, id DESC)
  WHERE item_type = 'movie';

COMMENT ON INDEX catalog_items_added_movie_idx IS
  'S10/finding 1: restricted-browse.ts default sort=added (incl. the deep '
  'keyset ROW-comparison seek and resolution-band filtering, which ride '
  'the same path) and restricted-home.ts''s recentlyAddedInZone rail. '
  'Deliberately WITHOUT library_id as a key column — see this migration''s '
  'header for why a library_id-leading composite only helps a viewer '
  'entitled to exactly ONE restricted library (Postgres does not preserve '
  'index order across a multi-value IN()/ANY() leading predicate); '
  'library_id is left as a cheap per-row Filter instead, the same shape '
  '0009''s (item_type, sort_title) index already uses. PARTIAL on '
  'item_type=''movie'' (K1 — a "scene" IS a movie-shaped row): the zone '
  'never browses anything else, and general-catalog browse already has '
  '0009''s own composite. Measured (33k synthetic, two-restricted-library '
  'viewer, this hardware, warm cache): sort=added page 1 253-290ms -> '
  '11-33ms; deep keyset (~page 100) 249-253ms -> 7-9ms; resolution=FHD '
  'filter 212-231ms -> 7-11ms (finding 5, no index of its own needed). '
  'sort=title was measured and found to ALREADY be within budget (8-13ms) '
  'via 0009''s existing (item_type, sort_title) index — no zone-specific '
  'title index was added; D''s original writeup grouped title with added '
  'as a preventive suggestion, re-measurement shows it was never actually '
  'breaching.';

-- ============================================================================
-- Finding 2 (missing-file guard subplans, LANDED as a targeted assist):
-- ============================================================================
--
-- Every guarded read re-checks "does this item have at least one non-
-- missing media_files row" (guard.ts's missingFileClauseSql, two
-- correlated EXISTS/NOT EXISTS subqueries). On restricted-browse.ts's own
-- LIMIT-50 page this is negligible (finding 1's fix already bounds it to
-- ~50 probes). It is NOT negligible on the two aggregate rails
-- (restricted-home.ts's getTopStudiosInZone/getTopPerformersInZone,
-- finding 7) and the pre-reshape performer list (finding 6): those visit
-- every item behind every zone credit/tag edge (~33,000 items) to compute
-- a count, so the SAME two subqueries run ~33,000 times each. Confirmed by
-- EXPLAIN they were ALREADY using media_files_item_id_idx in correlated
-- (per-row Index Scan) form rather than a flat hash-scan (i.e. finding 2's
-- "did it flip?" condition was already true) — but 33,000 index probes on
-- a NON-partial index still cost real buffer traffic. The partial index
-- below (matching exactly what finding 2 pre-authorized) turns the
-- `missing_since_ms IS NULL` half into an Index-Only-Scan with no
-- per-row heap fetch or Filter recheck.
--
-- Measured effect on getRestrictedZoneHome (dominated by the two count-DESC
-- rails, finding 7): 165-245ms -> 146-192ms — a real but PARTIAL
-- improvement; the aggregate floor itself (finding 7, below) remains.

CREATE INDEX media_files_not_missing_item_id_idx
  ON media_files (item_id)
  WHERE missing_since_ms IS NULL;

COMMENT ON INDEX media_files_not_missing_item_id_idx IS
  'S10/finding 2: the "has a non-missing file" half of guard.ts''s '
  'missingFileClauseSql, isolated as its own partial index so the '
  'aggregate zone rails (restricted-home.ts''s top-studios/top-performers, '
  'restricted-performers.ts pre-reshape) don''t pay a Filter/heap-fetch '
  'per probe on top of the correlated index lookup they already do. '
  'Confirmed via EXPLAIN this does NOT fully close the aggregate rails'' '
  'breach (finding 7 — an inherent count-DESC floor); it is a real, '
  'measured assist (getRestrictedZoneHome 165-245ms -> 146-192ms), landed '
  'because finding 2 explicitly pre-authorized it for exactly this '
  '"didn''t fully flip to a cheap correlated form" case.';

-- ============================================================================
-- Findings 3/4/5: judged on re-measured numbers, NOT landed here.
-- ============================================================================
--
-- sort=rating (COALESCE(catalog_items.community_rating, sentinel)) and
-- sort=date (COALESCE(movie_details.premiere_at_ms, sentinel), a satellite-
-- table column reached via LEFT JOIN) both STILL BREACH after finding 1
-- lands (re-measured: sort=date 210-269ms, sort=rating 209-238ms — finding
-- 1's lateral-materialization fix does not apply to them, because their
-- ORDER BY key isn''t on catalog_items_added_movie_idx; each sort needs its
-- OWN ordering-capable index). rating COULD be expression-indexed
-- (COALESCE lives on catalog_items itself, same table as the finding-1
-- fix); date cannot be, cleanly, at all (the COALESCE spans a LEFT JOINed
-- satellite table). Migration 0009''s own header already declined this
-- exact category of fix for the GENERAL catalog''s rating/year sorts
-- ("would need four expression indexes or a query redesign — logged as
-- Open in STATE.md, not silently skipped") for the same sentinel-direction
-- reason (order=asc and order=desc need DIFFERENT sentinel values, so one
-- index does not cover both directions). This migration follows that same,
-- already-established house convention rather than inventing an
-- asymmetric one-off for the zone: NOT landed, logged OPEN in Lane E''s
-- report for owner sign-off alongside 0009''s pre-existing gap.
--
-- sort=duration (finding 4) is a per-item LATERAL-computed key (the
-- "primary file" resolution rule has no column to index) and stays a
-- confirmed breach after finding 1 (211-263ms, unchanged — finding 1 never
-- touched this path). The only real fix is denormalizing a
-- catalog_items.primary_duration_ms column, which is a WRITER change
-- (scanner probe path + apply.ts) outside this additive-migration lane''s
-- scope and explicitly flagged in STATE.md as owner-sign-off territory.
-- NOT implemented; logged OPEN.

-- ============================================================================
-- Finding 6 (performers list GroupAggregate, FIXED via query reshape, no
-- new index): restricted-performers.ts now keyset-pages `people` directly
-- on (name, id) with an EXISTS check (index-backed via the pre-existing
-- item_people_person_id_idx/people_name_idx — no migration needed) and
-- batches the scene-count for only the <=limit people a page returns,
-- instead of a GroupAggregate over every role=''performer'' credit row.
-- Measured: listRestrictedPerformers 149-163ms -> 7-13ms. See
-- packages/db/src/query/restricted-performers.ts''s header for the full
-- design note; existing leak.spec.ts cases (12c) prove the reshape did not
-- change visibility semantics.
-- ============================================================================

-- ============================================================================
-- Finding 7 (home rails' top-N-by-count aggregates): accepted, NOT
-- index-fixable, assisted by finding 2's index above but still breaching.
-- ============================================================================
--
-- restricted-home.ts's getTopStudiosInZone/getTopPerformersInZone order by
-- COUNT(...) DESC — unlike finding 6's alphabetical list, there is no
-- cheaper dimension to keyset-page on: the top-N-by-count is not knowable
-- until every matching edge has been counted (an inherent GroupAggregate
-- floor; confirmed by EXPLAIN — no plan exists that answers "which 10
-- studios have the most scenes" without visiting every studio/scene edge).
-- getRestrictedZoneHome remains a residual T0 breach after finding 2's
-- assist (146-192ms, budget 100ms). Per D''s own writeup this is a real,
-- accepted tradeoff, not a gap: the rail is fetched once per zone-home
-- visit (not per scroll/page), and the only further lever is a
-- clearance-digest-keyed cache with a short TTL (the same cache-key
-- primitive src/query/clearance.ts already exists for) — an architecture
-- change beyond an additive-index migration''s scope. Logged OPEN in Lane
-- E''s report for owner sign-off, exactly as D''s finding anticipated.
