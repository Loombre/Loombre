// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/src/client.ts
//
// The typed wrapper class every consumer (apps/server/src/remote/wireguard,
// this package's own tests) uses instead of touching loader.ts directly.
// One WgNativeClient instance = one loaded native library; every method
// maps 1:1 onto native/main.go's exported C API (see that file's header).

import { tryLoadWgNative, parseEnvelope, type WgNativeLibrary } from "./loader.js";

export interface WgPeerConfig {
  /** Standard WireGuard base64 public key (44 chars). */
  publicKey: string;
  /** This peer's stable address from the tunnel subnet, e.g. "10.82.146.2". */
  tunnelIp: string;
}

export interface WgStartConfig {
  /** Standard WireGuard base64 private key (44 chars) — the SERVER's own
   *  keypair, generated once at enable and kept in the keyring (R9). */
  privateKey: string;
  /** 0 requests an OS-assigned ephemeral port — WgStatus's `port` reports
   *  the real bound value regardless (R11: unprivileged ports only in tests). */
  listenPort: number;
  /** The ONE address this instance's netstack owns (RG2 containment). */
  serverTunnelIp: string;
  /** CIDR, sanity-checked server-side against serverTunnelIp — informational
   *  only today (WG2 owns peer IP allocation from this range). */
  subnet: string;
  /** Peers to configure at start — empty at first enable (WG1 scope; WG2
   *  adds enrollment). */
  peers: WgPeerConfig[];
  /** The RG2 loopback backend listener's port — every accepted netstack
   *  TCP connection on serverTunnelIp:80 is raw-piped to
   *  127.0.0.1:backendTcpPort, byte-transparent (no HTTP awareness). */
  backendTcpPort: number;
}

export interface WgPeerStatus {
  publicKey: string;
  /** Present when this instance was itself the one that added the peer
   *  (server.go tracks it at AddPeer time) — absent for peers this
   *  process-instance doesn't have separate tunnelIp bookkeeping for. */
  tunnelIp?: string;
  /** 0 = never handshaked. */
  lastHandshakeMs: number;
  rxBytes: number;
  txBytes: number;
}

export interface WgStatusResult {
  listening: boolean;
  /** The REAL bound UDP port (read back from the device, never the
   *  caller-requested value — matters when listenPort was 0). */
  port: number;
  peers: WgPeerStatus[];
}

export interface WgTestClientConfig {
  /** The TEST peer's own base64 private key. */
  privateKey: string;
  clientTunnelIp: string;
  serverPublicKey: string;
  /** "host:port" — the server's real bound UDP endpoint. */
  serverEndpoint: string;
  /** Defaults to ["0.0.0.0/0"] server-side when omitted — deliberately
   *  broader than R3's real split-tunnel default; see native/testclient.go's
   *  header for why the test harness needs that adversarial posture. */
  allowedIps?: string[];
  /** Defaults to 5000ms server-side. */
  timeoutMs?: number;
}

export interface WgFetchResult {
  status: number;
  bodyPrefix: string;
}

export class WgNativeClient {
  private constructor(private readonly lib: WgNativeLibrary) {}

  /** Attempts to load the native library for the current platform — returns
   *  undefined (never throws) when it can't be built/found. Callers that
   *  need a hard failure instead (CI) go through test/support/require-wg.ts,
   *  which wraps this with the LOOMBRE_REQUIRE_WG escalation. */
  static load(distDir?: string): WgNativeClient | undefined {
    const lib = tryLoadWgNative(distDir);
    return lib ? new WgNativeClient(lib) : undefined;
  }

  async start(config: WgStartConfig): Promise<{ instanceId: string }> {
    const raw = await this.lib.wgStart(JSON.stringify(config));
    return parseEnvelope<{ instanceId: string }>(raw);
  }

  /** Throws WgNativeError (loader.ts) on an unknown/already-stopped
   *  instanceId — idempotence across "already disabled" is a SERVICE-layer
   *  concern (apps/server/src/remote/wireguard/remote-wireguard.service.ts),
   *  not something this client fakes; see native/server.go's stopServer
   *  doc comment. */
  async stop(instanceId: string): Promise<void> {
    const raw = await this.lib.wgStop(instanceId);
    parseEnvelope<Record<string, never>>(raw);
  }

  async addPeer(instanceId: string, peer: WgPeerConfig): Promise<void> {
    const raw = await this.lib.wgAddPeer(instanceId, JSON.stringify(peer));
    parseEnvelope<Record<string, never>>(raw);
  }

  async removePeer(instanceId: string, publicKeyBase64: string): Promise<void> {
    const raw = await this.lib.wgRemovePeer(instanceId, publicKeyBase64);
    parseEnvelope<Record<string, never>>(raw);
  }

  async status(instanceId: string): Promise<WgStatusResult> {
    const raw = await this.lib.wgStatus(instanceId);
    return parseEnvelope<WgStatusResult>(raw);
  }

  /** Test-only: a SEPARATE ephemeral client-side device+netstack (R11's "a
   *  test peer connects through netstack and fetches a real endpoint") —
   *  never used by production code, only by this package's and apps/server's
   *  wg-gated test suites. */
  async testClientFetch(config: WgTestClientConfig, url: string): Promise<WgFetchResult> {
    const raw = await this.lib.wgTestClientFetch(JSON.stringify(config), url);
    return parseEnvelope<WgFetchResult>(raw);
  }
}
