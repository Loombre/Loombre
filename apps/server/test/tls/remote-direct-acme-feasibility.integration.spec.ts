// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/tls/remote-direct-acme-feasibility.integration.spec.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG12): "D1 ground-truths pre-flip
// issuance feasibility ... this is the lane's hard part." THE QUESTION this
// file answers empirically, against a REAL ACME server (not a mock): can
// apps/server/src/tls/acme/issue-certificate.ts's issueCertificate() run
// AD HOC — outside main.ts's boot path, outside createTlsRuntime, with NO
// tls.mode flip — and produce a real certificate the normal cert store
// (apps/server/src/tls/acme/cert-store.ts) can then serve at the next real
// boot? YES — this test proves it end-to-end, using the EXACT call shape
// apps/server/src/remote/remote-direct.controller.ts's testRemoteDirectAcme
// uses (a fresh Http01ChallengeServer bound for the duration of one call,
// issueCertificate(config, {http01Server, log}), persistIssuedCertificate
// on success): only test-only extras are trustExtraCaPem (pebble's own API
// uses a self-signed cert — production Let's Encrypt doesn't need this) and
// skipChallengeVerification (acme-client's own pre-flight self-check can't
// resolve a pebble-only DNS override from this host — see
// issue-certificate.ts's own doc comment on that flag; the CA's real
// validation, which DOES use the correct resolver, is never skipped).
//
// Same graceful-skip posture as acme-http01-pebble.integration.spec.ts:
// requires `docker compose -f test/tls/pebble/docker-compose.yml up -d`;
// LOOMBRE_REQUIRE_PEBBLE=1 escalates an unreachable pebble to a hard
// failure instead of a silent skip.
//
// PORT GROUND TRUTH (found empirically building this file): pebble's HTTP-01
// validator connects to a FIXED port baked into pebble-config.json
// (httpPort: 3680) — it is NOT parameterized per ACME order/domain, so this
// suite must bind the SAME port acme-http01-pebble.integration.spec.ts uses
// rather than an arbitrary free one (a first attempt at port 3690 here
// produced a real "connection refused" from pebble, which was trying 3680
// exactly as configured — recorded as a ground-truth finding, not guessed).
// Consequence: this suite cannot run CONCURRENTLY with
// acme-http01-pebble.integration.spec.ts (both would bind :3680) — fine for
// this repo's suite, which does not run pebble integration specs in
// parallel against each other (`--pool=threads` default here still runs
// separate FILES as separate workers, but only one process at a time ever
// holds the port in practice for this repo's CI invocation; a genuine
// concurrent run would EADDRINUSE loudly, never silently corrupt a result).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pebbleAvailable } from "../support/require-pebble.js";
import { PEBBLE_DIRECTORY_URL, fetchPebbleListenerCaPem, registerAcmeDnsA, clearAcmeDnsA, resolveReachableHostIp } from "./pebble/pebble-env.js";
import { issueCertificate } from "../../src/tls/acme/issue-certificate.js";
import { Http01ChallengeServer } from "../../src/tls/acme/http01-server.js";
import { loadPersistedCertificate, persistIssuedCertificate } from "../../src/tls/acme/cert-store.js";
import type { TlsConfigAcme } from "../../src/tls/config.js";

const available = await pebbleAvailable();

const TEST_DOMAIN = "loombre-d1-direct-staged-test.acme.test";
// MUST match pebble-config.json's fixed httpPort — see this file's header.
const HTTP_PORT = 3680;

describe.skipIf(!available)("RG12 feasibility: ad hoc staged ACME issuance, exactly as remote-direct.controller.ts calls it", () => {
  let dataDir: string;
  let listenerCaPem: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "loombre-remote-direct-feasibility-"));
    listenerCaPem = await fetchPebbleListenerCaPem();
    const hostIp = await resolveReachableHostIp(HTTP_PORT);
    await registerAcmeDnsA(TEST_DOMAIN, hostIp);
  }, 30_000);

  afterAll(async () => {
    await clearAcmeDnsA(TEST_DOMAIN).catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    "issues a real certificate ad hoc (no TLS runtime, no tls.mode) and persists it where the boot-time runtime will find it",
    async () => {
      const config: TlsConfigAcme = {
        mode: "acme",
        httpPort: HTTP_PORT,
        httpsPort: 3691, // unused by issueCertificate itself; only Http01ChallengeServer's redirect target
        domains: [TEST_DOMAIN],
        challengeType: "http-01",
        directoryUrl: PEBBLE_DIRECTORY_URL,
        renewWindowDays: 30,
        renewCheckIntervalMs: 86_400_000,
        dataDir,
        dnsPropagationTimeoutMs: 5000,
      };

      // The EXACT shape testRemoteDirectAcme uses: a fresh Http01ChallengeServer
      // for the duration of this one call, closed in `finally` regardless of
      // outcome — proving the "ad hoc, no boot-time listener reuse" story.
      const http01Server = new Http01ChallengeServer({ redirectHttpsPort: config.httpsPort });
      try {
        await http01Server.listen(config.httpPort);
        expect(http01Server.isListening).toBe(true);

        const issued = await issueCertificate(config, {
          http01Server,
          log: () => {},
          trustExtraCaPem: listenerCaPem,
          skipChallengeVerification: true,
        });

        expect(issued.notAfterMs).toBeGreaterThan(Date.now());
        const x509 = new X509Certificate(issued.certPem);
        expect(x509.checkHost(TEST_DOMAIN)).toBe(TEST_DOMAIN);

        // The SAME store apps/server/src/tls/runtime.ts's boot-time
        // createTlsRuntime reads from — proving a staged test today means
        // the real ACME runtime finds a ready certificate at the next
        // restart, no re-issuance needed.
        persistIssuedCertificate(config.dataDir, issued);
        const persisted = loadPersistedCertificate(config.dataDir);
        expect(persisted).toBeDefined();
        expect(persisted!.certPem).toBe(issued.certPem);
        expect(new X509Certificate(persisted!.certPem).checkHost(TEST_DOMAIN)).toBe(TEST_DOMAIN);
      } finally {
        await http01Server.close();
      }
    },
    30_000,
  );
});
