// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/config.ts
//
// LOOMBRE_TLS_MODE selection (P4.4, docs/PLAN.md §10). Three modes:
//
//   off (DEFAULT)  — current behavior, byte-identical. main.ts's plain
//                    `app.listen(PORT)` path is untouched; nothing in this
//                    module runs, no env var beyond LOOMBRE_TLS_MODE itself
//                    is even read.
//   manual         — operator supplies cert+key file paths (e.g. from
//                     certbot's standalone/webroot mode, or any other cert
//                     source); hot-reloads on file change.
//   acme           — built-in ACME (Let's Encrypt HTTP-01/DNS-01) for
//                     direct-exposure installs with no reverse proxy.
//
// Port story (documented honestly per the mission spec): a "real" install
// binding the conventional 80/443 needs OS privilege Node does not have by
// default. This module NEVER assumes it can bind those ports — it always
// binds exactly LOOMBRE_HTTP_PORT/LOOMBRE_HTTPS_PORT, defaulting to 80/443
// only because that is what an operator turning TLS on actually wants; the
// privilege story itself (setcap / systemd AmbientCapabilities / authbind)
// is docs/ops/remote-access/reverse-proxy.md + docs/ops/remote-access/acme.md territory, and tests
// always override both env vars to unprivileged 36xx ports.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveDataDir } from "./storage.js";

export type TlsMode = "off" | "manual" | "acme";
export type AcmeChallengeType = "http-01" | "dns-01";

export class TlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsConfigError";
  }
}

export interface TlsConfigOff {
  mode: "off";
}

export interface TlsConfigManual {
  mode: "manual";
  httpsPort: number;
  certPath: string;
  keyPath: string;
  caPath?: string;
  /** Debounce window for the fs.watch-driven hot-reload (manual-provider.ts). */
  reloadDebounceMs: number;
}

export interface TlsConfigAcme {
  mode: "acme";
  httpPort: number;
  httpsPort: number;
  /** First entry is the certificate's commonName; the full list becomes
   *  the CSR's altNames (single-domain is just a one-element list). */
  domains: string[];
  email?: string;
  challengeType: AcmeChallengeType;
  directoryUrl: string;
  /** Set only for dns-01. Absent => manual print-and-poll mode. */
  dnsHookPath?: string;
  /** Extra CA trust anchor — production never needs this; it exists for
   *  pointing the client at a private ACME server (pebble integration
   *  tests) whose chain isn't in the public trust store. */
  caBundlePath?: string;
  renewWindowDays: number;
  renewCheckIntervalMs: number;
  dataDir: string;
  dnsPropagationTimeoutMs: number;
}

export type TlsConfig = TlsConfigOff | TlsConfigManual | TlsConfigAcme;

export const DEFAULT_HTTP_PORT = 80;
export const DEFAULT_HTTPS_PORT = 443;
export const DEFAULT_RENEW_WINDOW_DAYS = 30;
export const DEFAULT_RENEW_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DNS_PROPAGATION_TIMEOUT_MS = 120_000;
export const DEFAULT_MANUAL_RELOAD_DEBOUNCE_MS = 500;

function readMode(raw: string | undefined): TlsMode {
  if (raw === undefined) return "off";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "off") return "off";
  if (trimmed === "manual") return "manual";
  if (trimmed === "acme") return "acme";
  throw new TlsConfigError(
    `LOOMBRE_TLS_MODE=${JSON.stringify(raw)} is not one of "off" | "manual" | "acme"`,
  );
}

function readPort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim() || n < 1 || n > 65535) {
    throw new TlsConfigError(`${name}=${JSON.stringify(raw)} is not a valid TCP port (1-65535)`);
  }
  return n;
}

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new TlsConfigError(`${name}=${JSON.stringify(raw)} must be a positive integer`);
  }
  return n;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new TlsConfigError(`LOOMBRE_TLS_MODE requires ${name} to be set`);
  }
  return raw.trim();
}

function requireAbsolutePath(env: NodeJS.ProcessEnv, name: string): string {
  const raw = requireEnv(env, name);
  if (!isAbsolute(raw)) {
    throw new TlsConfigError(`${name}=${JSON.stringify(raw)} must be an absolute path`);
  }
  return raw;
}

function readTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const lowered = raw.trim().toLowerCase();
  return lowered === "1" || lowered === "true" || lowered === "on" || lowered === "yes";
}

/** Parses LOOMBRE_TLS_MODE + its mode-specific env vars into a closed,
 *  validated TlsConfig. Pure with respect to the environment object
 *  passed in (no `process.env` fallback default — every caller, including
 *  main.ts, passes `process.env` explicitly so tests can pass a fake one
 *  without env var leakage between cases). Existence-checks manual-mode
 *  paths eagerly (fail fast at boot, not on first TLS handshake) but never
 *  reads their contents — that's manual-provider.ts's job. */
