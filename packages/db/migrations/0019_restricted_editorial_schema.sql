-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0019_restricted_editorial_schema
--
-- Additive-only (mirrors 0002/.../0018's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations. The one constraint
-- REPLACEMENT below (item_tags_kind_check) strictly WIDENS an enum-like
-- CHECK — every previously-legal row stays legal — which is the same
-- additive spirit as 0004's unique-constraint replacement.
--
-- Stash SQLite metadata sync (STATE.md mission "Stash SQLite metadata sync
-- + dedicated Restricted Content surface"), shared editorial schema —
-- authored by the ORCHESTRATOR (not a lane) because Lanes B (mapping),
-- C (sync), and D (zone surface) all build against these shapes in
-- parallel worktrees; landing the DDL first removes every cross-lane
-- schema dependency (STATE.md K8 as amended). Rulings implemented here:
--
--   K2  — tags gain an entity-level `kind` (general | genre | studio):
--         studios are first-class VIA the tags mechanism (S6), no new
--         entity table; the EDGE-level item_tags.kind CHECK widens to
--         admit 'studio' edges.
--   S5  — tags gain `parent_tag_id`: Stash preserves tag hierarchy as a
--         parent link; we keep exactly that (a single optional parent),
--         not a new hierarchy table.
--   K1  — movie_details gains `premiere_at_ms`: scenes are item_type
--         'movie' rows and no premiere-date column existed for
--         movie-shaped items (catalog_items.year stays the denormalized
--         year, as for every movie).
--   K3  — person_attributes: the S5 performer metadata (aliases,
--         birthdate, country, measurements) has no home — item_attributes
--         FKs catalog_items and people carry only name + content_class.
--         Mirrors item_attributes exactly (namespaced sandbox, core code
--         never reads it, JSONB values whitelisted BY ANALOGY to plan
--         §6.3's item_attributes entry — flagged Open for owner sign-off
--         in STATE.md).
--   K9  — chapter_markers: Stash scene markers become chapters. The
--         mission brief said "seconds"; house law (CLAUDE.md invariant 5,
--         milliseconds everywhere) wins — `start_ms`, converted at map
--         time. Content-agnostic table: `source` is CHECK-constrained to
--         the writers that actually exist ('stash' today), widened
--         additively when another producer appears.
--   K15 — library_stash_connections gains `genre_tag_names`: S6's
--         admin-configurable "which Stash tags map to genre vs general".
--         NULL = the documented default heuristic (Lane B's mapper owns
--         and documents it); a non-NULL array is an explicit admin list.

-- ============================================================================
-- tags: entity-level kind + hierarchy parent (K2, S5/S6)
-- ============================================================================

ALTER TABLE tags
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'general'
    CONSTRAINT tags_kind_check CHECK (kind IN ('general', 'genre', 'studio'));

ALTER TABLE tags
  ADD COLUMN parent_tag_id UUID NULL REFERENCES tags(id) ON DELETE SET NULL;

COMMENT ON COLUMN tags.kind IS
  'Entity-level kind (K2/S6): ''general'' (default — every pre-existing '
  'row), ''genre'', or ''studio''. Studios are first-class VIA tags: a '
  'studio is a kind=studio tag with its logo in `images` (entity_type '
  '''tag''), so studio browse/filter is tag-filtering the ViewerContext '
  'guard already scopes — deliberately NOT a new entity table. Distinct '
  'from item_tags.kind, which classifies one EDGE (how a tag applies to '
  'one item); this column classifies the tag itself (what kind of thing '
  'it names). The pair is deliberately redundant for genre/studio edges '
  '(a kind=studio tag attaches via kind=studio edges) — the edge kind '
  'keeps per-item queries index-local, the entity kind gives '
  'studio/genre PAGES a direct scan without a join through item_tags.';

COMMENT ON COLUMN tags.parent_tag_id IS
  'S5: Stash tag hierarchy, preserved as a single optional parent link '
  '(exactly what Stash''s schema provides — parent/child tag relations). '
  'ON DELETE SET NULL: deleting a parent orphans children back to roots, '
  'never cascades a subtree away. NULL for every non-Stash tag today; '
  'general metadata providers do not write it.';

-- Studio/genre pages scan tags by kind directly (Lane D's zone queries);
-- partial because the overwhelming majority of rows are kind='general'
-- and a full index would be mostly the default value.
CREATE INDEX tags_kind_idx ON tags (kind, content_class) WHERE kind <> 'general';

COMMENT ON INDEX tags_kind_idx IS
  'Partial (kind <> ''general''): the studios/genres working set for the '
  'restricted zone''s studio rails/pages and genre filters (S9). '
  'content_class second so the guard''s class filter stays in the index '
  'condition. Kind=''general'' rows (the vast majority) are deliberately '
  'unindexed — nothing queries "all general tags by kind".';

-- Child lookup for hierarchy display; partial for the same
-- mostly-NULL reason as stash_scene_links'' partial indexes (0018).
CREATE INDEX tags_parent_tag_id_idx ON tags (parent_tag_id) WHERE parent_tag_id IS NOT NULL;

-- ============================================================================
-- item_tags: admit 'studio' edges (K2)
-- ============================================================================

ALTER TABLE item_tags DROP CONSTRAINT item_tags_kind_check;
ALTER TABLE item_tags
  ADD CONSTRAINT item_tags_kind_check CHECK (kind IN ('genre', 'tag', 'studio'));

COMMENT ON COLUMN item_tags.kind IS
  'Edge-level classification of how this tag applies to this item: '
  '''genre'' (provider genres), ''tag'' (free-form tags), ''studio'' '
  '(K2 — the item''s studio attribution; the referenced tag row carries '
  'tags.kind=''studio''). Widened from (genre|tag) by migration 0019 — '
  'strictly additive, every pre-0019 row remains legal.';

-- ============================================================================
-- movie_details: editorial premiere date (K1)
-- ============================================================================

ALTER TABLE movie_details ADD COLUMN premiere_at_ms BIGINT NULL;

COMMENT ON COLUMN movie_details.premiere_at_ms IS
  'Editorial premiere/release date, epoch ms (K1). For Stash-synced '
  'scenes this is Stash''s scene `date` (S5 — Stash is authoritative for '
  'EDITORIAL facts); catalog_items.year stays the denormalized year '
  'derived from it, exactly as year is handled for every other movie '
  'source. NULL for the many items whose sources carry no full date — '
  'consumers fall back to catalog_items.year.';

-- ============================================================================
-- person_attributes (K3)
-- ============================================================================

CREATE TABLE person_attributes (
  id        UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     JSONB NOT NULL,
  UNIQUE (person_id, namespace, key)
);

COMMENT ON TABLE person_attributes IS
  'Person-scoped twin of item_attributes (K3): a namespaced extension '
  'sandbox for facts about a PERSON that the typed people schema does '
  'not model (S5: performer aliases, birthdate, country, measurements '
  'under the stash: namespace). Same law as item_attributes: core code '
  'never reads this table — only the namespaced feature that owns a '
  'namespace does. JSONB `value` is a whitelist extension BY ANALOGY to '
  'plan §6.3''s item_attributes entry, flagged Open for owner sign-off '
  'in STATE.md. The person''s content_class (on people) already scopes '
  'guard visibility — attributes ride the person, so no class column '
  'here.';

-- ============================================================================
-- chapter_markers (K9/S7)
-- ============================================================================

CREATE TABLE chapter_markers (
  id       UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  item_id  UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  title    TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  source   TEXT NOT NULL CHECK (source IN ('stash'))
);

COMMENT ON TABLE chapter_markers IS
  'Chapter markers for an item''s timeline (S7): Stash scene markers '
  'today (source=''stash'', written wholesale-replace per sync by Lane '
  'B''s mapper), rendered as player chapter ticks + a chapter list and '
  'deep-linkable start offsets. Content-agnostic on purpose — a future '
  'general-content chapter producer widens the source CHECK additively. '
  'start_ms not seconds: K9, CLAUDE.md invariant 5 (Stash''s REAL '
  'seconds are converted at map time). No uniqueness on (item_id, '
  'start_ms): two markers at the same offset are legal in Stash and '
  'preserved verbatim.';

-- The player + scene-detail read path: all markers for one item, ordered
-- by offset — the composite makes that an index-only ordered scan.
CREATE INDEX chapter_markers_item_start_idx ON chapter_markers (item_id, start_ms);

COMMENT ON INDEX chapter_markers_item_start_idx IS
  'The one read path (S7): GET chapters for an item, ordered by '
  'start_ms. Guard visibility rides the owning item (applyGuardToJoined '
  'on item_id), same pattern as item_tags/item_people.';

-- ============================================================================
-- library_stash_connections: genre mapping config (K15/S6)
-- ============================================================================

ALTER TABLE library_stash_connections ADD COLUMN genre_tag_names TEXT[] NULL;

COMMENT ON COLUMN library_stash_connections.genre_tag_names IS
  'S6/K15: which Stash tag names map to Loombre genre (kind=genre) '
  'rather than general tags. NULL = the default heuristic (owned + '
  'documented by the Stash mapper in apps/worker/src/stash/) — an '
  'explicit admin-saved array replaces the heuristic wholesale. Names, '
  'not ids: Stash tag ids are meaningless outside one SQLite file, and '
  'admins reason in names.';
