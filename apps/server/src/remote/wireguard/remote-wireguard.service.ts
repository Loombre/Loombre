// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/wireguard/remote-wireguard.service.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card", lane WG1 (R1/R2/R3/R9/R11,
// RG1/RG2/RG10/RG15).
//
// Staged validate→commit (RG10, plugin-registration.service.ts's shape):
// enable() resolves settings + generates a keypair + starts the REAL
// listener BEFORE persisting anything — a failure at any step leaves the
// DB untouched (no half-enabled state ever committed). Runtime state (the
// live packages/wg-native instance + the RG2 loopback backend listener)
// is held ONLY in this singleton service's memory — @loombre/wg-native
// instances do not survive a process restart, which is exactly why
// onApplicationBootstrap() below re-derives them from the persisted DB
// row + keyring on every boot (R8 "boot resume").
//
// RG2's loopback backend listener: `http.createServer` wrapping the SAME
// Express handler every real HTTP request already goes through
// (HttpAdapterHost.httpAdapter.getInstance(), the identical trick
// apps/server/src/tls/runtime.ts's createTlsRuntime uses for its own
// manual-mode https.Server) — bound 127.0.0.1 on an ephemeral port, so a
// tunnel client's traffic reaches the REAL app, byte-for-byte, with zero
// duplicated routing/auth logic.
//
// Idempotence (mission R11 "lifecycle — enable/disable idempotence"):
// enable() while an instance is ALREADY live in THIS process is a pure
// no-op (returns the current status, generates nothing new, touches
// neither the DB nor the keyring) — R2's "keypair generated at enable"
// means "at a REAL enable" (first-ever, or a fresh enable after a real
// disable), not "every repeated call". disable() while nothing is live is
// equally a no-op (packages/db's disableRemoteWireguardAndEmit already
// emits nothing when it doesn't change anything — this service mirrors
// that at the runtime-instance layer).
//
// Admin gate: apps/server/src/remote/remote-wireguard.controller.ts's
// FROZEN 501 shell already calls requireAdmin (Wave-0, "route paths/
// methods/admin-gate ordering are frozen ... do not change") immediately
// before delegating here — this service trusts that FRESH A10 check
// rather than re-reading users.is_admin a second time in the same
// request (unlike plugin-registration.service.ts's own-module services,
// which have no such upstream check to rely on).
//
// RG15's cross-path 409 (assertNoOtherRemotePathActive below) was WG1's
// documented SEAM (a no-op — T1/D1 were separate sibling lanes off the same
// lane/remote-base tip whose own state that worktree could not see). WG2
// (this lane, integration unification per STATE.md's own assignment) closes
// it for real: assertNoOtherRemotePathActive now calls the injected
// RemoteActivePathReader (apps/server/src/remote/active-path-reader.ts),
// bound in remote.module.ts to RemoteActivePathResolverService — the SAME
// canonical @loombre/db resolveActivePath() (packages/db/src/query/
// remote-active-path.ts) T1's RemoteTunnelService, D1's
// RemoteDirectController, and S1's posture reader all now delegate to, so
// the cross-path 409 can never drift between the four call sites.
//
// WG2 additions (STATE.md "Loombre Remote", R2/R3/R9/RG3/RG9, migrations/
// 0030_wg_peers.sql, packages/db/src/query/wg-peers.ts): loadPeers() below
// now reads every persisted peer for real boot-resume re-registration;
// listDevices/enrollDevice/revokeDevice replace remote-wireguard.
// controller.ts's three device-management 501 shells. R9 (no PEER private
// key, EVER — audited end to end, distinct from the SERVER's OWN private
// key, which legitimately lives in the keyring via storePrivateKey/
// resolvePrivateKey above and always has, WG1): enrollDevice generates a
// FRESH peer keypair local to its own scope; its `.privateKey` is read
// exactly ONCE, at the `devicePrivateKey:` field of the buildProvisioning-
// Config call inside enrollDevice's own body — grep this file for
// `devicePrivateKey` to confirm that is the ONLY place a peer private key
// value is ever read, and that it flows straight into the ONE-TIME
// configText response, never into a variable, log line, or DB call that
// outlives this one method invocation.

