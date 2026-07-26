// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/cert-store.spec.ts

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSelfSignedCert, type SelfSignedCert } from "../test-support/self-signed-cert.js";
import { acmeCertKeyPath, acmeCertPath } from "../storage.js";
import { loadPersistedCertificate, persistIssuedCertificate } from "./cert-store.js";

let dataDir: string;
let selfSigned: SelfSignedCert;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "loombre-cert-store-"));
  selfSigned = generateSelfSignedCert("cert-store.loombre.test");
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  selfSigned.cleanup();
});

describe("loadPersistedCertificate", () => {
  it("returns undefined when nothing has been persisted yet", () => {
    expect(loadPersistedCertificate(dataDir)).toBeUndefined();
  });

  it("returns undefined when only the cert (not the key) exists", () => {
    persistIssuedCertificate(dataDir, { certPem: selfSigned.cert, keyPem: selfSigned.key, notBeforeMs: 0, notAfterMs: 0 });
    rmSync(acmeCertKeyPath(dataDir));
    expect(loadPersistedCertificate(dataDir)).toBeUndefined();
  });
});

describe("persistIssuedCertificate + loadPersistedCertificate round-trip", () => {
  it("round-trips cert/key content exactly, and derives notBefore/notAfter from the REAL cert (not the input values)", () => {
    persistIssuedCertificate(dataDir, {
      certPem: selfSigned.cert,
      keyPem: selfSigned.key,
      notBeforeMs: 123, // deliberately wrong — loadPersistedCertificate must not trust cached metadata
      notAfterMs: 456,
    });

    const loaded = loadPersistedCertificate(dataDir);
    expect(loaded).toBeDefined();
    expect(loaded?.certPem).toBe(selfSigned.cert);
    expect(loaded?.keyPem).toBe(selfSigned.key);
    // Real cert: -days 1, so notAfter is ~1 day after notBefore, and both
    // are real recent timestamps — nowhere near the bogus 123/456 input.
    expect(loaded!.notAfterMs).toBeGreaterThan(Date.now());
    expect(loaded!.notAfterMs - loaded!.notBeforeMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(loaded!.notAfterMs - loaded!.notBeforeMs).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("persists both files 0600", () => {
    persistIssuedCertificate(dataDir, { certPem: selfSigned.cert, keyPem: selfSigned.key, notBeforeMs: 0, notAfterMs: 0 });
    expect(statSync(acmeCertPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(statSync(acmeCertKeyPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("re-persisting (renewal) overwrites and stays 0600", () => {
    persistIssuedCertificate(dataDir, { certPem: selfSigned.cert, keyPem: selfSigned.key, notBeforeMs: 0, notAfterMs: 0 });
    const renewed = generateSelfSignedCert("renewed.loombre.test");
    try {
      persistIssuedCertificate(dataDir, { certPem: renewed.cert, keyPem: renewed.key, notBeforeMs: 0, notAfterMs: 0 });
      const loaded = loadPersistedCertificate(dataDir);
      expect(loaded?.certPem).toBe(renewed.cert);
      expect(statSync(acmeCertPath(dataDir)).mode & 0o777).toBe(0o600);
    } finally {
      renewed.cleanup();
    }
  });
});
