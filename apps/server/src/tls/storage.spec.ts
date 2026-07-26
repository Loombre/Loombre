// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/storage.spec.ts

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
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
  // These helpers build HOST-NATIVE paths (node:path join), so expectations
  // are join()-built rather than POSIX literals — the literal form passed on
  // ubuntu/macOS and failed the first windows-latest CI run
  // ('\data\tls' vs '/data/tls'). Native separators on Windows are correct:
  // these paths are opened and written for real.
  it("all live under <dataDir>/tls", () => {
    expect(tlsDir("/data")).toBe(join("/data", "tls"));
    expect(acmeAccountKeyPath("/data")).toBe(join("/data", "tls", "acme-account-key.pem"));
    expect(acmeCertKeyPath("/data")).toBe(join("/data", "tls", "acme-cert-key.pem"));
    expect(acmeCertPath("/data")).toBe(join("/data", "tls", "acme-cert.pem"));
  });

  it("account key / cert / cert key are three distinct files", () => {
    const paths = new Set([acmeAccountKeyPath("/data"), acmeCertKeyPath("/data"), acmeCertPath("/data")]);
    expect(paths.size).toBe(3);
  });
});