import * as http from "node:http";
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { RequestListener } from "node:http";
import { detectSecretBackend, storeSecret, tryResolveSecret } from "@loombre/secrets";
import type { SecretBackend } from "@loombre/provisioning";
import {
  getRemoteWireguardState,
  enableRemoteWireguardAndEmit,
  disableRemoteWireguardAndEmit,
  getUserById,
  listAllWgPeers,
  listWgPeers,
  getWgPeerByDeviceId,
  enrollRemoteWireguardDeviceAndEmit,
  revokeRemoteWireguardDeviceAndEmit,
  type ListWgPeersParams,
  type RevokeRemoteWireguardDeviceResult,
} from "@loombre/db";
import { WgNativeClient, generateWgKeyPair, type WgPeerConfig } from "@loombre/wg-native";
import { buildProvisioningConfig } from "@loombre/shared";
import { DbProvider } from "../../common/db.provider.js";
import { SettingsService } from "../../settings/settings.service.js";
import { resolveAppPaths } from "../../cli/app-paths.js";
import { conflict, notFound, unprocessableEntity, serviceUnavailable } from "../../gateway/problem.exception.js";
import { RemoteActivePathReader } from "../active-path-reader.js";
import { deriveServerTunnelIp } from "./subnet.js";

export interface RemoteWireguardStatusDto {
  enabled: boolean;
  listening: boolean;
  listenPort: number;
  subnet: string;
  endpointHost: string | null;
  peerCount: number;
}

export interface RemoteWireguardDeviceDto {
  id: string;
  userId: string;
  name: string;
  tunnelIp: string;
  createdAtMs: number;
  lastHandshakeAtMs: number | null;
}

export interface RemoteWireguardDevicePageDto {
  items: RemoteWireguardDeviceDto[];
  nextCursor: string | null;
}

export interface RemoteWireguardEnrollmentDto {
  device: RemoteWireguardDeviceDto;
  /** wg-quick config text, shown ONCE — see this file's header (R9). */
  configText: string;
}

interface RuntimeInstance {
  instanceId: string;
  backendServer: http.Server;
}

const PRIVATE_KEY_ENVELOPE_ERROR = "malformed private-key keyring envelope";

interface PrivateKeyEnvelope {
  value: string;
  setAtMs: number;
}

function isPrivateKeyEnvelope(value: unknown): value is PrivateKeyEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["value"] === "string" &&
    typeof (value as Record<string, unknown>)["setAtMs"] === "number"
  );
}

@Injectable()
export class RemoteWireguardService implements OnApplicationBootstrap, OnModuleDestroy {
  private runtime: RuntimeInstance | null = null;

  constructor(
    private readonly dbProvider: DbProvider,
    private readonly settingsService: SettingsService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly activePathReader: RemoteActivePathReader,
  ) {}

