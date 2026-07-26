// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/storage.spec.ts

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acmeAccountKeyPath, acmeCertKeyPath, acmeCertPath, resolveDataDir, tlsDir } from "./storage.js";

describe("resolveDataDir", () => {
  const original = process.env["LOOMBRE_DATA_DIR"];
  afterEach(() => {
    if (original === undefined) delete process.env["LOOMBRE_DATA_DIR"];
    else process.env["LOOMBRE_DATA_DIR"] = original;
  });
  beforeEach(() => {
    delete process.env["LOOMBRE_DATA_DIR"];
  });

  it("prefers an explicit argument", () => {
    expect(resolveDataDir("/explicit/dir")).toBe("/explicit/dir");
  });

  it("falls back to LOOMBRE_DATA_DIR", () => {
    process.env["LOOMBRE_DATA_DIR"] = "/env/dir";
    expect(resolveDataDir()).toBe("/env/dir");
  });

  it("falls back to './data' when neither is set", () => {
    expect(resolveDataDir()).toBe("./data");
  });
});

describe("tls path helpers", () => {
  it("all live under <dataDir>/tls", () => {
    expect(tlsDir("/data")).toBe("/data/tls");
    expect(acmeAccountKeyPath("/data")).toBe("/data/tls/acme-account-key.pem");
    expect(acmeCertKeyPath("/data")).toBe("/data/tls/acme-cert-key.pem");
    expect(acmeCertPath("/data")).toBe("/data/tls/acme-cert.pem");
  });

  it("account key / cert / cert key are three distinct files", () => {
    const paths = new Set([acmeAccountKeyPath("/data"), acmeCertKeyPath("/data"), acmeCertPath("/data")]);
    expect(paths.size).toBe(3);
  });
});
