-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0032_remote_tunnel_state
--
-- Additive-only (mirrors 0001/.../0031's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- "Loombre Remote — embedded WireGuard + three-path wizard + reachability
-- proof + posture card" (STATE.md R4/R9/RG7, lane T1). Reserved for T1 at
-- the orchestrator's Batch-1 freeze ("DRIFT DECISION #2 ... 0032 = T1
-- (optional)"): single-row runtime state for the Tunnel path — WHICH
-- Cloudflare tunnel/DNS-route this instance currently owns, so a verified
-- teardown (R8) or a status/logs read can find them again after a process
-- restart. The admin's Cloudflare API token itself is NEVER stored here —
-- packages/secrets keyring only (R9), via apps/server/src/remote/tunnel/
-- tunnel-token.service.ts's {value, setAtMs} envelope (the A9/AD4 pattern
-- settings/provider-keys.service.ts and settings/mail-credentials.service.ts
-- both already carry). The per-tunnel CONNECTOR run credential Cloudflare
-- mints at provisioning time is likewise keyring-only (a second, distinct
-- keyring entry) — this table only ever holds NON-secret identifiers.
--
-- Single-row singleton table (`id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id
-- = 1)`): there is exactly one Tunnel-path configuration per instance (RG5/
-- RG15 — at most one remote-access path is active at a time, enforced by
-- each path's staged enable flow, not by this table). The seed row below
-- is inserted once, at migration time, and every subsequent write is an
-- UPDATE (packages/db/src/query/remote-tunnel.ts) — never a second INSERT,
-- which the CHECK constraint would reject outright if attempted.

CREATE TABLE remote_tunnel_state (
  id             SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  hostname       TEXT NULL,
  tunnel_id      TEXT NULL,
  account_id     TEXT NULL,
  zone_id        TEXT NULL,
  dns_record_id  TEXT NULL,
  enabled_at_ms  BIGINT NULL,
  -- A disabled row never carries leftover provisioning identifiers — every
  -- write clears these together (packages/db/src/query/remote-tunnel.ts),
  -- so a stale tunnel_id can never survive past its own teardown and be
  -- read back as if it were still live.
  CHECK (enabled OR (hostname IS NULL AND tunnel_id IS NULL AND account_id IS NULL AND zone_id IS NULL AND dns_record_id IS NULL AND enabled_at_ms IS NULL))
);

INSERT INTO remote_tunnel_state (id) VALUES (1);

COMMENT ON TABLE remote_tunnel_state IS
  'R4/R9/RG7: singleton runtime state for the BYO-Cloudflare-token Tunnel '
  'path. enabled=false is the disabled/never-configured state (the seed '
  'row). Enabling populates hostname/tunnel_id/account_id/zone_id/'
  'dns_record_id/enabled_at_ms together in one transaction '
  '(packages/db/src/query/remote-tunnel.ts enableTunnelStateAndEmit); '
  'disabling clears all six together ONLY after the provider''s '
  'deprovisionTunnel/removeDnsRoute calls are independently verified to '
  'have succeeded (R8 "verified teardown" -- apps/server/src/remote/'
  'tunnel/remote-tunnel.service.ts orchestrates the provider calls BEFORE '
  'ever calling disableTunnelStateAndEmit, so a failed teardown leaves '
  'this row untouched and a retry has the same ids to work with, never '
  'orphaning a live Cloudflare tunnel with no local record of it).';

COMMENT ON COLUMN remote_tunnel_state.hostname IS
  'The public hostname routed through this tunnel (EnableRemoteTunnelRequest'
  '.hostname, packages/contract/openapi.yaml). NULL when disabled.';

COMMENT ON COLUMN remote_tunnel_state.tunnel_id IS
  'The Cloudflare cfd_tunnel id (TunnelProvider.provisionTunnel''s result) '
  '-- needed to delete the tunnel and to build the '
  '<tunnel_id>.cfargotunnel.com DNS target on teardown. Not a secret (it is '
  'itself PART of the public DNS record), but never useful outside this '
  'instance''s own teardown/status calls either, hence still private to '
  'this table rather than echoed on any read-facing DTO (RemoteTunnelStatus '
  'has no tunnelId field, RG15 frozen shape).';

COMMENT ON COLUMN remote_tunnel_state.account_id IS
  'The Cloudflare account id the stored API token resolved to '
  '(TunnelProvider.validateToken). Required on every subsequent '
  'account-scoped Cloudflare API call (cfd_tunnel create/delete, '
  'configuration PUT) -- resolved once at enable time rather than '
  're-derived from the token on every call.';

COMMENT ON COLUMN remote_tunnel_state.zone_id IS
  'The Cloudflare zone id the DNS CNAME route was created in (resolved '
  'from hostname''s registrable root domain at enable time) -- needed to '
  'delete the DNS record on teardown without a second zone lookup.';

COMMENT ON COLUMN remote_tunnel_state.dns_record_id IS
  'The Cloudflare DNS record id for the <hostname> CNAME -> '
  '<tunnel_id>.cfargotunnel.com route this instance created -- needed to '
  'remove exactly that record (and no other) on teardown.';

COMMENT ON COLUMN remote_tunnel_state.enabled_at_ms IS
  'When this Tunnel path was last enabled, ms. NULL when disabled. Mirrors '
  'remote.enabled''s envelope tsMs/payload enabledAtMs (packages/contract/'
  'event-schemas/remote.enabled.schema.json) -- the SAME value, not a '
  'derived one.';