  /** R8 boot resume: if the persisted intent is "enabled", restart the
   *  listener from the KEYRING'S private key (never a new keypair — a
   *  restart must keep the same server identity every already-enrolled
   *  peer's config still references). Never crashes boot over this (A4
   *  "never a crash" discipline, same posture resolveAndSeedJwtSecret
   *  takes in main.ts): a failure here leaves the DB row saying "enabled"
   *  while nothing is actually listening — logged loudly, recoverable by
   *  a manual disable/enable cycle or a fixed restart. */
  async onApplicationBootstrap(): Promise<void> {
    const state = await getRemoteWireguardState(this.dbProvider.db);
    if (!state.enabled || state.serverPublicKey === null) return;

    try {
      const privateKey = await this.resolvePrivateKey();
      if (privateKey === null) {
        console.warn(
          "remote-wireguard: boot resume skipped — DB says enabled but no private key was found in the keyring. " +
            "Remote stays administratively enabled but is NOT listening until a manual disable/enable cycle.",
        );
        return;
      }
      await this.startRuntime(privateKey);
      console.log("remote-wireguard: resumed on boot (listener restarted from persisted state).");
    } catch (err) {
      console.warn(
        `remote-wireguard: boot resume failed (${String(err)}) — Remote stays administratively enabled in the ` +
          "database but is NOT actually listening. Never fails server boot over this.",
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopRuntime();
  }

  async enable(actorUserId: string, nowMs = Date.now()): Promise<RemoteWireguardStatusDto> {
    if (this.runtime !== null) {
      // Idempotent: already live in this process — see this file's header.
      return this.status();
    }

    await this.assertNoOtherRemotePathActive();

    const client = WgNativeClient.load();
    if (!client) {
      throw serviceUnavailable(
        "The embedded WireGuard component is not available on this build/platform (packages/wg-native was not built — a Go toolchain is required).",
        "/admin/remote/wireguard/enable",
      );
    }

    const keys = generateWgKeyPair();
    await this.storePrivateKey(keys.privateKey);
    await this.startRuntimeWith(client, keys.privateKey);

    await enableRemoteWireguardAndEmit(this.dbProvider.db, {
      serverPublicKey: keys.publicKey,
      actorUserId,
      nowMs,
    });

    return this.status();
  }

  async disable(actorUserId: string, nowMs = Date.now()): Promise<RemoteWireguardStatusDto> {
    await this.stopRuntime();
    await disableRemoteWireguardAndEmit(this.dbProvider.db, { actorUserId, nowMs });
    return this.status();
  }

  async status(): Promise<RemoteWireguardStatusDto> {
    const state = await getRemoteWireguardState(this.dbProvider.db);
    const configuredPort = Number(this.settingsService.getEffective("remote.wireguardPort")?.value ?? 51820);
    const subnet = String(this.settingsService.getEffective("remote.subnet")?.value ?? "10.82.146.0/24");
    const endpointHostRaw = String(this.settingsService.getEffective("remote.wireguardEndpointHost")?.value ?? "");

    let listening = false;
    let listenPort = configuredPort;
    let peerCount = 0;

    if (this.runtime !== null) {
      const client = WgNativeClient.load();
      if (client) {
        try {
          const native = await client.status(this.runtime.instanceId);
          listening = native.listening;
          listenPort = native.port;
          peerCount = native.peers.length;
        } catch {
          listening = false;
        }
      }
    }

    return {
      enabled: state.enabled,
      listening,
      listenPort,
      subnet,
      endpointHost: endpointHostRaw.length > 0 ? endpointHostRaw : null,
      peerCount,
    };
  }

  /** TEST-ONLY seam (R11's loopback-handshake exit-gate test —
   *  apps/server/test/remote-wireguard-loopback.e2e.spec.ts): adds a peer
   *  to the LIVE in-process instance directly, bypassing enrollment (which
   *  is WG2's job, still a 501 shell — no HTTP route reaches this). Never
   *  called by production code. Throws if nothing is currently enabled. */
  async addTestPeer(peer: WgPeerConfig): Promise<void> {
    if (this.runtime === null) throw new Error("remote-wireguard: addTestPeer called while not enabled");
    const client = WgNativeClient.load();
    if (!client) throw new Error("remote-wireguard: addTestPeer called but wg-native is unavailable");
    await client.addPeer(this.runtime.instanceId, peer);
  }

  // ==========================================================================
  // Device management (WG2, R2/R3/R9/RG3/RG9) — replaces remote-wireguard.
  // controller.ts's three 501 shells.
  // ==========================================================================

  async listDevices(params: ListWgPeersParams): Promise<RemoteWireguardDevicePageDto> {
    const page = await listWgPeers(this.dbProvider.db, params);
    const handshakes = await this.liveHandshakeMap();
    return {
      items: page.rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.name,
        tunnelIp: row.tunnelIp,
        createdAtMs: row.createdAtMs,
        lastHandshakeAtMs: handshakes.get(row.publicKey) ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Admin-initiated enrollment (R2): validate the target user exists (404)
   * and Wireguard is enabled (409 — the contract's own documented status
   * for "enrollment is not currently possible"), require
   * remote.wireguardEndpointHost to be configured (422 — same posture as
   * D1's enableRemoteDirect reverse-proxy trustProxy check: a required
   * server-side prerequisite setting is empty), THEN generate a fresh peer
   * keypair + allocate the lowest-free tunnel IP + persist (ONE
   * transaction, packages/db/src/query/wg-peers.ts) — checks run BEFORE
   * any DB write, so a rejected enrollment never leaves a half-created
   * device behind. A live device gets WgAddPeer immediately so it can
   * start handshaking without waiting for the next restart; an enable-less
   * enrollment (state.enabled=true but this process's own runtime is not
   * currently live, e.g. a fresh boot before resume completes) simply
   * skips that step — loadPeers() re-adds it on the next successful
   * enable()/boot-resume regardless.
   *
   * R9 (audit this method specifically — see this file's header): `keys`
   * (the freshly generated keypair, including the private half) exists
   * ONLY in this method's local scope; it is passed to
   * buildProvisioningConfig to produce `configText`, returned to the
   * caller ONCE, and never stored, logged, or referenced again after this
   * method returns.
   */
  async enrollDevice(input: { userId: string; name: string; actorUserId: string; nowMs?: number }): Promise<RemoteWireguardEnrollmentDto> {
    const nowMsValue = input.nowMs ?? Date.now();
    const instance = "/admin/remote/wireguard/devices";

    const targetUser = await getUserById(this.dbProvider.db, input.userId);
    if (!targetUser) {
      throw notFound("Unknown userId.", instance);
    }

    const state = await getRemoteWireguardState(this.dbProvider.db);
    if (!state.enabled || state.serverPublicKey === null) {
      throw conflict("Wireguard is not enabled.", instance, "remote-wireguard-not-enabled");
    }

    const endpointHost = String(this.settingsService.getEffective("remote.wireguardEndpointHost")?.value ?? "").trim();
    if (endpointHost.length === 0) {
      throw unprocessableEntity(
        "remote.wireguardEndpointHost is not configured — set it from Settings before enrolling a device.",
        instance,
      );
    }
    const endpointPort = Number(this.settingsService.getEffective("remote.wireguardPort")?.value ?? 51820);
    const subnet = String(this.settingsService.getEffective("remote.subnet")?.value ?? "10.82.146.0/24");
    const serverTunnelIp = deriveServerTunnelIp(subnet);

    const keys = generateWgKeyPair();

    const enrolled = await enrollRemoteWireguardDeviceAndEmit(this.dbProvider.db, {
      userId: input.userId,
      name: input.name,
      publicKey: keys.publicKey,
      subnetCidr: subnet,
      actorUserId: input.actorUserId,
      nowMs: nowMsValue,
    });

    if (this.runtime !== null) {
      const client = WgNativeClient.load();
      if (client) {
        await client.addPeer(this.runtime.instanceId, { publicKey: enrolled.publicKey, tunnelIp: enrolled.tunnelIp });
      }
    }

    const configText = buildProvisioningConfig({
      serverPublicKey: state.serverPublicKey,
      serverEndpointHost: endpointHost,
      serverEndpointPort: endpointPort,
      devicePrivateKey: keys.privateKey,
      deviceTunnelIp: enrolled.tunnelIp,
      serverTunnelIp,
      subnetCidr: subnet,
    });

    return {
      device: {
        id: enrolled.deviceId,
        userId: enrolled.userId,
        name: enrolled.name,
        tunnelIp: enrolled.tunnelIp,
        createdAtMs: enrolled.createdAtMs,
        lastHandshakeAtMs: null,
      },
      configText,
    };
  }

  /**
   * RG3/R2: removes the LIVE WG peer (if this process's own runtime is
   * currently up) BEFORE deleting any row — see this method's own ordering
   * note. Returns undefined (idempotent no-op) when the device has no
   * wg_peers row (already revoked, never enrolled, or a kind='app'
   * device — the general DELETE /devices/{id} gap-closure path,
   * apps/server/src/catalog/devices.controller.ts, calls this for EVERY
   * kind='remote' device it revokes, so "not a remote device" must be a
   * clean no-op here, not an error).
   *
   * ORDERING (crash-safety, R9/RG3): the live peer is removed from the
   * running wg-native instance FIRST; only once that call has RETURNED
   * (succeeded, or there was nothing live to remove from — this.runtime
   * is null, or the native lib itself is unavailable) does the DB
   * transaction run (packages/db/src/query/wg-peers.ts
   * revokeRemoteWireguardDeviceAndEmit). A crash between the two leaves a
   * peer that is already unreachable on the wire but still has DB rows —
   * recoverable by simply re-running revoke (removePeer on an
   * already-absent peer key is a no-op at the wireguard-go UAPI layer,
   * server.go's removePeer doc). The REVERSE order (DB first, live
   * removal second) would risk the opposite and strictly worse outcome: a
   * device the DB calls "revoked" that can still complete a live
   * WireGuard handshake until the second step eventually runs — a
   * security hole, not merely an inconsistency, so this ordering is a
   * hard requirement, not a style preference.
   */
  async revokeDevice(input: { deviceId: string; actorUserId: string; nowMs?: number }): Promise<RevokeRemoteWireguardDeviceResult | undefined> {
    const nowMsValue = input.nowMs ?? Date.now();
    const peer = await getWgPeerByDeviceId(this.dbProvider.db, input.deviceId);
    if (!peer) return undefined;

    await this.removeLivePeerIfRunning(peer.publicKey);

    return revokeRemoteWireguardDeviceAndEmit(this.dbProvider.db, {
      deviceId: input.deviceId,
      actorUserId: input.actorUserId,
      nowMs: nowMsValue,
    });
  }

  private async removeLivePeerIfRunning(publicKey: string): Promise<void> {
    if (this.runtime === null) return;
    const client = WgNativeClient.load();
    if (!client) return; // native lib unavailable — nothing more we can do live; DB cleanup still proceeds
    await client.removePeer(this.runtime.instanceId, publicKey);
  }

  /** Live lastHandshakeMs per enrolled peer's public key — best-effort:
   *  not live (nothing enabled/running) or a runtime status read failing
   *  both collapse to "no live data" (an empty map, every device's
   *  lastHandshakeAtMs falls back to null) rather than failing the whole
   *  list read. */
  private async liveHandshakeMap(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (this.runtime === null) return map;
    const client = WgNativeClient.load();
    if (!client) return map;
    try {
      const native = await client.status(this.runtime.instanceId);
      for (const p of native.peers) {
        if (p.lastHandshakeMs > 0) map.set(p.publicKey, p.lastHandshakeMs);
      }
    } catch {
      // best-effort — see this method's own doc comment.
    }
    return map;
  }

  /** Every persisted peer, re-registered with the FRESH runtime instance on
   *  every enable()/boot-resume — WgStart's `peers` field (WG1's own doc
   *  comment on WgStartConfig.peers). A restart never loses an enrolled
   *  device's access: the peer rows survive in Postgres independent of
   *  this process's own lifetime, unlike the private key (keyring) or the
   *  in-memory runtime handle. */
  private async loadPeers(): Promise<WgPeerConfig[]> {
    const rows = await listAllWgPeers(this.dbProvider.db);
    return rows.map((row) => ({ publicKey: row.publicKey, tunnelIp: row.tunnelIp }));
  }

  /** RG15: "at most one active path ... enforced by each path's staged
   *  enable flow." Now a REAL check (WG2 integration unification) — see
   *  this file's header. */
  private async assertNoOtherRemotePathActive(): Promise<void> {
    const other = await this.activePathReader.activePath();
    if (other !== "none" && other !== "remote") {
      throw conflict(
        `Cannot enable Loombre Remote (WireGuard) — the ${other} path is already active. Disable it first.`,
        "/admin/remote/wireguard/enable",
        "remote-path-active",
      );
    }
  }

  private requestListener(): RequestListener {
    return this.httpAdapterHost.httpAdapter.getInstance() as RequestListener;
  }

  private async startBackendListener(): Promise<http.Server> {
    const server = http.createServer(this.requestListener());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("unreachable: no AddressInfo after listen()");
    }
    if (address.address !== "127.0.0.1") {
      server.close();
      throw new Error(`remote-wireguard: refusing to serve — backend listener bound "${address.address}", expected exactly 127.0.0.1.`);
    }
    return server;
  }

  private async startRuntime(privateKey: string): Promise<void> {
    const client = WgNativeClient.load();
    if (!client) {
      throw serviceUnavailable(
        "The embedded WireGuard component is not available on this build/platform.",
        "/admin/remote/wireguard",
      );
    }
    await this.startRuntimeWith(client, privateKey);
  }

  private async startRuntimeWith(client: WgNativeClient, privateKey: string): Promise<void> {
    const port = Number(this.settingsService.getEffective("remote.wireguardPort")?.value ?? 51820);
    const subnet = String(this.settingsService.getEffective("remote.subnet")?.value ?? "10.82.146.0/24");
    const serverTunnelIp = deriveServerTunnelIp(subnet);

    const backendServer = await this.startBackendListener();
    const backendAddress = backendServer.address();
    const backendPort = backendAddress !== null && typeof backendAddress !== "string" ? backendAddress.port : 0;

    const peers = await this.loadPeers();

    let instanceId: string;
    try {
      const result = await client.start({
        privateKey,
        listenPort: port,
        serverTunnelIp,
        subnet,
        peers,
        backendTcpPort: backendPort,
      });
      instanceId = result.instanceId;
    } catch (err) {
      await new Promise<void>((resolve) => backendServer.close(() => resolve()));
      throw err;
    }

    this.runtime = { instanceId, backendServer };
  }

  private async stopRuntime(): Promise<void> {
    if (this.runtime === null) return;
    const { instanceId, backendServer } = this.runtime;
    this.runtime = null;

    const client = WgNativeClient.load();
    if (client) {
      // Honest-unknown-id errors from wg-native are expected/harmless here
      // (idempotence is THIS service's job, not the raw library's — see
      // @loombre/wg-native's client.ts stop() doc comment).
      await client.stop(instanceId).catch(() => {});
    }
    await new Promise<void>((resolve) => backendServer.close(() => resolve()));
  }

  private secretKey(): string {
    const { dataDir } = resolveAppPaths(process.platform, process.env);
    return `${dataDir}/secrets/remote-wireguard-private-key`;
  }

  private async resolveBackend(): Promise<SecretBackend> {
    const detected = await detectSecretBackend();
    return detected.backend;
  }

  /** {value,setAtMs} envelope precedent — apps/server/src/settings/
   *  mail-credentials.service.ts's own header has the full rationale for
   *  this exact shape (provider-keys.service.ts's A9 pattern). `value` is
   *  the WG base64 private key itself, a bare string (not a nested JSON
   *  payload like mail's username/password pair). */
  private async storePrivateKey(privateKeyBase64: string): Promise<void> {
    const backend = await this.resolveBackend();
    const envelope: PrivateKeyEnvelope = { value: privateKeyBase64, setAtMs: Date.now() };
    await storeSecret(backend, this.secretKey(), JSON.stringify(envelope));
  }

  private async resolvePrivateKey(): Promise<string | null> {
    const backend = await this.resolveBackend();
    const raw = await tryResolveSecret({ backend, key: this.secretKey() });
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`remote-wireguard: ${PRIVATE_KEY_ENVELOPE_ERROR} (not valid JSON) — treating as absent.`);
      return null;
    }
    if (!isPrivateKeyEnvelope(parsed)) {
      console.warn(`remote-wireguard: ${PRIVATE_KEY_ENVELOPE_ERROR} — treating as absent.`);
      return null;
    }
    return parsed.value;
  }
}
