-- SPDX-License-Identifier: AGPL-3.0-only
-- Loombre :: migration 0030_wg_peers
--
-- Additive-only (mirrors 0001/.../0029's discipline): no column drops, no
-- type narrowing, no rewriting of prior migrations.
--
-- STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
-- reachability proof + posture card" (R2/R9/RG3/RG9, lane WG2). Reserved
-- as 0030 by DRIFT DECISION #2 (orchestrator freeze) once WG1 took 0029 for
-- its own persisted state ahead of this lane's device_kind/wg_peers work.
--
-- Two pieces:
--   1. `device_kind` — real PG enum (house style: notice_severity/
--      remote_probe_path/item_type/... all use CREATE TYPE for a closed
--      SCALAR value set) + `devices.kind`, additive NOT NULL DEFAULT 'app'
--      column (RG3: every pre-existing device row is unambiguously an
--      'app' device — nothing in this codebase has ever enrolled a
--      WireGuard peer before this migration exists).
--   2. `wg_peers` — one row per enrolled Remote (WireGuard) device, R2's
--      "device gets a stable tunnel IP from a private /24" + R9's
--      "enrollment configs never persisted server-side post-delivery".
--      `device_id` IS the primary key (not a separate surrogate id): the
--      relationship is exactly 1:1 with `devices` (kind='remote'), so
--      making the FK itself the PK is the simplest correct way to express
--      "device_id FK unique" — the same singleton-shaped-relationship
--      instinct remote_wireguard_state's boolean-PK trick applies, just
--      via a real foreign key here instead of a CHECK'd boolean.
--      ON DELETE CASCADE: deleting the owning devices row (either
--      self-service DELETE /devices/{id} or the admin-scoped DELETE
--      /admin/remote/wireguard/devices/{id}, packages/db/src/query/
--      wg-peers.ts revokeRemoteWireguardDeviceAndEmit) atomically removes
--      this row too — there is no code path that deletes a wg_peers row
--      without also deleting its device, or vice versa.
--
-- R9, stated as plainly as the table itself can state it: THERE IS NO
-- PRIVATE-KEY COLUMN HERE, OR ANYWHERE ELSE IN THIS SCHEMA, FOR A PEER'S
-- OWN KEY. The peer keypair is generated server-side at enrollment
-- (packages/wg-native's generateWgKeyPair, apps/server/src/remote/
-- wireguard/remote-wireguard.controller.ts), the private half is embedded
-- ONCE into the one-time RemoteWireguardEnrollment API response's
-- configText, and is then gone — never written to this table, never
-- logged, never cached anywhere server-side. Only the PUBLIC key is
-- persisted (needed to re-add every enrolled peer to the live wg-native
-- instance on every boot-resume, remote-wireguard.service.ts's loadPeers).
--
-- last-handshake is deliberately NOT a column here (STATE.md's own mission
-- text: "last-handshake stays runtime-only from WgStatus") — it only ever
-- exists as a live fact inside the running wg-native instance's peer list
-- (packages/wg-native WgStatus.peers[].lastHandshakeMs), surfaced by
-- joining that runtime read against this table's rows
-- (listRemoteWireguardDevices), never stored here.

-- ============================================================================
-- device_kind
-- ============================================================================

CREATE TYPE device_kind AS ENUM ('app', 'remote');

ALTER TABLE devices
  ADD COLUMN kind device_kind NOT NULL DEFAULT 'app';

COMMENT ON COLUMN devices.kind IS
  'RG3: ''app'' (default — every device row created via the login-driven '
  'createDevice path, P1.14) or ''remote'' (created ONLY by the admin-'
  'initiated enrollRemoteWireguardDevice flow, packages/db/src/query/'
  'wg-peers.ts, never by login). A ''remote'' device always has exactly '
  'one corresponding wg_peers row (device_id is that table''s own primary '
  'key) — this column is the human/API-facing label; the wg_peers row''s '
  'mere existence is what every WireGuard-specific query actually joins '
  'on.';

-- ============================================================================
-- wg_peers — one row per enrolled Remote (WireGuard) device (R2/R9/RG9)
-- ============================================================================

CREATE TABLE wg_peers (
  device_id      UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  public_key     TEXT NOT NULL UNIQUE,
  tunnel_ip      TEXT NOT NULL UNIQUE,
  created_at_ms  BIGINT NOT NULL
);

COMMENT ON TABLE wg_peers IS
  'WG2 (STATE.md "Loombre Remote", R2/R9/RG3/RG9): one row per enrolled '
  'Remote (WireGuard) device -- 1:1 with devices(kind=''remote''), enforced '
  'by device_id being this table''s own primary key (not a separate '
  'surrogate id). NO PRIVATE KEY COLUMN, EVER (R9) -- see this migration''s '
  'own header for the full posture. last-handshake is NOT a column here '
  '(runtime-only fact from packages/wg-native WgStatus, joined in at read '
  'time by listRemoteWireguardDevices, never persisted).';

COMMENT ON COLUMN wg_peers.device_id IS
  'The owning devices row (kind=''remote''). Primary key AND the unique FK '
  'this migration''s own header describes -- one peer per device, no '
  'separate surrogate id needed. ON DELETE CASCADE: deleting the device '
  'deletes this row atomically, in the SAME statement, so there is no '
  'window where one exists without the other.';

COMMENT ON COLUMN wg_peers.public_key IS
  'Standard WireGuard base64 public key (44 chars) -- generated server-side '
  'at enrollment (packages/wg-native generateWgKeyPair) alongside a '
  'private key that is embedded ONCE into the enrollment response''s '
  'configText and never reaches this table (R9). Needed to re-add this '
  'peer to the live wg-native instance on every boot-resume '
  '(remote-wireguard.service.ts loadPeers) and to remove it live on '
  'revocation (WgRemovePeer).';

COMMENT ON COLUMN wg_peers.tunnel_ip IS
  'This device''s stable address from the configured tunnel subnet (RG9: '
  '"server = .1, devices allocated lowest-free from .2-.254" for the /24 '
  'default, generalized to any REMOTE_SUBNET_SCHEMA-legal prefix by '
  'packages/shared/src/remote/subnet-allocation.ts). UNIQUE is the actual '
  'concurrency guard for allocation -- packages/db/src/query/wg-peers.ts '
  'allocateWgPeer reads the currently-used set, computes the lowest free '
  'candidate, and retries on a 23505 against THIS constraint (a race lost '
  'to a concurrent enrollment), never trusting its own read alone to be '
  'race-free.';

COMMENT ON COLUMN wg_peers.created_at_ms IS
  'Enrollment timestamp -- also the tiebreaker column for '
  'listRemoteWireguardDevices'' keyset pagination (paired with devices.id, '
  'the admin.ts listDevicesForUser convention).';
