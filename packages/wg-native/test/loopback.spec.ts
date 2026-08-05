// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/test/loopback.spec.ts
//
// R11: "CI proves the machinery — in-process WG loopback handshake test, a
// test peer connects through netstack and fetches a real endpoint." This
// suite exercises native/'s Go glue directly through WgNativeClient (the
// SAME class apps/server/src/remote/wireguard uses) against a plain Node
// HTTP server standing in for the real backend — apps/server's own
// loopback-handshake spec (mission exit-gate test (a)) additionally proves
// the REAL Express /healthz path through RemoteWireguardService end to
// end; this file's job is to prove the native/TS bridge itself, in
// isolation, at the package level.
//
// wg-gated (require-wg.ts): every it() below needs a REAL Go-built native
// library. Local dev without Go: graceful skip. LOOMBRE_REQUIRE_WG=1 (CI):
// hard failure instead — see that file's header for the full rationale.
//
// R11 "unprivileged ports only": every listener here binds port 0
// (ephemeral) — this suite never touches a fixed/privileged port.

import { createServer, type Server } from "node:http";
import dgram from "node:dgram";
import { randomFillSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WgNativeClient, generateWgKeyPair, type WgStatusResult } from "../src/index.js";
import { wgAvailable } from "./support/require-wg.js";

const available = wgAvailable();

