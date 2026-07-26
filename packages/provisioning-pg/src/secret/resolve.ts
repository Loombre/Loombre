// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/secret/resolve.ts
//
// The single choke-point every caller in this package uses to generate or
// resolve a superuser secret — never a backend module directly. Adding a
// keychain/dpapi/libsecret backend (P4.7 Wave-2, G1) means adding one case
// here and one new file beside file0600.ts; no other file in this package
// changes.

import type { SecretBackend, SecretRef } from "@loombre/provisioning";
import type { GeneratedSecret } from "./types.js";
import { createFile0600Backend } from "./file0600.js";
import { UnsupportedSecretBackendError } from "../errors.js";

function backendFor(backend: SecretBackend) {
  if (backend === "file0600") return createFile0600Backend();
  throw new UnsupportedSecretBackendError(backend);
}

export async function generateSecret(backend: SecretBackend, key: string): Promise<GeneratedSecret> {
  return backendFor(backend).generate(key);
}

export async function resolveSecret(ref: SecretRef): Promise<string> {
  return backendFor(ref.backend).resolve(ref);
}
