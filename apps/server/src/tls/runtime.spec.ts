// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/runtime.spec.ts
//
// The off/manual branches of createTlsRuntime, real end-to-end (real
// https.Server, real TLS handshake against it). The acme branch is
// deliberately NOT unit-tested here with a fake ACME client — this
// project's whole point is that "a mocked ACME test proves nothing"
// (mission text); its real coverage lives in
// apps/server/test/tls/acme-pebble.integration.spec.ts against a real
// pebble ACME server.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { generateSelfSignedCert, type SelfSignedCert } from "./test-support/self-signed-cert.js";
import { createTlsRuntime } from "./runtime.js";

function normalizeCn(cn: string | string[] | undefined): string {
  return Array.isArray(cn) ? (cn[0] ?? "") : (cn ?? "");
}

function connectAndGetCn(port: number): Promise<{ cn: string; socket: tls.TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      resolve({ cn: normalizeCn(socket.getPeerCertificate().subject?.CN), socket });
    });
    socket.once("error", reject);
  });
}

describe("createTlsRuntime: off", () => {
  it("returns server=null and a no-op close()", async () => {
    const runtime = await createTlsRuntime({ mode: "off" }, (_req, res) => res.end("ok"));
    expect(runtime.server).toBeNull();
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

describe("createTlsRuntime: manual", () => {
  let dir: string;
  let cert: SelfSignedCert;
  let closeRuntime: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeRuntime?.();
    rmSync(dir, { recursive: true, force: true });
    cert?.cleanup();
  });

  it("serves the configured cert over a real TLS connection, and hot-reloads on file change", async () => {
    dir = mkdtempSync(join(tmpdir(), "loombre-tls-runtime-manual-"));
    cert = generateSelfSignedCert("manual-runtime.loombre.test");
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, cert.cert);
    writeFileSync(keyPath, cert.key);

    const runtime = await createTlsRuntime(
      { mode: "manual", httpsPort: 0, certPath, keyPath, reloadDebounceMs: 30 },
      (_req, res) => res.end("ok"),
      { log: () => {} },
    );
    closeRuntime = runtime.close;
    expect(runtime.server).not.toBeNull();

    await new Promise<void>((resolve, reject) => {
      runtime.server!.once("error", reject);
      runtime.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = runtime.server!.address();
    if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

    const first = await connectAndGetCn(address.port);
    expect(first.cn).toBe("manual-runtime.loombre.test");
    first.socket.destroy();

    const rotated = generateSelfSignedCert("manual-runtime-rotated.loombre.test");
    try {
      writeFileSync(certPath, rotated.cert);
      writeFileSync(keyPath, rotated.key);

      const deadline = Date.now() + 3000;
      let cn = "";
      while (Date.now() < deadline) {
        const attempt = await connectAndGetCn(address.port);
        cn = attempt.cn;
        attempt.socket.destroy();
        if (cn === "manual-runtime-rotated.loombre.test") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(cn).toBe("manual-runtime-rotated.loombre.test");
    } finally {
      rotated.cleanup();
    }
  });
});