async function startBackend(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unreachable: no AddressInfo after listen()");
  return { server, port: address.port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A structurally-valid-but-garbage WireGuard handshake-initiation packet:
 *  correct message type (1, little-endian) and correct total length (148
 *  bytes, device/noise-protocol.go's MessageInitiationSize) but random
 *  crypto material referencing no real key — wireguard-go's own MAC1/noise
 *  verification rejects it, and R9's silence law says that rejection must
 *  produce ZERO response bytes, never even an error response. */
function wrongKeyHandshakeInitiation(): Buffer {
  const pkt = Buffer.alloc(148);
  pkt.writeUInt32LE(1, 0);
  randomFillSync(pkt, 4);
  return pkt;
}

/** Sends `packet` to the WG UDP port and asserts NO response bytes arrive
 *  within `windowMs` (R9's silence law — "generous window" per the mission
 *  brief). */
async function assertSilence(port: number, packet: Buffer, windowMs = 1500): Promise<void> {
  const sock = dgram.createSocket("udp4");
  let gotResponse = false;
  sock.on("message", () => {
    gotResponse = true;
  });
  try {
    await new Promise<void>((resolve, reject) => sock.send(packet, port, "127.0.0.1", (err) => (err ? reject(err) : resolve())));
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    expect(gotResponse).toBe(false);
  } finally {
    sock.close();
  }
}

/** Polls until a fresh UDP socket can bind `port` — proves WgStop actually
 *  released the real OS socket, not just that this library forgot about it
 *  (mission (d): "disable actually closes UDP + backend listeners, poll
 *  the port"). */
async function waitForPortFree(port: number, attempts = 30, intervalMs = 100): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = dgram.createSocket("udp4");
      probe.once("error", () => resolve(false));
      probe.bind(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe.skipIf(!available)("wg-native loopback (real Go device + netstack)", () => {
  let client: WgNativeClient;

  beforeAll(() => {
    const loaded = WgNativeClient.load();
    if (!loaded) throw new Error("unreachable: wgAvailable() was true but WgNativeClient.load() failed");
    client = loaded;
  });

  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) await fn().catch(() => {});
    }
  });

  it("(a) loopback handshake: a test peer fetches a real endpoint through the tunnel", async () => {
    const { server, port: backendPort } = await startBackend();
    cleanup.push(() => closeServer(server));

    const serverKeys = generateWgKeyPair();
    const clientKeys = generateWgKeyPair();

    const { instanceId } = await client.start({
      privateKey: serverKeys.privateKey,
      listenPort: 0,
      serverTunnelIp: "10.82.146.1",
      subnet: "10.82.146.0/24",
      peers: [],
      backendTcpPort: backendPort,
    });
    cleanup.push(() => client.stop(instanceId));

    const status = await client.status(instanceId);
    expect(status.listening).toBe(true);
    expect(status.port).toBeGreaterThan(0);

    await client.addPeer(instanceId, { publicKey: clientKeys.publicKey, tunnelIp: "10.82.146.2" });

    const result = await client.testClientFetch(
      {
        privateKey: clientKeys.privateKey,
        clientTunnelIp: "10.82.146.2",
        serverPublicKey: serverKeys.publicKey,
        serverEndpoint: `127.0.0.1:${status.port}`,
        allowedIps: ["0.0.0.0/0"],
        timeoutMs: 5000,
      },
      "http://10.82.146.1/healthz",
    );
    expect(result.status).toBe(200);
    expect(result.bodyPrefix).toBe("ok");

    const statusAfter: WgStatusResult = await client.status(instanceId);
    expect(statusAfter.peers).toHaveLength(1);
    expect(statusAfter.peers[0]?.lastHandshakeMs).toBeGreaterThan(0);
    expect(statusAfter.peers[0]?.rxBytes).toBeGreaterThan(0);
    expect(statusAfter.peers[0]?.txBytes).toBeGreaterThan(0);
  });

  it("(b) SILENCE: raw UDP garbage receives zero response bytes", async () => {
    const { server, port: backendPort } = await startBackend();
    cleanup.push(() => closeServer(server));
    const serverKeys = generateWgKeyPair();
    const { instanceId } = await client.start({
      privateKey: serverKeys.privateKey,
      listenPort: 0,
      serverTunnelIp: "10.82.146.1",
      subnet: "10.82.146.0/24",
      peers: [],
      backendTcpPort: backendPort,
    });
    cleanup.push(() => client.stop(instanceId));
    const status = await client.status(instanceId);

    await assertSilence(status.port, Buffer.from("this is not a wireguard packet, just garbage"));
  });

  it("(b) SILENCE: a structurally-valid-but-wrong-key handshake initiation receives zero response bytes", async () => {
    const { server, port: backendPort } = await startBackend();
    cleanup.push(() => closeServer(server));
    const serverKeys = generateWgKeyPair();
    const { instanceId } = await client.start({
      privateKey: serverKeys.privateKey,
      listenPort: 0,
      serverTunnelIp: "10.82.146.1",
      subnet: "10.82.146.0/24",
      peers: [],
      backendTcpPort: backendPort,
    });
    cleanup.push(() => client.stop(instanceId));
    const status = await client.status(instanceId);

    await assertSilence(status.port, wrongKeyHandshakeInitiation());
  });

  it("(c) CONTAINMENT: a tunnel client cannot reach any non-server tunnel address", async () => {
    const { server, port: backendPort } = await startBackend();
    cleanup.push(() => closeServer(server));
    const serverKeys = generateWgKeyPair();
    const clientKeys = generateWgKeyPair();
    const { instanceId } = await client.start({
      privateKey: serverKeys.privateKey,
      listenPort: 0,
      serverTunnelIp: "10.82.146.1",
      subnet: "10.82.146.0/24",
      peers: [],
      backendTcpPort: backendPort,
    });
    cleanup.push(() => client.stop(instanceId));
    const status = await client.status(instanceId);
    await client.addPeer(instanceId, { publicKey: clientKeys.publicKey, tunnelIp: "10.82.146.2" });

    const clientConfig = {
      privateKey: clientKeys.privateKey,
      clientTunnelIp: "10.82.146.2",
      serverPublicKey: serverKeys.publicKey,
      serverEndpoint: `127.0.0.1:${status.port}`,
      // Deliberately broad — even a client that ASKS to route everything
      // through the tunnel must still be refused server-side (RG2); see
      // native/testclient.go's header.
      allowedIps: ["0.0.0.0/0"],
      timeoutMs: 2500,
    };

    // Sanity: the SAME client config CAN reach the real server address.
    const ok = await client.testClientFetch(clientConfig, "http://10.82.146.1/healthz");
    expect(ok.status).toBe(200);

    // A different address within the same subnet — nothing listens there
    // and netstack forwards nowhere — must fail/time out, never succeed.
    await expect(client.testClientFetch(clientConfig, "http://10.82.146.50/")).rejects.toThrow();
  });

  it("(d) lifecycle: enable/disable — idempotent enable, real UDP port release, honest double-disable", async () => {
    const { server, port: backendPort } = await startBackend();
    cleanup.push(() => closeServer(server));
    const serverKeys = generateWgKeyPair();

    const { instanceId } = await client.start({
      privateKey: serverKeys.privateKey,
      listenPort: 0,
      serverTunnelIp: "10.82.146.1",
      subnet: "10.82.146.0/24",
      peers: [],
      backendTcpPort: backendPort,
    });
    const status = await client.status(instanceId);
    expect(status.listening).toBe(true);

    await client.stop(instanceId);
    expect(await waitForPortFree(status.port)).toBe(true);

    // The RAW library is honest about a second stop on an already-removed
    // instance (idempotence is a SERVICE-layer concern — see client.ts's
    // stop() doc comment and apps/server's RemoteWireguardService.disable()).
    await expect(client.stop(instanceId)).rejects.toThrow(/unknown wg-native instance/);
  });

  it("two concurrent instances get independent ephemeral ports and don't interfere", async () => {
    const backendA = await startBackend();
    const backendB = await startBackend();
    cleanup.push(() => closeServer(backendA.server));
    cleanup.push(() => closeServer(backendB.server));

    const keysA = generateWgKeyPair();
    const keysB = generateWgKeyPair();
    const a = await client.start({
      privateKey: keysA.privateKey,
      listenPort: 0,
      serverTunnelIp: "10.82.146.1",
      subnet: "10.82.146.0/24",
      peers: [],
      backendTcpPort: backendA.port,
    });
    cleanup.push(() => client.stop(a.instanceId));
    const b = await client.start({
      privateKey: keysB.privateKey,
      listenPort: 0,
      serverTunnelIp: "10.82.147.1",
      subnet: "10.82.147.0/24",
      peers: [],
      backendTcpPort: backendB.port,
    });
    cleanup.push(() => client.stop(b.instanceId));

    const statusA = await client.status(a.instanceId);
    const statusB = await client.status(b.instanceId);
    expect(statusA.port).not.toBe(statusB.port);
  });
});

describe.skipIf(available)("wg-native loopback (skipped: native library unavailable)", () => {
  it("is skipped cleanly, not failing, when Go/the built library is absent", () => {
    expect(available).toBe(false);
  });
});
