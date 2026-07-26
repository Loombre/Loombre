-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0003_media_files_version_label
--
-- Additive-only (mirrors 0002's discipline): no column drops, no type
-- narrowing, no rewriting of prior migrations.
--
-- Adds media_files.version_label (deliverable A, "Multi-version/editions"):
-- when the scanner parses two files in the SAME library that resolve to the
-- same catalog item (same title+year for a movie, same season+episode for
-- an episode, etc. — see apps/worker/src/scan/scanner.ts's find-or-create
-- logic), both media_files rows point at the SAME catalog_items row instead
-- of creating a duplicate item, and this column distinguishes them for
-- display: an edition string from the movie parser ("Director's Cut", "4K")
-- or a multi-part label ("part 1", "part 2") for cd1/cd2-style rips. NULL
-- for the common case of exactly one file per item.

ALTER TABLE media_files ADD COLUMN version_label TEXT NULL;

COMMENT ON COLUMN media_files.version_label IS
  'Distinguishes multiple media_files rows that share the same catalog item '
  '(multi-version/editions and multi-part files, docs/PLAN.md §8.1): an '
  'edition string ("Director''s Cut", "4K") or a part label ("part 1", '
  '"part 2"). NULL when the item has exactly one file.';
