-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0015_library_provider_chains
--
-- Additive-only (mirrors 0002/.../0014's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Loombre Plugin Protocol (LPP) v1, Lane W3 (LD10/LD12, locked at W1
-- landing — see STATE.md). Per-library metadata-provider chains: an
-- ordered list of provider "slots" a library resolves its metadata
-- provider fallback chain through at metadata-job time, each slot either a
-- BUILT-IN provider (packages/db has no knowledge of the built-in provider
-- registry — apps/worker/src/metadata/registry.ts owns that; `builtin_name`
-- is validated against it at resolution time, never here) or a registered
-- LPP plugin (`plugin_id` FK into migrations/0014_plugins.sql's `plugins`
-- table).
--
-- ABSENT ROWS for a library is the documented default: apps/worker's
-- metadata consumer falls back to the legacy hardcoded PROVIDER_CHAIN per
-- media kind verbatim (behavior-neutrality by construction — an untouched
-- library resolves the IDENTICAL chain it always has). This table is never
-- pre-populated for existing libraries by this migration.
--
-- No `media_kind` column: unlike the legacy PROVIDER_CHAIN (one array PER
-- media kind, shared across every library), a chain here is scoped to ONE
-- library, and a library already has exactly one `media_kind`
-- (migrations/0001_init.sql) — a library-scoped chain inherently serves
-- only that one kind, so there is nothing to key on.
--
-- C5 STRICT scoping (apps/server/src/plugins/scope.ts's tightened rule —
-- see that file's header for the full "restricted-scoped plugin => never
-- attaches outside a restricted target; general-scoped plugin => never
-- receives restricted data through ANY capability" statement): a `plugin`
-- slot's plugin.content_class must EQUAL the owning library's
-- content_class exactly. Enforced at WRITE time by
-- packages/db/src/query/library-provider-chains.ts's replaceLibraryProviderChain
-- (a real, independently-testable application-level check reading both
-- rows inside the same transaction — not expressible as a single-table
-- CHECK constraint, since it depends on the referenced plugins/libraries
-- rows' own columns) and re-checked at chain-RESOLUTION time and again at
-- LPP-adapter-construction time by apps/worker (defense in depth per the
-- mission's explicit "even under misconfiguration" requirement — three
-- independent layers, not one).
--
-- `plugin_id` is `ON DELETE CASCADE` (a lane decision, not spelled out
-- character-for-character by the locked schema text but the only sane
-- choice available): `provider_kind = 'plugin'` rows always carry a
-- non-null `plugin_id` (the XOR check below), so `ON DELETE SET NULL`
-- would leave a row violating that CHECK the instant its plugin is
-- removed. CASCADE instead — removing a plugin quietly drops it from
-- every chain that referenced it (a gap in `position`, not renumbered;
-- resolution reads `ORDER BY position ASC` and does not require
-- contiguous values) rather than blocking `removePluginAndEmit` or leaving
-- an orphaned/inconsistent row behind.

CREATE TYPE library_provider_kind AS ENUM ('builtin', 'plugin');

CREATE TABLE library_provider_entries (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  library_id     UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  position       INT NOT NULL,
  provider_kind  library_provider_kind NOT NULL,
  builtin_name   TEXT NULL,
  plugin_id      UUID NULL REFERENCES plugins(id) ON DELETE CASCADE,
  CONSTRAINT library_provider_entries_position_unique UNIQUE (library_id, position),
  CONSTRAINT library_provider_entries_kind_xor CHECK (
    (provider_kind = 'builtin' AND builtin_name IS NOT NULL AND plugin_id IS NULL) OR
    (provider_kind = 'plugin' AND plugin_id IS NOT NULL AND builtin_name IS NULL)
  )
);

COMMENT ON TABLE library_provider_entries IS
  'LPP v1 (Lane W3) per-library metadata-provider chain — one row per '
  'ordered slot. ABSENT rows for a library is the documented default: '
  'apps/worker''s metadata consumer falls back to the legacy hardcoded '
  'PROVIDER_CHAIN per media kind verbatim (behavior-neutrality by '
  'construction). Written only via '
  'packages/db/src/query/library-provider-chains.ts''s '
  'replaceLibraryProviderChain, which enforces the C5 STRICT '
  'content-class-equality rule at write time (see this migration''s header).';

COMMENT ON COLUMN library_provider_entries.position IS
  'Zero-based order within this library''s chain — resolution reads '
  '`ORDER BY position ASC`. UNIQUE per (library_id, position); gaps are '
  'legal (e.g. after a referenced plugin is removed via the CASCADE FK '
  'below) and never require renumbering the remaining rows.';

COMMENT ON COLUMN library_provider_entries.provider_kind IS
  'Which of the two slot kinds this row is — drives the XOR check below '
  'and which of builtin_name/plugin_id apps/worker''s chain-resolution '
  'reads to resolve this slot into an actual MetadataProvider.';

COMMENT ON COLUMN library_provider_entries.builtin_name IS
  'A built-in ProviderRegistry name (apps/worker/src/metadata/registry.ts '
  '— e.g. ''tmdb''/''tvdb''/''musicbrainz''), NOT NULL iff '
  'provider_kind=''builtin''. Unconstrained TEXT (no CHECK against a '
  'closed set): the built-in provider set is a TypeScript source of '
  'truth apps/worker owns, the same reasoning migrations/'
  '0013_server_settings.sql''s header gives for not CHECK-constraining '
  'server_settings.key. A name with nothing registered under it at '
  'resolution time is simply skipped (mirrors apps/worker/src/metadata/'
  'consumer.ts''s existing PROVIDER_CHAIN doc comment).';

COMMENT ON COLUMN library_provider_entries.plugin_id IS
  'FK into migrations/0014_plugins.sql''s plugins table, NOT NULL iff '
  'provider_kind=''plugin''. ON DELETE CASCADE — see this migration''s '
  'header for why SET NULL is not viable here (the XOR check would '
  'reject the resulting row) and why CASCADE (quietly drop the slot) is '
  'preferred over blocking plugin removal.';

CREATE INDEX library_provider_entries_plugin_id_idx ON library_provider_entries (plugin_id);
