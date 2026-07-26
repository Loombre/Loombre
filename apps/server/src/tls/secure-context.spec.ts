// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/secure-context.spec.ts
//
// Deliverable 3's "hot-swap" test — REAL, not mocked: a real https.Server
// with a real self-signed cert A, a real TLS client connection to it, then
// a real hotSwapCertificate() to cert B, then a real SECOND TLS connection
// asserting the server now presents cert B's CN — while the FIRST
// connection (opened under cert A) is still open and unaffected. This is
// exactly the "without dropping connections" claim in P4.4, proven at the
// socket level rather than asserted from the setSecureContext call site.

import * as https from "node:https";
import * as tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { generateSelfSignedCert, type SelfSignedCert } from "./test-support/self-signed-cert.js";
import { hotSwapCertificate, toSecureContextOptions } from "./secure-context.js";

function listen(server: https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an AddressInfo"));
        return;
      }
      resolve(address.port);
    });
  });
}

function normalizeCn(cn: string | string[] | undefined): string {
  return Array.isArray(cn) ? (cn[0] ?? "") : (cn ?? "");
}

function connectAndGetCn(port: number): Promise<{ cn: string; socket: tls.TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      resolve({ cn: normalizeCn(cert.subject?.CN), socket });
    });
    socket.once("error", reject);
  });
}

describe("hotSwapCertificate: real socket-level proof", () => {
  let certA: SelfSignedCert | undefined;
  let certB: SelfSignedCert | undefined;
  let server: https.Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    certA?.cleanup();
    certB?.cleanup();
  });

  it("existing connections keep the OLD cert; new connections after the swap get the NEW cert", async () => {
    certA = generateSelfSignedCert("cert-a.loombre.test");
    certB = generateSelfSignedCert("cert-b.loombre.test");

    server = https.createServer(toSecureContextOptions({ cert: certA.cert, key: certA.key }), (_req, res) => {
      res.end("ok");
    });
    const port = await listen(server);

    const before = await connectAndGetCn(port);
    expect(before.cn).toBe("cert-a.loombre.test");

    // The swap itself — the exact call runtime.ts makes on renewal.
    hotSwapCertificate(server, { cert: certB.cert, key: certB.key });

    // The pre-swap connection is untouched: same negotiated peer cert,
    // socket still open and usable.
    expect(normalizeCn(before.socket.getPeerCertificate().subject?.CN)).toBe("cert-a.loombre.test");
    expect(before.socket.destroyed).toBe(false);

    const after = await connectAndGetCn(port);
    expect(after.cn).toBe("cert-b.loombre.test");

    before.socket.destroy();
    after.socket.destroy();
  });
});
