// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/secret/file0600.ts
//
// The file0600 SecretBackend (docs/PLAN.md §10 "secrets ... else 0600
// file"; @loombre/provisioning's secret-ref.ts: "key ... a 0600 file path").
// Ships in Wave 1 as the only implemented backend — keychain/dpapi/
// libsecret are P4.7 Wave-2 (G1), see ./resolve.ts.
//
// Independent, package-local twin of apps/server/src/tls/fs-secret.ts's
// writeSecretFile (same P4.7 pattern, two different secret KINDS — TLS
// private keys there, the embedded-PG superuser password here — owned by
// two different Wave-1 lanes). Not imported from there: a workspace
// PACKAGE must not depend on an APP (apps/server), so this is a small,
// deliberate duplication behind the shared SecretRef seam, not an
// oversight.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { GeneratedSecret, SecretBackendImpl } from "./types.js";
import type { SecretRef } from "@loombre/provisioning";

const SECRET_FILE_MODE = 0o600;

/** 32 random bytes, base64url-encoded (43 chars, no padding/slashes) —
 *  safe to embed verbatim in a `postgres://user:PASSWORD@...` connection
 *  string without additional escaping beyond the usual encodeURIComponent
 *  this package's listen.ts already applies. */
function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

export function createFile0600Backend(): SecretBackendImpl {
  return {
    async generate(key: string): Promise<GeneratedSecret> {
      if (existsSync(key)) {
        // Idempotent: an already-initialized cluster's stored scram
        // verifier was derived from THIS file's existing content —
        // regenerating here would silently desync them (see types.ts's
        // doc comment on SecretBackendImpl.generate).
        return { ref: { backend: "file0600", key }, value: readFileSync(key, "utf8").trim() };
      }
      const value = generatePassword();
      mkdirSync(dirname(key), { recursive: true });
      // Node's `mode` option on writeFileSync only takes effect on file
      // CREATION (O_CREAT) — an existing file's mode is left untouched, so
      // every write is followed by an explicit chmod (same gotcha
      // apps/server/src/tls/fs-secret.ts documents for its own instance of
      // this exact pattern).
      writeFileSync(key, value, { mode: SECRET_FILE_MODE });
      chmodSync(key, SECRET_FILE_MODE);
      return { ref: { backend: "file0600", key }, value };
    },

    async resolve(ref: SecretRef): Promise<string> {
      if (!existsSync(ref.key)) {
        throw new Error(`@loombre/provisioning-pg: file0600 secret not found at ${ref.key} — was generate() ever called for this ref?`);
      }
      return readFileSync(ref.key, "utf8").trim();
    },
  };
}
