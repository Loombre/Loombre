// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/storage.ts
//
// Filesystem layout for TLS material under the app-data dir (docs/PLAN.md
// §11 "app-data in platform-correct locations"; P4.4). Mirrors the exact
// LOOMBRE_DATA_DIR convention already established by
// apps/worker/src/image/pipeline.ts's resolveDataDir (same env var, same
// './data' fallback) — a second, independent implementation on purpose:
// apps/server has no dependency on apps/worker's source, and this function
// is a two-line env lookup, not worth a shared package for.
//
// Everything under <dataDir>/tls/ is either a private key or a certificate
// derived from one: the account key (P4.7's SecretRef file0600 backend —
// see acme/account-key.ts) and the certificate's own key/cert pair (both
// manual-mode operator-supplied paths live OUTSIDE this directory — see
// config.ts — and acme-mode issued material that Loombre itself writes).

import { join } from "node:path";

const DEFAULT_DATA_DIR = "./data";

export function resolveDataDir(explicit?: string): string {
  return explicit ?? process.env["LOOMBRE_DATA_DIR"] ?? DEFAULT_DATA_DIR;
}

export function tlsDir(dataDir: string): string {
  return join(dataDir, "tls");
}

/** ACME account private key (P4.7 SecretRef file0600 backend target). */
export function acmeAccountKeyPath(dataDir: string): string {
  return join(tlsDir(dataDir), "acme-account-key.pem");
}

/** The CA's account URL for that key, cached after the first successful
 *  createAccount/getAccountUrl() so every later issuance/renewal can pass
 *  `accountUrl` straight to the acme-client Client constructor instead of
 *  re-discovering it via an empty-payload createAccount() call on every
 *  attempt — some ACME servers (pebble in `-strict` mode, observed while
 *  building this module) reject that repeated empty-update shape outright
 *  ("Use POST-as-GET to retrieve account data instead of doing an empty
 *  update"), and it's wasted round-trips against a real CA either way. */
export function acmeAccountUrlPath(dataDir: string): string {
  return join(tlsDir(dataDir), "acme-account-url.txt");
}

/** Issued certificate's own private key — distinct from the account key. */
export function acmeCertKeyPath(dataDir: string): string {
  return join(tlsDir(dataDir), "acme-cert-key.pem");
}

/** Issued certificate, fullchain (leaf + intermediates) as returned by
 *  acme-client's getCertificate/auto(). */
export function acmeCertPath(dataDir: string): string {
  return join(tlsDir(dataDir), "acme-cert.pem");
}
