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
// RG15's cross-path 409 (assertNoOtherRemotePathActive below) is a
// documented SEAM, not a real check: T1 (tunnel) and D1 (direct) are
// separate lanes off the same lane/remote-base tip whose own state this
// worktree cannot see — same "interface with a no-op default, integration
// wires the real thing" posture the orchestrator already established for
// ConnectorManager/ConnectorHealthReader (STATE.md Batch-1 dispatch).
// Flagged in WG1's own report as an adjudication beyond R/RG law.

import * as http from "node:http";
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { RequestListener } from "node:http";
import { detectSecretBackend, storeSecret, tryResolveSecret } from "@loombre/secrets";
import type { SecretBackend } from "@loombre/provisioning";
import { getRemoteWireguardState, enableRemoteWireguardAndEmit, disableRemoteWireguardAndEmit } from "@loombre/db";
import { WgNativeClient, generateWgKeyPair, type WgPeerConfig } from "@loombre/wg-native";
import { DbProvider } from "../../common/db.provider.js";
import { SettingsService } from "../../settings/settings.service.js";
import { resolveAppPaths } from "../../cli/app-paths.js";
import { serviceUnavailable } from "../../gateway/problem.exception.js";
import { deriveServerTunnelIp } from "./subnet.js";

export interface RemoteWireguardStatusDto {
  enabled: boolean;
  listening: boolean;
  listenPort: number;
  subnet: string;
  endpointHost: string | null;
  peerCount: number;
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

  /** WG2's seam (documented per the mission brief): today always returns
   *  no peers — a fresh enable/boot-resume never has any peer to restore
   *  because enrollment (kind='remote' devices, migrations/
   *  0030_*_wg_peers) does not exist yet on this branch. WG2 replaces this
   *  method's body with a real query against its own peers table; nothing
   *  else in this file needs to change (startRuntimeWith already threads
   *  whatever this returns straight into WgStart's `peers` field). */
  private async loadPeers(): Promise<WgPeerConfig[]> {
    return [];
  }

  /** RG15: "at most one active path ... enforced by each path's staged
   *  enable flow." SEAM — see this file's header for the full cross-lane
   *  rationale; today this only ever returns (WG1's own worktree cannot
   *  see T1/D1's state). */
  private async assertNoOtherRemotePathActive(): Promise<void> {
    return;
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
