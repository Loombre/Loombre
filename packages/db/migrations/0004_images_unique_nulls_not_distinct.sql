-- SPDX-License-Identifier: AGPL-3.0-only
-- ============================================================================
-- Loombre migration 0004 — images unique key treats NULL width as a value
-- ============================================================================
-- The images unique key (entity_type, entity_id, kind, width) uses width NULL
-- for the stored original (variants carry real widths). Under SQL's default
-- NULLS DISTINCT semantics two "original" rows for the same entity/kind never
-- conflict, so upsertImage's ON CONFLICT silently inserts a duplicate original
-- on every re-run of an image job. NULLS NOT DISTINCT (Postgres 15+) makes the
-- original a real upsert target; ON CONFLICT (…) matches the rebuilt index.

ALTER TABLE images
  DROP CONSTRAINT images_entity_type_entity_id_kind_width_key;

ALTER TABLE images
  ADD CONSTRAINT images_entity_type_entity_id_kind_width_key
  UNIQUE NULLS NOT DISTINCT (entity_type, entity_id, kind, width);
