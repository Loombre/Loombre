-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0018_stash_provider_core
--
-- Additive-only (mirrors 0002/.../0017's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Stash SQLite metadata sync (STATE.md mission "Stash SQLite metadata sync
-- + dedicated Restricted Content surface", kicked off 2026-08-01), Lane A
-- (provider core). Three tables, pre-assigned this migration number (K8,
-- to avoid parallel-lane collisions with Lane B's 0019/Lane C's 0020/Lane
-- E's 0021):
--
--   library_stash_connections — one row per library that has a Stash
--     SQLite database attached (S1: first-party, restricted-scoped
--     provider). Config (sqlite_path, admin enabled/disabled) plus the
--     LAST OBSERVED connection outcome (status/last_seen_schema_version/
--     timestamps) — apps/worker/src/stash/connect.ts (Lane A) writes the
--     status columns every time it attempts to open the Stash database;
--     apps/server's future admin surface (Lane D) writes sqlite_path/
--     enabled/path mappings.
--
--   library_path_mappings — S4's "per-library path-mapping table (Stash
--     path prefixes <-> Loombre mount view)". Shape imitates migrations/
--     0015_library_provider_chains.sql's library_provider_entries: an
--     ordered list of rows per library, `position` for admin display
--     order (packages/shared/src/stash-path-mapping.ts's matching
--     algorithm is LONGEST-PREFIX-WINS, independent of `position` —
--     position is stored ordering only, never matching precedence).
--
--   stash_scene_links — the matching backbone (S4): one row per Stash
--     scene EVER SEEN during an inventory/sync pass for a library,
--     regardless of whether it has been matched to a Loombre catalog
--     item. `item_id IS NULL` is the documented "unmatched, visible by
--     construction" state (S4's "unmatched Stash scenes AND unmatched
--     Loombre files land VISIBLY" — the Loombre-file half of that
--     visibility is a plain LEFT JOIN against media_files in the
--     preview query below, needing no schema of its own). K10: the
--     SERVER never opens the Stash SQLite file directly — this table is
--     what lets an admin "N of M matched" preview be pure SQL over
--     already-stored Stash facts (packages/db/src/query/stash-inventory.ts's
--     computePathMappingMatchPreview) rather than a live SQLite read.

-- ============================================================================
-- library_stash_connections
-- ============================================================================

CREATE TYPE stash_connection_status AS ENUM (
  'never_connected',
  'ok',
  'unsupported_schema',
  'unreachable'
);

CREATE TABLE library_stash_connections (
  id                       UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id               UUID NOT NULL UNIQUE REFERENCES libraries(id) ON DELETE CASCADE,
  sqlite_path              TEXT NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  status                   stash_connection_status NOT NULL DEFAULT 'never_connected',
  status_detail            TEXT NULL,
  last_seen_schema_version INT NULL,
  last_connected_at_ms     BIGINT NULL,
  last_checked_at_ms       BIGINT NULL,
  created_at_ms            BIGINT NOT NULL,
  updated_at_ms            BIGINT NOT NULL
);

COMMENT ON TABLE library_stash_connections IS
  'One row per library with a Stash SQLite database attached (S1). '
  'UNIQUE(library_id) enforces "one per library" (K8) — a library either '
  'has no Stash connection configured (no row) or exactly one. Config '
  '(sqlite_path/enabled) is admin-written; the status columns are '
  'written by apps/worker/src/stash/connect.ts (Lane A) every time it '
  'attempts to open this library''s Stash database — this table is the '
  'durable record of the LAST OBSERVED outcome, not a live probe.';

COMMENT ON COLUMN library_stash_connections.sqlite_path IS
  'Filesystem path to the Stash SQLite database file, as seen from the '
  'WORKER process (the server never opens this file directly — K10). '
  'No CHECK on existence/readability here — that is verified empirically '
  'at connect time, not at config-write time (the path may reference a '
  'not-yet-mounted volume).';

COMMENT ON COLUMN library_stash_connections.enabled IS
  'Admin intent: whether this connection should be used at all (attach/ '
  'detach without deleting the row, preserving sqlite_path + path '
  'mappings). Independent of `status` — an admin can leave a connection '
  'enabled while its last observed status is ''unreachable'' (a mount '
  'that will come back), or disable a connection that is currently ''ok'' '
  '(a deliberate pause).';

