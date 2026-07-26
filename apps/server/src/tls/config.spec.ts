// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/config.spec.ts
//
// Mode-selection + validation matrix (deliverable 3's "unit: mode
// selection"). Every case constructs a plain env object — never touches
// process.env — so this suite has zero interaction with any other file's
// env-var state.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ACME_DIRECTORY_URL_PRODUCTION,
  DEFAULT_ACME_DIRECTORY_URL_STAGING,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  loadTlsConfig,
  TlsConfigError,
} from "./config.js";

let tmpDir: string | undefined;
function makeTmpFile(name: string): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), "loombre-tls-config-"));
  const path = join(tmpDir, name);
  writeFileSync(path, "placeholder");
  return path;
}

afterEach(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("loadTlsConfig: off (default)", () => {
  it("defaults to off when LOOMBRE_TLS_MODE is unset", () => {
    expect(loadTlsConfig({})).toEqual({ mode: "off" });
  });

  it("is off for an empty string or the literal 'off'", () => {
    expect(loadTlsConfig({ LOOMBRE_TLS_MODE: "" })).toEqual({ mode: "off" });
    expect(loadTlsConfig({ LOOMBRE_TLS_MODE: "off" })).toEqual({ mode: "off" });
    expect(loadTlsConfig({ LOOMBRE_TLS_MODE: "OFF" })).toEqual({ mode: "off" });
  });

  it("off mode reads nothing else — an otherwise-invalid env doesn't throw", () => {
    expect(() =>
      loadTlsConfig({ LOOMBRE_TLS_MODE: "off", LOOMBRE_HTTPS_PORT: "not-a-port" }),
    ).not.toThrow();
  });

  it("rejects an unrecognized mode", () => {
    expect(() => loadTlsConfig({ LOOMBRE_TLS_MODE: "auto" })).toThrow(TlsConfigError);
  });
});

describe("loadTlsConfig: manual", () => {
  it("requires LOOMBRE_TLS_CERT_PATH and LOOMBRE_TLS_KEY_PATH", () => {
    expect(() => loadTlsConfig({ LOOMBRE_TLS_MODE: "manual" })).toThrow(/LOOMBRE_TLS_CERT_PATH/);
    expect(() =>
      loadTlsConfig({ LOOMBRE_TLS_MODE: "manual", LOOMBRE_TLS_CERT_PATH: makeTmpFile("cert.pem") }),
    ).toThrow(/LOOMBRE_TLS_KEY_PATH/);
  });

  it("requires both paths to be absolute", () => {
    expect(() =>
      loadTlsConfig({
        LOOMBRE_TLS_MODE: "manual",
        LOOMBRE_TLS_CERT_PATH: "relative/cert.pem",
        LOOMBRE_TLS_KEY_PATH: makeTmpFile("key.pem"),
      }),
    ).toThrow(/absolute/);
  });

  it("requires the files to actually exist", () => {
    expect(() =>
      loadTlsConfig({
        LOOMBRE_TLS_MODE: "manual",
        LOOMBRE_TLS_CERT_PATH: "/nonexistent/cert.pem",
        LOOMBRE_TLS_KEY_PATH: makeTmpFile("key.pem"),
      }),
    ).toThrow(/does not exist/);
  });

  it("resolves a full config with defaults when only the required paths are set", () => {
    const certPath = makeTmpFile("cert.pem");
    const keyPath = makeTmpFile("key.pem");
    const config = loadTlsConfig({ LOOMBRE_TLS_MODE: "manual", LOOMBRE_TLS_CERT_PATH: certPath, LOOMBRE_TLS_KEY_PATH: keyPath });
    expect(config).toEqual({
      mode: "manual",
      httpsPort: DEFAULT_HTTPS_PORT,
      certPath,
      keyPath,
      reloadDebounceMs: 500,
    });
  });

  it("accepts an optional CA path and a custom port + debounce", () => {
    const certPath = makeTmpFile("cert.pem");
    const keyPath = makeTmpFile("key.pem");
    const caPath = makeTmpFile("ca.pem");
    const config = loadTlsConfig({
      LOOMBRE_TLS_MODE: "manual",
      LOOMBRE_TLS_CERT_PATH: certPath,
      LOOMBRE_TLS_KEY_PATH: keyPath,
      LOOMBRE_TLS_CA_PATH: caPath,
      LOOMBRE_HTTPS_PORT: "3643",
      LOOMBRE_TLS_RELOAD_DEBOUNCE_MS: "50",
    });
    expect(config).toEqual({
      mode: "manual",
      httpsPort: 3643,
      certPath,
      keyPath,
      caPath,
      reloadDebounceMs: 50,
    });
  });

  it("rejects an out-of-range port", () => {
    const certPath = makeTmpFile("cert.pem");
    const keyPath = makeTmpFile("key.pem");
    expect(() =>
      loadTlsConfig({ LOOMBRE_TLS_MODE: "manual", LOOMBRE_TLS_CERT_PATH: certPath, LOOMBRE_TLS_KEY_PATH: keyPath, LOOMBRE_HTTPS_PORT: "70000" }),
    ).toThrow(TlsConfigError);
  });
});

const acmeBaseEnv = {
  LOOMBRE_TLS_MODE: "acme",
  LOOMBRE_ACME_DOMAINS: "media.example.com",
  LOOMBRE_ACME_CHALLENGE_TYPE: "http-01",
  LOOMBRE_ACME_TOS_AGREED: "1",
} as const;

describe("loadTlsConfig: acme", () => {
  it("requires LOOMBRE_ACME_DOMAINS", () => {
    expect(() => loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_DOMAINS: undefined })).toThrow(/LOOMBRE_ACME_DOMAINS/);
  });

  it("requires LOOMBRE_ACME_CHALLENGE_TYPE to be http-01 or dns-01", () => {
    expect(() => loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_CHALLENGE_TYPE: "tls-alpn-01" })).toThrow(
      /http-01.*dns-01/,
    );
  });

  it("requires LOOMBRE_ACME_TOS_AGREED — refuses to silently agree to the CA's ToS", () => {
    expect(() => loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_TOS_AGREED: undefined })).toThrow(/LOOMBRE_ACME_TOS_AGREED/);
    expect(() => loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_TOS_AGREED: "0" })).toThrow(/LOOMBRE_ACME_TOS_AGREED/);
  });

  it("splits, trims, and lowercases a comma-separated domain list", () => {
    const config = loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_DOMAINS: " Media.Example.com , cdn.example.com ,," });
    expect(config.mode).toBe("acme");
    if (config.mode !== "acme") throw new Error("unreachable");
    expect(config.domains).toEqual(["media.example.com", "cdn.example.com"]);
  });

  it("defaults to production LE directory, and staging via LOOMBRE_ACME_STAGING", () => {
    const prod = loadTlsConfig({ ...acmeBaseEnv });
    if (prod.mode !== "acme") throw new Error("unreachable");
    expect(prod.directoryUrl).toBe(DEFAULT_ACME_DIRECTORY_URL_PRODUCTION);

    const staging = loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_STAGING: "1" });
    if (staging.mode !== "acme") throw new Error("unreachable");
    expect(staging.directoryUrl).toBe(DEFAULT_ACME_DIRECTORY_URL_STAGING);
  });

  it("an explicit LOOMBRE_ACME_DIRECTORY_URL overrides staging/production entirely (pebble's own directory)", () => {
    const config = loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_DIRECTORY_URL: "https://localhost:14000/dir" });
    if (config.mode !== "acme") throw new Error("unreachable");
    expect(config.directoryUrl).toBe("https://localhost:14000/dir");
  });

  it("rejects LOOMBRE_ACME_DNS_HOOK when the challenge type is http-01", () => {
    expect(() => loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_DNS_HOOK: "/bin/true" })).toThrow(
      /only meaningful when.*dns-01/,
    );
  });

  it("accepts LOOMBRE_ACME_DNS_HOOK for dns-01 and leaves it unset -> manual mode otherwise", () => {
    const withHook = loadTlsConfig({
      ...acmeBaseEnv,
      LOOMBRE_ACME_CHALLENGE_TYPE: "dns-01",
      LOOMBRE_ACME_DNS_HOOK: "/usr/local/bin/loombre-dns-hook",
    });
    if (withHook.mode !== "acme") throw new Error("unreachable");
    expect(withHook.dnsHookPath).toBe("/usr/local/bin/loombre-dns-hook");

    const manual = loadTlsConfig({ ...acmeBaseEnv, LOOMBRE_ACME_CHALLENGE_TYPE: "dns-01" });
    if (manual.mode !== "acme") throw new Error("unreachable");
    expect(manual.dnsHookPath).toBeUndefined();
  });

  it("resolves default ports/windows/intervals", () => {
    const config = loadTlsConfig({ ...acmeBaseEnv });
    if (config.mode !== "acme") throw new Error("unreachable");
    expect(config.httpPort).toBe(DEFAULT_HTTP_PORT);
    expect(config.httpsPort).toBe(DEFAULT_HTTPS_PORT);
    expect(config.renewWindowDays).toBe(30);
    expect(config.renewCheckIntervalMs).toBe(24 * 60 * 60 * 1000);
    expect(config.email).toBeUndefined();
  });

  it("overrides ports (the unprivileged-test-port story) and every tunable", () => {
    const config = loadTlsConfig({
      ...acmeBaseEnv,
      LOOMBRE_HTTP_PORT: "3680",
      LOOMBRE_HTTPS_PORT: "3643",
      LOOMBRE_ACME_EMAIL: " ops@example.com ",
      LOOMBRE_ACME_RENEW_WINDOW_DAYS: "10",
      LOOMBRE_ACME_RENEW_CHECK_INTERVAL_MS: "1000",
      LOOMBRE_ACME_DNS_PROPAGATION_TIMEOUT_MS: "5000",
      LOOMBRE_DATA_DIR: "/tmp/loombre-acme-data",
    });
    if (config.mode !== "acme") throw new Error("unreachable");
    expect(config.httpPort).toBe(3680);
    expect(config.httpsPort).toBe(3643);
    expect(config.email).toBe("ops@example.com");
    expect(config.renewWindowDays).toBe(10);
    expect(config.renewCheckIntervalMs).toBe(1000);
    expect(config.dnsPropagationTimeoutMs).toBe(5000);
    expect(config.dataDir).toBe("/tmp/loombre-acme-data");
  });
});
