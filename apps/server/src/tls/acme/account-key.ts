// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/acme/account-key.ts
//
// The ACME account private key (distinct from the certificate's own key —
// this one identifies the Loombre INSTALL to the CA across renewals, never
// rotates on its own, and is the P4.7 SecretRef seam: file0600 backend,
// `key` = the absolute path to the PEM file. SecretRef's TYPE is imported
// read-only from @loombre/provisioning (a frozen package this wave) —
// nothing here writes to or otherwise touches that package.

import { existsSync, readFileSync } from "node:fs";
import type { SecretRef } from "@loombre/provisioning";
import { crypto as acmeCrypto } from "acme-client";
import { writeSecretFile } from "../fs-secret.js";
import { acmeAccountKeyPath } from "../storage.js";

export interface AccountKeyResult {
  pem: string;
  secretRef: SecretRef;
  /** True when a fresh key was generated this call (first ACME boot). */
  created: boolean;
}

/** Idempotent: returns the existing account key if present, otherwise
 *  generates a fresh ECDSA P-256 key (acme-client's own crypto helper —
 *  the same key-generation code path the library uses internally for CSR
 *  keys, so no separate crypto surface to trust) and persists it 0600. */
export async function ensureAccountKey(dataDir: string): Promise<AccountKeyResult> {
  const path = acmeAccountKeyPath(dataDir);
  const secretRef: SecretRef = { backend: "file0600", key: path };

  if (existsSync(path)) {
    return { pem: readFileSync(path, "utf8"), secretRef, created: false };
  }

  const keyBuf = await acmeCrypto.createPrivateEcdsaKey("P-256");
  writeSecretFile(path, keyBuf);
  return { pem: keyBuf.toString("utf8"), secretRef, created: true };
}
