-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0014_plugins
--
-- Additive-only (mirrors 0002/.../0013's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- Loombre Plugin Protocol (LPP) v1, Lane W2 (packages/plugin-protocol/spec/
-- lpp-v1.md is the FROZEN wire contract this table's rows back). Real
-- columns/FKs/enums for everything with independent read/write/audit needs
-- (CLAUDE.md invariant 3); JSONB reserved for exactly two fields that are
-- genuinely opaque blobs: the plugin's manifest snapshot (a third-party
-- document Loombre only ever stores/forwards, never queries a field out of)
-- and its non-secret config values (shape is whatever THAT plugin's own
-- configSchema declares, unknowable at migration-authoring time — the same
-- reasoning migrations/0013_server_settings.sql's `value` column already
-- established for server_settings). CLAUDE.md invariant 3's JSONB whitelist
-- grows from 7 to 9 entries (plugins.manifest, plugins.config) in this
-- lane's commit alongside this migration, per the mission's LD3.
--
-- Ownership split (LD1/LD2/LD3): the delivery-signing HMAC secret and every
-- `configSchema` field marked `secret: true` live ONLY in the keyring
-- (packages/secrets), under `plugin-hmac-<pluginId>` and
-- `plugin-<pluginId>-<fieldName>` respectively — NEVER a column here, NEVER
-- in `config` JSONB, NEVER in an event payload. This table's `config` JSONB
-- holds only the NON-secret configSchema field values.
--
-- `granted_capability_types TEXT[]` — LD6's "caller supplies the GRANTED
-- subset (... capability set <= declared)": the admin may register a plugin
-- with fewer capability TYPES enabled than its manifest declares (e.g. a
-- plugin offering both metadata-provider and event-subscriber, approved for
-- metadata-provider only). A real, independently-queryable column rather
-- than a JSONB blob, per CLAUDE.md invariant 3 — it drives the C5 scoping
-- seam (apps/server/src/plugins/scope.ts) and W3/W4's own capability-gating
-- checks and must be a first-class filterable value, not something buried in
-- `manifest` (which the mission itself is careful to keep OUT of every
-- event payload — see plugin_event_grants below and event-schemas/plugin.*
-- for why a real column matters there too).
--
-- `content_class` (reusing the EXISTING `content_class` enum type, per this
-- lane's mission text) is the plugin's own AGGREGATE scope: 'restricted' iff
-- any GRANTED capability's manifest-declared `contentClass` is 'restricted',
-- else 'general' — computed by the registration/re-approval service (never
-- by a trigger here; unlike catalog_items/libraries, a plugin has no owning
-- parent row to derive this from). Drives
-- apps/server/src/plugins/scope.ts's assertPluginAttachAllowed /
-- pluginMayReceiveRestricted, mirroring apps/worker/src/metadata/
-- registry.ts's assertScope semantics for metadata providers verbatim (a
-- restricted-scoped plugin never attaches to/receives general-only data;
-- the reverse is fine).
--
-- Health/breaker columns (LD7/LD8): ONE aggregate `health_state` per plugin
-- (not per-capability — see apps/server/src/plugins/plugin-health.service.ts
-- header for how the envelope check and this lane's OWN per-capability
-- static checks fold into this single column; W4's operational
-- event-delivery health is a separate, later concern layered on the same
-- substrate). `consecutive_failures` is the DURABLE breaker counter driving
-- LD8's "5 consecutive failures -> auto-disable" — distinct from
-- packages/plugin-host's in-memory circuit-breaker state machine, which is a
-- per-process fast-path gate over the SAME failure signal, not a second
-- source of truth (see packages/plugin-host/src/breaker.ts's header).
--
-- `disabled_reason` is TEXT + CHECK, not a Postgres enum: it is a small,
-- LPP-specific closed set ('admin' | 'breaker' | 'scope-change', LD4) with
-- no other table ever needing it — mirrors migrations/0011's
-- hw_capability_backends.backend/decode/encode/tone_map precedent
-- ("CHECK-constrained, not native enums") for the same "closed set local to
-- one table" reasoning, rather than growing the shared enum-type namespace
-- for a set this narrow.
--
-- `lan_allowlist TEXT[]` — LD5's SSRF-guard escape hatch: exact hostnames
-- (or IP literals) this plugin's own base_url/delivery/config-declared
-- targets are permitted to resolve to even when they land in a
-- private/loopback/link-local range. Explicit hosts only (no CIDR/wildcard
-- parsing here or in packages/plugin-host — an admin opts a plugin INTO a
-- specific LAN address, never a whole subnet blindly).
--
-- `base_url` is UNIQUE: registering the same plugin endpoint twice would
-- otherwise silently produce two independent rows racing each other's
-- health/breaker state for what is, from the plugin's own perspective, one
-- HTTP service — the registration service's job is re-approval /
-- re-registration against the EXISTING row, never a duplicate insert.
--
-- `approved_at_ms` is NOT NULL, grouped with created_at_ms/updated_at_ms
-- (all three BIGINT epoch ms, per this lane's mission text): LD6's
-- registration flow ends with "row committed enabled with granted scope" in
-- one step — there is no separate "pending approval" row state in LPP v1 —
-- so approval always happens at insert time (initial registration) or at an
-- explicit re-approval call after a scope-change auto-disable; it is never
-- absent for a row that exists at all.

CREATE TYPE plugin_health_state AS ENUM ('unknown', 'healthy', 'unhealthy');

CREATE TABLE plugins (
  id                        UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  name                      TEXT NOT NULL,
  base_url                  TEXT NOT NULL,
  version                   TEXT NOT NULL,
  protocol_version          INT NOT NULL,
  enabled                   BOOLEAN NOT NULL DEFAULT true,
  content_class             content_class NOT NULL DEFAULT 'general',
  granted_capability_types  TEXT[] NOT NULL DEFAULT '{}',
  health_state              plugin_health_state NOT NULL DEFAULT 'unknown',
  consecutive_failures      INT NOT NULL DEFAULT 0,
  last_health_check_ms      BIGINT NULL,
  last_ok_ms                BIGINT NULL,
  disabled_reason           TEXT NULL,
  lan_allowlist             TEXT[] NOT NULL DEFAULT '{}',
  manifest                  JSONB NOT NULL,
  config                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_ms             BIGINT NOT NULL,
  updated_at_ms             BIGINT NOT NULL,
  approved_at_ms            BIGINT NOT NULL,
  CONSTRAINT plugins_base_url_unique UNIQUE (base_url),
  CONSTRAINT plugins_disabled_reason_valid CHECK (
    disabled_reason IS NULL OR disabled_reason IN ('admin', 'breaker', 'scope-change')
  ),
  CONSTRAINT plugins_disabled_reason_consistency CHECK (
    (enabled = true AND disabled_reason IS NULL) OR (enabled = false)
  )
);

COMMENT ON TABLE plugins IS
  'Loombre Plugin Protocol (LPP) v1 registry (packages/plugin-protocol/spec/'
  'lpp-v1.md) — one row per registered out-of-process plugin (C1: a plugin '
  'is always a separate HTTP service, never in-process code). Written only '
  'via packages/db/src/query/plugins.ts''s transactional emit-helpers '
  '(apps/server/src/plugins/*.service.ts is the sole caller) — every state '
  'change lands with its matching plugin.* outbox event in the SAME '
  'transaction (docs/PLAN.md §4.3), the same discipline '
  'upsertServerSettingAndEmit established for server_settings.';

COMMENT ON COLUMN plugins.base_url IS
  'The plugin''s HTTP(S) origin (scheme + host + optional port, no path) — '
  'SSRF-guarded at every use (packages/plugin-host''s hardenedFetch, LD5). '
  'UNIQUE: re-registering the same endpoint updates/re-approves the '
  'existing row rather than creating a duplicate.';

COMMENT ON COLUMN plugins.version IS
  'The PLUGIN''s own version string from its manifest (LPP''s `version` '
  'field) — distinct from protocol_version.';

COMMENT ON COLUMN plugins.protocol_version IS
  'The LPP protocol version this plugin speaks (manifest `protocolVersion` '
  '— packages/plugin-protocol''s LPP_PROTOCOL_VERSION today). Registration '
  'rejects any other value (C2) before a row is ever written, so this is '
  'always the one supported value in practice; stored anyway so a future '
  'LPP v2 host can tell v1 rows apart without re-fetching every manifest.';

COMMENT ON COLUMN plugins.content_class IS
  'This plugin''s AGGREGATE content-class scope, computed by the '
  'registration/re-approval service (never a trigger — a plugin has no '
  'owning parent row): ''restricted'' iff any GRANTED capability''s '
  'manifest-declared contentClass is ''restricted'', else ''general''. '
  'Drives apps/server/src/plugins/scope.ts''s assertPluginAttachAllowed / '
  'pluginMayReceiveRestricted (mirrors apps/worker/src/metadata/'
  'registry.ts''s assertScope semantics verbatim).';

COMMENT ON COLUMN plugins.granted_capability_types IS
  'The subset of this plugin''s manifest-declared capability `type` values '
  '(LPP capabilities/index.ts CAPABILITY_TYPES: ''metadata-provider'' | '
  '''event-subscriber'') an admin has actually approved for use — LD6''s '
  '"capability set <= declared". A real column (not buried in `manifest` '
  'JSONB) because it is independently queried/filtered by every capability '
  'integration (W3/W4) and by the C5 scoping seam.';

COMMENT ON COLUMN plugins.health_state IS
  'ONE aggregate health value per plugin (LD7) — not per-capability. '
  '''unknown'' until the first health check completes. Transitions emit '
  'plugin.health-changed exactly on CHANGE (apps/server/src/plugins/'
  'plugin-health.service.ts), never on every check.';

COMMENT ON COLUMN plugins.consecutive_failures IS
  'DURABLE breaker counter (LD8): incremented on every failed/timed-out '
  'callPlugin outcome, reset to 0 on any success. Reaching '
  'packages/plugin-host''s exported LPP_BREAKER_FAILURE_THRESHOLD (5) '
  'auto-disables the plugin (enabled=false, disabled_reason=''breaker'') '
  'in the SAME transaction that records the crossing failure. Distinct '
  'from packages/plugin-host''s in-memory circuit-breaker state machine, '
  'which gates individual outbound calls per-process using this same '
  'failure signal but is never itself the durable count.';

COMMENT ON COLUMN plugins.last_health_check_ms IS
  'Epoch ms of the most recent health check attempt, regardless of '
  'outcome. NULL until the first check ever runs.';

COMMENT ON COLUMN plugins.last_ok_ms IS
  'Epoch ms of the most recent health check that succeeded. NULL if none '
  'ever has.';

COMMENT ON COLUMN plugins.disabled_reason IS
  'NULL while enabled=true; one of ''admin'' | ''breaker'' | '
  '''scope-change'' (LD4/LD8) while enabled=false — matches every '
  'plugin.disabled event payload''s `reason` field exactly. CHECK-'
  'constrained TEXT rather than a Postgres enum (mirrors migrations/'
  '0011_hw_capability_snapshots.sql''s backend/decode/encode/tone_map '
  'precedent): this closed set is local to this one table.';

COMMENT ON COLUMN plugins.lan_allowlist IS
  'Explicit hostnames/IP literals (LD5) this plugin is permitted to target '
  '(base_url, event-subscriber delivery endpoint, any config-declared URL '
  'a future capability resolves) even when they land in a private/'
  'loopback/link-local address range that packages/plugin-host''s '
  'hardenedFetch would otherwise reject. No CIDR/wildcard matching — exact '
  'string match only, an admin opts a plugin into a SPECIFIC address, '
  'never a subnet.';

COMMENT ON COLUMN plugins.manifest IS
  'Verbatim snapshot of the plugin''s GET /lpp/manifest response as fetched '
  'at last successful registration/re-approval/refresh — CLAUDE.md '
  'invariant 3 JSONB whitelist entry 8. Opaque to SQL (never queried field-'
  'by-field); the source of truth for capability re-diffing on re-fetch '
  '(LD6). NEVER placed in an event payload verbatim (LD4) — events carry '
  'only pluginId/name + specific old/new fields.';

COMMENT ON COLUMN plugins.config IS
  'Non-secret configSchema field values only (LD1) — CLAUDE.md invariant 3 '
  'JSONB whitelist entry 9. Every `secret: true` field lives in the '
  'keyring instead (`plugin-<pluginId>-<fieldName>`), never here.';

COMMENT ON COLUMN plugins.approved_at_ms IS
  'Epoch ms this row was last (re-)approved — set at initial registration '
  'and again by the re-approval service method after a scope-change '
  'auto-disable (LD6). NOT NULL: LPP v1 has no "pending approval" row '
  'state, approval always happens in the same transaction a row is '
  'inserted or re-approved.';

CREATE INDEX plugins_enabled_idx ON plugins (enabled);

CREATE TABLE plugin_event_grants (
  id             UUID PRIMARY KEY DEFAULT loombre_uuidv7(),
  plugin_id      UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  granted_at_ms  BIGINT NOT NULL,
  CONSTRAINT plugin_event_grants_unique UNIQUE (plugin_id, event_type)
);

COMMENT ON TABLE plugin_event_grants IS
  'LD6''s "event grants <= requested": one row per outbox event `type` '
  '(packages/contract/event-schemas envelope enum) an admin has granted an '
  'event-subscriber-capability plugin, always a subset of that capability''s '
  'manifest-declared `eventTypes` request. ON DELETE CASCADE — removing a '
  'plugin removes its grants, no orphaned rows. Real rows, not a JSONB '
  'array on `plugins`, per CLAUDE.md invariant 4/property: grants are '
  'independently queried per event type by the outbox delivery path (W4).';

COMMENT ON COLUMN plugin_event_grants.event_type IS
  'One packages/contract/event-schemas envelope `type` enum value — '
  'validated against that taxonomy at grant time by the registration '
  'service (LD6), never re-validated by a DB constraint (the taxonomy is a '
  'TypeScript source of truth that evolves without a migration, the same '
  'reasoning migrations/0013_server_settings.sql''s header gives for not '
  'CHECK-constraining server_settings.key).';
