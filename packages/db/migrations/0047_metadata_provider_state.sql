-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0047_metadata_provider_state
--
-- Additive-only: one new table, no drops, no type narrowing, no rewriting
-- of prior migrations, no contract surface.
--
-- WHY. The worker resolves each keyed metadata provider's API key at boot
-- (env var, else the keyring entry the admin screen writes). "The provider
-- became enabled" is the moment every already-scanned, still-unmatched
-- item should be enriched — but without a record of what the worker saw
-- LAST boot it cannot tell "enabled, as always" from "enabled since the
-- operator added LOOMBRE_TMDB_API_KEY to loombre.env and restarted", and
-- re-enqueuing every unmatched item on every boot would turn each restart
-- into a provider search storm for titles the provider has already failed
-- to find. One row per keyed provider, written by the worker at boot and
-- by the refresh fan-out when it runs for that provider; read only by the
-- worker's boot comparison. Real columns, no JSONB (CLAUDE.md invariant 3).

CREATE TABLE metadata_provider_state (
  provider       TEXT PRIMARY KEY,
  enabled        BOOLEAN NOT NULL,
  observed_at_ms BIGINT NOT NULL
);

COMMENT ON TABLE metadata_provider_state IS
  'Last enabled/disabled state the worker observed per keyed metadata '
  'provider (tmdb, tvdb). A boot that finds a provider enabled while this '
  'row says disabled (or is absent) enqueues one metadata-refresh job for '
  'that provider; see apps/worker/src/index.ts.';
