-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0042_restricted_browse_rating_sort_indexes
--
-- LD-12 (STATE.md, comparative-architecture-study implementation run):
-- restricted-browse.ts's sort=rating gets two per-direction partial
-- expression indexes on catalog_items — closing the S10 "sort=rating is
-- CHEAPLY fixable... deliberately not landed because it reverses a
-- recorded 0009 decision" residue with an owner yes.
--
-- REVERSES migrations/0009_browse_keyset_indexes.sql's decision, WITH the
-- reason recorded at that decision's own site (0009's header comment now
-- points here) as this ledger's own rule requires. 0009 declined
-- rating/year sorts together, reasoning "would need four expression
-- indexes or a query redesign" (2 columns x 2 directions) and logged it
-- Open rather than landing it. This migration lands the narrower half of
-- that declined set: sort=rating ONLY (not year, not duration — those
-- stay open, see restricted-browse.ts's own S10 comment), and ONLY for
-- the restricted zone's catalog_items WHERE item_type='movie' slice (not
-- the general catalog listCatalogItems path 0009 was actually measuring)
-- — 2 indexes, not 4, because this migration does not also cover 'year'.
-- The "one index does not cover both directions" reasoning 0009 (and
-- 0021 after it) cited is still correct; it is answered here with two
-- direction-specific expression indexes rather than redesigned away.
--
-- MEASURED (R2 audit, 33k fixture, two-restricted-library viewer, same
-- hardware/warm-cache conditions 0021's own table used — evidence
-- transcribed verbatim from restricted-browse.ts's own S10 comment, which
-- predates this migration):
--   sort=rating order=desc: 238.7ms -> 7.4ms
--   sort=rating order=asc:  253.1ms -> 7.5ms
--   deep keyset (~page 21): 7.7ms
--   index size: ~1.3 MB each
--
-- The sentinel (-1 for desc, 11 for asc — packages/db/src/query/
-- restricted-browse.ts's RATING_LOW_SENTINEL/RATING_HIGH_SENTINEL) reaches
-- Postgres as a bound PARAMETER, not a literal, which would normally
-- defeat expression-index matching. It does not here, because
-- node-postgres issues unnamed statements and Postgres therefore plans
-- each one with the parameter's actual value (a custom plan). Anything
-- that changes that (naming/preparing these statements, or a future
-- plan_cache_mode=force_generic_plan) would silently un-match the index —
-- a re-measurement belongs in the SAME change as any such switch.
--
-- sort=date and sort=duration remain open (S10, restricted-browse.ts's
-- own comment): date's COALESCE lives on a LEFT JOINed satellite
-- (movie_details) and the planner does not choose the equivalent index
-- from a catalog_items-driven scan (measured: index present, unused,
-- 240.2ms -> 238.2ms); duration needs a catalog_items.primary_duration_ms
-- denormalization (a writer change across probe + apply), out of an
-- index-only migration's scope.
CREATE INDEX catalog_items_restricted_rating_desc_keyset_idx
  ON catalog_items ((COALESCE(community_rating, -1)) DESC, id DESC)
  WHERE item_type = 'movie';

COMMENT ON INDEX catalog_items_restricted_rating_desc_keyset_idx IS
  'Restricted-zone browse, sort=rating order=desc (packages/db/src/'
  'query/restricted-browse.ts''s sortKeyExpr): 238.7ms -> 7.4ms measured '
  '(33k fixture, R2 audit) -- LD-12, reverses 0009''s declined-rating-'
  'sort decision for this narrower (restricted-zone-only, rating-only) '
  'case. NULL community_rating sorts last via the -1 sentinel, matching '
  'RATING_LOW_SENTINEL.';

CREATE INDEX catalog_items_restricted_rating_asc_keyset_idx
  ON catalog_items ((COALESCE(community_rating, 11)) ASC, id ASC)
  WHERE item_type = 'movie';

COMMENT ON INDEX catalog_items_restricted_rating_asc_keyset_idx IS
  'Restricted-zone browse, sort=rating order=asc: 253.1ms -> 7.5ms '
  'measured (33k fixture, R2 audit) -- LD-12, see the desc index''s '
  'comment for the full decision-reversal reasoning. NULL '
  'community_rating sorts last via the 11 sentinel, matching '
  'RATING_HIGH_SENTINEL (ratings are 0-10, so 11 is always highest).';