COMMENT ON COLUMN library_stash_connections.status IS
  'The LAST OBSERVED outcome of opening this Stash database (S2/S3): '
  '''never_connected'' (the default — configured but never attempted, or '
  'a fresh row), ''ok'' (opened, schema version within the supported '
  'range), ''unsupported_schema'' (S3 — schema version outside the '
  'pinned supported range; the provider disables itself and '
  'status_detail carries the exact admin notice), ''unreachable'' (S2 — '
  'every open attempt, including the WAL-locked retry and snapshot-copy '
  'fallback, failed — e.g. the path does not exist, the volume is '
  'unmounted, or the file remained locked past the retry budget).';

COMMENT ON COLUMN library_stash_connections.status_detail IS
  'Human-readable detail for the current `status` — for '
  '''unsupported_schema'' this is the EXACT S3 notice string ("Stash '
  'schema vNN unsupported; supported: X-Y"), mirrored verbatim into the '
  '`stash.provider.disabled` event payload''s `notice` field (K12). NULL '
  'for ''ok''/''never_connected''.';

COMMENT ON COLUMN library_stash_connections.last_seen_schema_version IS
  'The Stash `schema_migrations` version observed at the most recent '
  'connect attempt, regardless of whether it was in the supported range '
  '— kept even when `status = ''unsupported_schema''` so the admin '
  'notice and this row agree on which version was seen.';

-- ============================================================================
-- library_path_mappings
-- ============================================================================

CREATE TABLE library_path_mappings (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id     UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  stash_prefix   TEXT NOT NULL,
  loombre_prefix TEXT NOT NULL,
  position       INT NOT NULL,
  CONSTRAINT library_path_mappings_position_unique UNIQUE (library_id, position)
);

COMMENT ON TABLE library_path_mappings IS
  'S4 per-library path-mapping table: Stash path prefixes <-> Loombre '
  'mount view. Shape imitates migrations/0015_library_provider_chains.sql''s '
  'library_provider_entries (UNIQUE(library_id, position), gaps legal, '
  'never renumbered). Matching itself (packages/shared/src/'
  'stash-path-mapping.ts''s rewriteStashPath) is LONGEST-PREFIX-WINS over '
  'ALL of a library''s mappings, not position-ordered precedence — '
  '`position` here is admin DISPLAY order only.';

COMMENT ON COLUMN library_path_mappings.stash_prefix IS
  'Path prefix as Stash reports it (e.g. Stash running on a different '
  'host/container that sees the same media at a different mount point). '
  'Compared case-sensitively, segment-boundary-matched — see '
  'stash-path-mapping.ts''s header for the exact matching rules.';

COMMENT ON COLUMN library_path_mappings.loombre_prefix IS
  'The equivalent prefix under Loombre''s own mount view — the rewritten '
  'path (stash_prefix replaced by this) is what gets matched against '
  'media_files.path (S4 primary match).';

-- ============================================================================
-- stash_scene_links
-- ============================================================================

CREATE TABLE stash_scene_links (
  id                  UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id          UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  stash_scene_id      TEXT NOT NULL,
  stash_path          TEXT NOT NULL,
  stash_oshash        TEXT NULL,
  stash_size_bytes    BIGINT NULL,
  stash_updated_at_ms BIGINT NULL,
  item_id             UUID NULL REFERENCES catalog_items(id) ON DELETE SET NULL,
  matched_by          TEXT NULL CHECK (matched_by IN ('path', 'oshash')),
  stale               BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at_ms   BIGINT NOT NULL,
  CONSTRAINT stash_scene_links_library_scene_unique UNIQUE (library_id, stash_scene_id)
);

COMMENT ON TABLE stash_scene_links IS
  'The S4 matching backbone: one row per Stash scene EVER SEEN by an '
  'inventory/sync pass for a library (K10) — populated by apps/worker''s '
  'Stash adapter, never by a live server-side SQLite read. '
  '`item_id IS NULL` is the documented "unmatched, visible by '
  'construction" state (S4) — this table is never pruned down to only '
  'matched rows, so an admin can always see every Stash scene the '
  'inventory pass found, matched or not. UNIQUE(library_id, '
  'stash_scene_id): a Stash scene id is only unique within the one '
  'SQLite database a library is attached to, never globally.';

COMMENT ON COLUMN stash_scene_links.stash_scene_id IS
  'Stash''s own scene identifier, stored as TEXT (mirrors '
  'provider_ids.external_id''s "provider''s own id, as a string" '
  'convention — apps/worker/src/metadata/providers/stash.ts addresses a '
  'ProviderRef.externalId as "<libraryId>:<stashSceneId>", see that '
  'file''s header) — never assumed numeric, in case a future Stash '
  'schema version changes its id representation.';

COMMENT ON COLUMN stash_scene_links.stash_path IS
  'The Stash-reported file path for this scene, UNMAPPED (raw, as Stash '
  'itself stores it) — computePathMappingMatchPreview (packages/db/src/'
  'query/stash-inventory.ts) applies a library''s current path mappings '
  'to this value at query time, so changing a mapping never requires '
  're-running the inventory pass before the preview reflects it.';

COMMENT ON COLUMN stash_scene_links.stash_oshash IS
  'Stash''s 64KB head/tail oshash for the scene''s primary file, when '
  'Stash has one on record. NULL is common and not an error — S4''s '
  'secondary match only computes Loombre''s own oshash LAZILY, for '
  'candidates that fail the primary path-mapped match, so a row is '
  'never required to carry this to be useful.';

COMMENT ON COLUMN stash_scene_links.item_id IS
  'The matched Loombre catalog item, or NULL when unmatched. '
  'ON DELETE SET NULL (not CASCADE): deleting a catalog item must not '
  'delete Stash''s knowledge that the scene exists — it reverts to '
  'unmatched (visible again) rather than disappearing, so a rescan/'
  'rematch can re-attach it without a fresh inventory pass.';

COMMENT ON COLUMN stash_scene_links.matched_by IS
  'Which S4 tier produced the current `item_id` match — ''path'' '
  '(primary: path-mapped Stash path equals a media_files.path exactly) '
  'or ''oshash'' (secondary: size + oshash fallback for candidates the '
  'path tier missed). NULL when `item_id IS NULL`.';

COMMENT ON COLUMN stash_scene_links.stale IS
  'S8 (Lane C): set TRUE when a later sync no longer sees this scene in '
  'Stash (a Stash-side deletion) — the row and its match are KEPT '
  '(never destructive, provenance-flagged, admin-filterable) rather than '
  'deleted. Lane A creates the column; Lane C''s sync engine is the only '
  'writer that ever sets it TRUE.';

-- ============================================================================
-- indexes (index law: land WITH the tables/queries that need them)
-- ============================================================================

-- computePathMappingMatchPreview (packages/db/src/query/stash-inventory.ts)
-- and the future admin "unmatched scenes" panel both filter
-- stash_scene_links by library_id first, then either read stash_path (to
-- rewrite + compare against media_files.path) or filter on item_id IS
-- NULL — the UNIQUE(library_id, stash_scene_id) constraint above already
-- gives an index usable for the plain library_id-prefixed lookups, so no
-- separate library_id-only index is added (would be redundant with the
-- unique constraint's own index, which already leads with library_id).

-- Reverse lookup (catalog item -> its linked Stash scene, e.g. for a
-- per-item refresh or an admin "unlink" action) — partial, since most
-- catalog items are never Stash-linked and a full index would waste space
-- indexing millions of general-library NULLs at the owner's 33k+ scale
-- (STATE.md S10).
CREATE INDEX stash_scene_links_item_id_idx ON stash_scene_links (item_id) WHERE item_id IS NOT NULL;

-- The "N of M matched" preview's other join key: for a given library, list
-- every UNMATCHED scene's stash_path to rewrite+compare (K10). Partial on
-- item_id IS NULL for the same reason as above — this is the exact set
-- computePathMappingMatchPreview scans, so the partial index covers its
-- full working set instead of the whole table.
CREATE INDEX stash_scene_links_unmatched_idx ON stash_scene_links (library_id) WHERE item_id IS NULL;

COMMENT ON INDEX stash_scene_links_item_id_idx IS
  'Partial (item_id IS NOT NULL): reverse item -> scene lookup, e.g. a '
  'per-item metadata refresh resolving which stash_scene_links row backs '
  'an already-matched catalog item. Most rows at scale are unmatched or '
  'belong to non-restricted libraries, so a full index would be mostly '
  'NULLs.';

COMMENT ON INDEX stash_scene_links_unmatched_idx IS
  'Partial (item_id IS NULL): the exact working set of '
  'computePathMappingMatchPreview''s "unmatched" half and the future '
  'admin unmatched-scenes panel (S4''s "visible by construction" '
  'requirement) — scoped by library_id, EXPLAIN-verified in '
  'packages/db/test/stash-inventory.spec.ts to avoid a sequential scan '
  'at the owner''s 33k-scene scale (S10).';
