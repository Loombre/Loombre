// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/tls/acme-dns01-pebble.integration.spec.ts
//
// REAL end-to-end ACME DNS-01 proof against a real pebble ACME server
// (P4.4 exit bar). This is the OTHER documented DNS-01 mode's real proof
// (the hook-script one — LOOMBRE_ACME_DNS_HOOK): Loombre invokes
// test/tls/pebble/challtestsrv-dns-hook.mjs (a REAL, standalone,
// executable script — not a function reference) with real `set`/`clear`
// argv, that script makes a real HTTP call to pebble-challtestsrv's real
// `/set-txt`/`/clear-txt` management API, pebble performs real DNS-01
// validation by querying challtestsrv's real fake DNS server, and the
// resulting certificate is verified the same real way as the HTTP-01
// suite (chain validated against pebble's per-process ACME issuance
// root, SAN-checked). No port-80 privilege story applies to this suite
// at all — that's DNS-01's whole selling point over HTTP-01, and this
// test proves it structurally: challengeType is dns-01 and no
// Http01ChallengeServer is ever constructed.
//
// The pure hook-script mechanics (argv/env shape, exit-code handling,
// timeout) are unit-tested against a synthetic fixture script in
// src/tls/acme/dns01-hook.spec.ts — this suite is what proves the WHOLE
// chain really moves a real TXT record through a real ACME validation.
//
// Requires `docker compose -f test/tls/pebble/docker-compose.yml up -d`.
// Same graceful-skip / LOOMBRE_REQUIRE_PEBBLE=1 posture as the HTTP-01
// suite — see require-pebble.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pebbleAvailable } from "../support/require-pebble.js";
import {
  CHALLTESTSRV_DNS_ADDRESS,
  CHALLTESTSRV_MANAGEMENT_URL,
  PEBBLE_DIRECTORY_URL,
  fetchPebbleAcmeIssuanceRootPem,
  fetchPebbleListenerCaPem,
} from "./pebble/pebble-env.js";
import { pollTxtRecordVisible, runDnsHook } from "../../src/tls/acme/dns01-hook.js";
import { createTlsRuntime, type TlsRuntime } from "../../src/tls/runtime.js";
import type { TlsConfigAcme } from "../../src/tls/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const available = await pebbleAvailable();

const TEST_DOMAIN = "loombre-f-dns01.acme.test";
const HTTPS_PORT = 3644;
const DNS_HOOK_PATH = join(__dirname, "pebble", "challtestsrv-dns-hook.mjs");

function connectAndReadCert(port: number, caPem: string): Promise<{ cert: tls.PeerCertificate; authorized: boolean; socket: tls.TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, ca: caPem, servername: TEST_DOMAIN }, () => {
      resolve({ cert: socket.getPeerCertificate(), authorized: socket.authorized, socket });
    });
    socket.once("error", reject);
  });
}

describe.skipIf(!available)("ACME DNS-01 against real pebble (hook-script seam)", () => {
  let dataDir: string;
  let listenerCaPem: string;
  let issuanceRootPem: string;
  let runtime: TlsRuntime | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "loombre-pebble-dns01-"));
    listenerCaPem = await fetchPebbleListenerCaPem();
    issuanceRootPem = await fetchPebbleAcmeIssuanceRootPem();
    // Read by test/tls/pebble/challtestsrv-dns-hook.mjs (inherited by
    // runDnsHook's spawned child from this process's env) — see that
    // script's own header for why it's env-driven rather than hardcoded.
    process.env["LOOMBRE_TEST_CHALLTESTSRV_URL"] = CHALLTESTSRV_MANAGEMENT_URL;
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    "issues a real certificate via DNS-01 through the LOOMBRE_ACME_DNS_HOOK seam, and serves real HTTPS with it",
    async () => {
      const openSockets: tls.TLSSocket[] = [];
      try {
        const config: TlsConfigAcme = {
          mode: "acme",
          // http-01 port is irrelevant here — dns-01 never binds one. A
          // deliberately-unbindable-looking value would be a stronger
          // statement, but the field is required by the type; the real
          // structural proof is simply that no Http01ChallengeServer gets
          // constructed, which runtime.ts's own logic guarantees for
          // challengeType !== "http-01".
          httpPort: 0,
          httpsPort: HTTPS_PORT,
          domains: [TEST_DOMAIN],
          challengeType: "dns-01",
          directoryUrl: PEBBLE_DIRECTORY_URL,
          dnsHookPath: DNS_HOOK_PATH,
          renewWindowDays: 30,
          renewCheckIntervalMs: 24 * 60 * 60 * 1000, // no renewal exercised in this suite — HTTP-01's suite already proves that mechanism generically
          dataDir,
          dnsPropagationTimeoutMs: 15_000,
        };

        runtime = await createTlsRuntime(config, (_req, res) => res.end("ok"), {
          log: () => {},
          acmeTestDeps: {
            trustExtraCaPem: listenerCaPem,
            skipChallengeVerification: true,
            dnsPollOverride: { resolverAddresses: [CHALLTESTSRV_DNS_ADDRESS], timeoutMs: 15_000, intervalMs: 500 },
          },
        });
        expect(runtime.server).not.toBeNull();

        await new Promise<void>((resolve, reject) => {
          runtime!.server!.once("error", reject);
          runtime!.server!.listen(HTTPS_PORT, "0.0.0.0", () => resolve());
        });

        const { cert, authorized, socket } = await connectAndReadCert(HTTPS_PORT, issuanceRootPem);
        openSockets.push(socket);
        expect(authorized).toBe(true);
        const x509 = new X509Certificate(cert.raw);
        expect(x509.checkHost(TEST_DOMAIN)).toBe(TEST_DOMAIN);
      } finally {
        for (const socket of openSockets) socket.destroy();
      }
    },
    60_000,
  );

  it("the hook script's set/clear actions are independently real (direct DNS query against challtestsrv, not just inferred from issuance succeeding)", async () => {
    const recordName = `_acme-challenge.hook-direct-check.${TEST_DOMAIN}`;

    await runDnsHook(DNS_HOOK_PATH, "set", recordName, "direct-check-value");
    const seenAfterSet = await pollTxtRecordVisible(recordName, "direct-check-value", {
      resolverAddresses: [CHALLTESTSRV_DNS_ADDRESS],
      timeoutMs: 5000,
      intervalMs: 250,
    });
    expect(seenAfterSet).toBe(true);

    await runDnsHook(DNS_HOOK_PATH, "clear", recordName, "direct-check-value");
    const resolver = new Resolver();
    resolver.setServers([CHALLTESTSRV_DNS_ADDRESS]);
    await expect(resolver.resolveTxt(recordName)).rejects.toThrow();
  });
});
