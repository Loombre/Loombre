// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/file0600.ts
//
// The file0600 SecretBackend (docs/PLAN.md §10 "secrets ... else 0600
// file"; @loombre/provisioning's secret-ref.ts: "key ... a 0600 file path").
// Available on every platform (the universal fallback when no OS credential
// store is usable), and the migration SOURCE for the file->keychain
// first-boot upgrade (deliverable 5's "MIGRATION between backends ...
// tested with the file backend as source").
//
// This is a deliberate REWRITE of packages/provisioning-pg/src/secret/
// file0600.ts's logic (same shape: idempotent generate, chmod-after-write
// gotcha, base64url random value), not an import of it — that package's own
// header explains why: "a workspace PACKAGE must not depend on an APP", and
// symmetrically here, packages/provisioning-pg must not depend on
// packages/secrets either (it shipped first, Wave 1, with its own
// self-contained file0600; this package's task explicitly forbids editing
// provisioning-pg's files). STATE.md follow-up logged in this wave's report:
// provisioning-pg should import this module instead of its own copy once a
// lane is scheduled to make that (non-breaking, same-shape) swap.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { SecretRef } from "@loombre/provisioning";
import type { SecretBackendImpl } from "./types.js";
import { SecretNotFoundError } from "./errors.js";

const SECRET_FILE_MODE = 0o600;

/** 32 random bytes, base64url-encoded (43 chars, no padding/slashes) — safe
 *  to embed verbatim in a connection string or use directly as a JWT HMAC
 *  key without further escaping. */
export function generateRandomSecretValue(): string {
  return randomBytes(32).toString("base64url");
}

function writeSecretFile(key: string, value: string): void {
  mkdirSync(dirname(key), { recursive: true });
  // Node's `mode` option on writeFileSync only takes effect on file
  // CREATION (O_CREAT) — an existing file's mode is left untouched, so
  // every write is followed by an explicit chmod (same gotcha
  // apps/server/src/tls/fs-secret.ts and provisioning-pg's file0600.ts both
  // document for their own instances of this exact pattern).
  writeFileSync(key, value, { mode: SECRET_FILE_MODE });
  chmodSync(key, SECRET_FILE_MODE);
}

export function createFile0600Backend(): SecretBackendImpl {
  return {
    async generate(key: string) {
      if (existsSync(key)) {
        return { ref: { backend: "file0600", key }, value: readFileSync(key, "utf8").trim() };
      }
      const value = generateRandomSecretValue();
      writeSecretFile(key, value);
      return { ref: { backend: "file0600", key }, value };
    },

    async store(key: string, value: string): Promise<SecretRef> {
      writeSecretFile(key, value);
      return { backend: "file0600", key };
    },

    async resolve(ref: SecretRef): Promise<string> {
      if (!existsSync(ref.key)) {
        throw new SecretNotFoundError(ref);
      }
      return readFileSync(ref.key, "utf8").trim();
    },

    async remove(ref: SecretRef): Promise<void> {
      try {
        rmSync(ref.key, { force: true });
      } catch {
        // Best-effort per SecretBackendImpl.remove's contract.
      }
    },
  };
}
