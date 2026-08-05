-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0029_remote_wireguard_state
--
-- Additive-only (mirrors 0001/.../0028's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- "Loombre Remote — embedded WireGuard + three-path wizard + reachability
-- proof + posture card" (STATE.md, kicked off 2026-08-04), lane WG1.
-- DRIFT DECISION #2 (orchestrator, logged at the exit gate): renumbered
-- ahead of WG2's device_kind/wg_peers migration (now 0030) because WG1
-- needs persistent state before any peer bookkeeping exists. Scope is
-- deliberately minimal, per the drift decision's own wording: "server
-- public key, enabled, enabled-at; private key keyring-only" — nothing
-- else. listen_port/subnet/endpointHost are NOT duplicated here: they are
-- already the `remote.*` settings-registry keys (Wave-0 freeze,
-- packages/shared/src/settings-registry.ts), and duplicating an
-- effective-settings value into a state table is exactly the kind of drift
-- the settings registry already exists to prevent.

-- ============================================================================
-- remote_wireguard_state — single-row table (house pattern: a BOOLEAN
-- primary key CHECK'd to TRUE is the standard PostgreSQL idiom for "at
-- most one row can ever exist", enforced by the primary key's own
-- uniqueness rather than application discipline alone). No row exists
-- until the first enable (packages/db/src/query/remote-wireguard.ts
-- upserts it) — "no row" and "row with enabled=false" are both legal
-- readings of "not enabled"; the query layer's getRemoteWireguardState
-- treats an absent row as the all-false default rather than requiring a
-- migration-time seed (no other migration in this repo seeds data, see
-- this table's own COMMENT for the full reasoning).
-- ============================================================================

CREATE TABLE remote_wireguard_state (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  server_public_key  TEXT NULL,
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at_ms      BIGINT NULL,
  updated_at_ms      BIGINT NOT NULL
);

COMMENT ON TABLE remote_wireguard_state IS
  'WG1 (STATE.md "Loombre Remote", R1/R2/R9): single-row admin state for '
  'the embedded userspace WireGuard subsystem. The PRIVATE key lives ONLY '
  'in the keyring (packages/secrets storeSecret, {value,setAtMs} envelope '
  'precedent) -- this table NEVER carries a private key, by construction '
  '(R9 no-secrets rule extends past event payloads to storage here too). '
  'id is a singleton-enforcing BOOLEAN PK (CHECK(id) forbids id=false '
  'rows, PK uniqueness forbids a second id=true row) -- the standard '
  'Postgres idiom for a table that must never hold more than one row. No '
  'row exists until RemoteWireguardService.enable() first upserts one; '
  'getRemoteWireguardState treats a missing row as the all-disabled '
  'default (packages/db/src/query/remote-wireguard.ts), so this table is '
  'never migration-seeded.';

COMMENT ON COLUMN remote_wireguard_state.server_public_key IS
  'Standard WireGuard base64 public key (44 chars) -- generated fresh on '
  'every enable() (a new server keypair each time Remote is turned on, '
  'never reused across disable/enable cycles). NULL only before the first '
  'ever enable.';

COMMENT ON COLUMN remote_wireguard_state.enabled IS
  'Mirrors RemoteWireguardStatus.enabled (packages/contract/openapi.yaml): '
  '"a server keypair exists and enrollment is possible" -- distinct from '
  'whether the in-process listener is ACTUALLY live right now (that is '
  'runtime-only fact from packages/wg-native WgStatus, never persisted, '
  'since a process restart always starts the listener fresh from this '
  'row on boot-resume).';

COMMENT ON COLUMN remote_wireguard_state.enabled_at_ms IS
  'Set on every successful enable(), untouched by disable() (an audit '
  'fact: "when was this last turned on", not "is it on now" -- that is '
  'the enabled column). NULL only before the first ever enable.';

COMMENT ON COLUMN remote_wireguard_state.updated_at_ms IS
  'Bumped on every enable()/disable() -- the generic last-write timestamp '
  '(server_settings.updated_by-adjacent pattern), independent of '
  'enabled_at_ms which specifically means "last enabled".';