export function loadTlsConfig(env: NodeJS.ProcessEnv): TlsConfig {
  const mode = readMode(env["LOOMBRE_TLS_MODE"]);

  if (mode === "off") {
    return { mode: "off" };
  }

  if (mode === "manual") {
    const certPath = requireAbsolutePath(env, "LOOMBRE_TLS_CERT_PATH");
    const keyPath = requireAbsolutePath(env, "LOOMBRE_TLS_KEY_PATH");
    if (!existsSync(certPath)) {
      throw new TlsConfigError(`LOOMBRE_TLS_CERT_PATH=${certPath} does not exist`);
    }
    if (!existsSync(keyPath)) {
      throw new TlsConfigError(`LOOMBRE_TLS_KEY_PATH=${keyPath} does not exist`);
    }
    const caPathRaw = env["LOOMBRE_TLS_CA_PATH"];
    const caPath = caPathRaw !== undefined && caPathRaw.trim() !== "" ? caPathRaw.trim() : undefined;
    if (caPath !== undefined) {
      if (!isAbsolute(caPath)) {
        throw new TlsConfigError(`LOOMBRE_TLS_CA_PATH=${JSON.stringify(caPath)} must be an absolute path`);
      }
      if (!existsSync(caPath)) {
        throw new TlsConfigError(`LOOMBRE_TLS_CA_PATH=${caPath} does not exist`);
      }
    }
    return {
      mode: "manual",
      httpsPort: readPort(env, "LOOMBRE_HTTPS_PORT", DEFAULT_HTTPS_PORT),
      certPath,
      keyPath,
      ...(caPath !== undefined ? { caPath } : {}),
      reloadDebounceMs: readPositiveInt(env, "LOOMBRE_TLS_RELOAD_DEBOUNCE_MS", DEFAULT_MANUAL_RELOAD_DEBOUNCE_MS),
    };
  }

  // acme
  const domainsRaw = requireEnv(env, "LOOMBRE_ACME_DOMAINS");
  const domains = domainsRaw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  if (domains.length === 0) {
    throw new TlsConfigError("LOOMBRE_ACME_DOMAINS must contain at least one domain");
  }

  const challengeTypeRaw = requireEnv(env, "LOOMBRE_ACME_CHALLENGE_TYPE");
  if (challengeTypeRaw !== "http-01" && challengeTypeRaw !== "dns-01") {
    throw new TlsConfigError(
      `LOOMBRE_ACME_CHALLENGE_TYPE=${JSON.stringify(challengeTypeRaw)} must be "http-01" or "dns-01"`,
    );
  }
  const challengeType: AcmeChallengeType = challengeTypeRaw;

  if (!readTruthyFlag(env["LOOMBRE_ACME_TOS_AGREED"])) {
    throw new TlsConfigError(
      "LOOMBRE_TLS_MODE=acme requires LOOMBRE_ACME_TOS_AGREED=1 — built-in ACME issuance means Loombre " +
        "agrees to the CA's Terms of Service on the operator's behalf (every ACME client, e.g. certbot's " +
        "--agree-tos, requires the same explicit opt-in); see docs/ops/remote-access/acme.md",
    );
  }

  const emailRaw = env["LOOMBRE_ACME_EMAIL"];
  const email = emailRaw !== undefined && emailRaw.trim() !== "" ? emailRaw.trim() : undefined;

  const directoryUrl = env["LOOMBRE_ACME_DIRECTORY_URL"]?.trim() || undefined;
  const staging = readTruthyFlag(env["LOOMBRE_ACME_STAGING"]);

  const dnsHookRaw = env["LOOMBRE_ACME_DNS_HOOK"];
  const dnsHookPath = dnsHookRaw !== undefined && dnsHookRaw.trim() !== "" ? dnsHookRaw.trim() : undefined;
  if (challengeType === "http-01" && dnsHookPath !== undefined) {
    throw new TlsConfigError("LOOMBRE_ACME_DNS_HOOK is only meaningful when LOOMBRE_ACME_CHALLENGE_TYPE=dns-01");
  }

  const caBundleRaw = env["LOOMBRE_ACME_CA_BUNDLE"];
  const caBundlePath = caBundleRaw !== undefined && caBundleRaw.trim() !== "" ? caBundleRaw.trim() : undefined;

  return {
    mode: "acme",
    httpPort: readPort(env, "LOOMBRE_HTTP_PORT", DEFAULT_HTTP_PORT),
    httpsPort: readPort(env, "LOOMBRE_HTTPS_PORT", DEFAULT_HTTPS_PORT),
    domains,
    ...(email !== undefined ? { email } : {}),
    challengeType,
    directoryUrl: directoryUrl ?? resolveDefaultDirectoryUrl(staging),
    ...(dnsHookPath !== undefined ? { dnsHookPath } : {}),
    ...(caBundlePath !== undefined ? { caBundlePath } : {}),
    renewWindowDays: readPositiveInt(env, "LOOMBRE_ACME_RENEW_WINDOW_DAYS", DEFAULT_RENEW_WINDOW_DAYS),
    renewCheckIntervalMs: readPositiveInt(
      env,
      "LOOMBRE_ACME_RENEW_CHECK_INTERVAL_MS",
      DEFAULT_RENEW_CHECK_INTERVAL_MS,
    ),
    dataDir: resolveDataDir(env["LOOMBRE_DATA_DIR"]),
    dnsPropagationTimeoutMs: readPositiveInt(
      env,
      "LOOMBRE_ACME_DNS_PROPAGATION_TIMEOUT_MS",
      DEFAULT_DNS_PROPAGATION_TIMEOUT_MS,
    ),
  };
}

/** Kept out of the acme-client import graph on purpose: config.ts must stay
 *  cheap to import (main.ts always imports it, even mode=off) and
 *  side-effect-free, so the well-known LE URLs are inlined rather than
 *  pulled from `acme-client`'s `directory` export. acme/directory-urls.spec.ts
 *  cross-checks these two literals stay in sync with the library's own
 *  `directory.letsencrypt.*` constants (a unit test, not a runtime
 *  dependency of this module). */
export const DEFAULT_ACME_DIRECTORY_URL_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
export const DEFAULT_ACME_DIRECTORY_URL_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

function resolveDefaultDirectoryUrl(staging: boolean): string {
  return staging ? DEFAULT_ACME_DIRECTORY_URL_STAGING : DEFAULT_ACME_DIRECTORY_URL_PRODUCTION;
}
