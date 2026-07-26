// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/tls/acme-http01-pebble.integration.spec.ts
//
// REAL end-to-end ACME HTTP-01 proof against a real pebble ACME server
// (P4.4 exit bar — "a mocked ACME test proves nothing"). Exercises the
// EXACT orchestration main.ts calls (createTlsRuntime), not a hand-rolled
// re-implementation:
//
//   1. Real account creation, real order, real HTTP-01 challenge served
//      by Loombre's own Http01ChallengeServer bound on an unprivileged
//      test port, real validation performed BY PEBBLE connecting across
//      the docker network to the host (PEBBLE_VA_ALWAYS_VALID=0 — nothing
//      is faked), real finalize + real certificate download.
//   2. The issued certificate is verified two ways: (a) its chain
//      actually validates against pebble's own root CA (real crypto, via
//      a real TLS handshake against Loombre's HTTPS server with pebble's
//      root as the ONLY trusted CA — not a string-equality check), and
//      (b) it's genuinely the domain that was requested.
//   3. Renewal: the lane's pebble-config.json (test/tls/pebble/
//      pebble-config.json) issues 300-second-lived certs by design — see
//      that file's header comment — so with a short renewCheckIntervalMs
//      the SAME running createTlsRuntime instance is guaranteed to hit
//      its renewal window on the very next scheduled check. This test
//      waits for that real renewal to land and asserts the served
//      certificate's serial number CHANGES (a real second issuance, real
//      hot-swap via https.Server#setSecureContext) — proven with a live
//      TLS connection reading the actual serving certificate, not by
//      inspecting internal state.
//
// Requires `docker compose -f test/tls/pebble/docker-compose.yml up -d`
// (see that file's header). Gracefully SKIPS (loudly) when pebble isn't
// reachable — same posture as apps/worker's ffmpeg/VT integration suites
// — and LOOMBRE_REQUIRE_PEBBLE=1 escalates an unreachable pebble to a hard
// failure for the CI/owner runs that are supposed to have it up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pebbleAvailable } from "../support/require-pebble.js";
import {
  PEBBLE_DIRECTORY_URL,
  clearAcmeDnsA,
  fetchPebbleAcmeIssuanceRootPem,
  fetchPebbleListenerCaPem,
  registerAcmeDnsA,
  resolveReachableHostIp,
} from "./pebble/pebble-env.js";
import { createTlsRuntime, type TlsRuntime } from "../../src/tls/runtime.js";
import type { TlsConfigAcme } from "../../src/tls/config.js";

const available = await pebbleAvailable();

const TEST_DOMAIN = "loombre-f-http01.acme.test";
const HTTP_PORT = 3680;
const HTTPS_PORT = 3643;

function connectAndReadCert(port: number, caPem: string): Promise<{ cert: tls.PeerCertificate; authorized: boolean; socket: tls.TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, ca: caPem, servername: TEST_DOMAIN }, () => {
      resolve({ cert: socket.getPeerCertificate(), authorized: socket.authorized, socket });
    });
    socket.once("error", reject);
  });
}

