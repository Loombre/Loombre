-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0049_catalog_items_metadata_auto_match
--
-- Additive-only: one nullable-free boolean column with a default, no drops,
-- no type narrowing, no rewriting of prior migrations, no contract surface
-- beyond the admin clear-match operation that sets it.
--
-- WHY (owner ruling 2026-09-07: "allow the user to clear the metadata on
-- wrong matches via the UI"). Clearing a wrong match returns an item to
-- the unmatched set — and the automatic sweep (metadata-refresh, scope
-- unmatched: a provider key saved, a provider newly enabled) would then
-- re-run the same search and pick the same wrong candidate before the
-- admin gets to Fix Match. This flag records the admin's intent: false =
-- "do not auto-match this item again"; a forced match (Fix Match apply)
-- sets it back to true. New items default to true.

ALTER TABLE catalog_items
  ADD COLUMN metadata_auto_match BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN catalog_items.metadata_auto_match IS
  'false after an admin cleared a wrong provider match (POST /admin/items/'
  '{id}/clear-match): the automatic unmatched sweep skips the item until a '
  'forced match (Fix Match apply) sets it true again.';