describe.skipIf(!available)("ACME HTTP-01 against real pebble", () => {
  let dataDir: string;
  // TWO DISTINCT trust anchors — conflating them was this suite's own
  // first real bug (see pebble-env.ts's fetchPebbleListenerCaPem doc
  // comment for the full story): `listenerCaPem` is what acme-client's
  // axios instance needs to trust to talk to PEBBLE'S OWN API at all;
  // `issuanceRootPem` is the (separate, freshly-generated-per-pebble-
  // process) root that SIGNS the certificates pebble ISSUES, which is
  // what this test's own `connectAndReadCert` needs to trust to verify
  // Loombre's served certificate.
  let listenerCaPem: string;
  let issuanceRootPem: string;
  let runtime: TlsRuntime | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "loombre-pebble-http01-"));
    listenerCaPem = await fetchPebbleListenerCaPem();
    issuanceRootPem = await fetchPebbleAcmeIssuanceRootPem();
    // Verifies real reachability from a container on pebble's own docker
    // network BEFORE registering the DNS override — see pebble-env.ts's
    // resolveReachableHostIp doc comment for why this can't just assume
    // host.docker.internal works (it doesn't, reliably, on this lane's
    // own dev box's custom bridge network under Docker Desktop for Mac).
    const hostIp = await resolveReachableHostIp(HTTP_PORT);
    await registerAcmeDnsA(TEST_DOMAIN, hostIp);
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    await clearAcmeDnsA(TEST_DOMAIN).catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    "issues a real certificate via HTTP-01, serves real HTTPS with it, and renews for real inside one run",
    async () => {
      // Every opened socket is tracked and force-destroyed in `finally` —
      // https.Server#close() waits for open connections to finish, so a
      // socket left open by a failed assertion (thrown before its own
      // `.destroy()` line runs) previously hung this test's `afterAll`
      // (found the hard way: a "Hook timed out in 10000ms" on
      // `runtime.close()`, not a TLS bug at all).
      const openSockets: tls.TLSSocket[] = [];
      const connect = async (): Promise<{ cert: tls.PeerCertificate; authorized: boolean }> => {
        const { cert, authorized, socket } = await connectAndReadCert(HTTPS_PORT, issuanceRootPem);
        openSockets.push(socket);
        return { cert, authorized };
      };

      try {
        const config: TlsConfigAcme = {
          mode: "acme",
          httpPort: HTTP_PORT,
          httpsPort: HTTPS_PORT,
          domains: [TEST_DOMAIN],
          challengeType: "http-01",
          directoryUrl: PEBBLE_DIRECTORY_URL,
          renewWindowDays: 30, // trivially satisfied by a 300s-lived pebble cert (see pebble-config.json)
          renewCheckIntervalMs: 500,
          dataDir,
          dnsPropagationTimeoutMs: 5000,
        };

        runtime = await createTlsRuntime(config, (_req, res) => res.end("ok"), {
          log: () => {},
          acmeTestDeps: { trustExtraCaPem: listenerCaPem, skipChallengeVerification: true },
        });
        expect(runtime.server).not.toBeNull();

        await new Promise<void>((resolve, reject) => {
          runtime!.server!.once("error", reject);
          runtime!.server!.listen(HTTPS_PORT, "0.0.0.0", () => resolve());
        });

        // 1. Real HTTPS serving, real chain validation against pebble's
        // (freshly-generated-per-process) ACME issuance root, real SAN
        // match — modern ACME certs (pebble included) carry an EMPTY
        // legacy Subject DN and put the domain ONLY in the SAN extension,
        // so this checks `checkHost`, not `subject.CN`.
        const first = await connect();
        expect(first.authorized).toBe(true);
        const firstX509 = new X509Certificate(first.cert.raw);
        expect(firstX509.checkHost(TEST_DOMAIN)).toBe(TEST_DOMAIN);
        const firstSerial = first.cert.serialNumber;

        // 2. Renewal: the scheduler ticks every 500ms and this cert is
        // ALWAYS inside a 30-day window (it lives 300s total) — wait for
        // a real second issuance + real hot-swap to land, proven by a NEW
        // TLS connection reading a genuinely different serial number.
        const deadline = Date.now() + 20_000;
        let renewedSerial: string | undefined;
        while (Date.now() < deadline) {
          const attempt = await connect();
          if (attempt.cert.serialNumber !== firstSerial) {
            renewedSerial = attempt.cert.serialNumber;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        expect(renewedSerial, "expected a real renewal (different cert serial) within 20s").toBeDefined();
        expect(renewedSerial).not.toBe(firstSerial);

        // Sanity: the renewed cert is ALSO a real, valid, pebble-issued
        // X509 for the same domain — not e.g. accidentally comparing
        // garbage bytes that merely differ.
        const finalConnect = await connect();
        expect(finalConnect.authorized).toBe(true);
        const finalX509 = new X509Certificate(finalConnect.cert.raw);
        expect(finalX509.checkHost(TEST_DOMAIN)).toBe(TEST_DOMAIN);
      } finally {
        for (const socket of openSockets) socket.destroy();
      }
    },
    60_000,
  );
});
