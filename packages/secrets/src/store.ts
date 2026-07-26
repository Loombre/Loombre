// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/store.ts
//
// The public generate/resolve/store/remove façade — every caller outside
// this package (apps/server's JWT-secret bootstrap, a future admin surface
// for provider API keys, packages/provisioning-pg's eventual adoption of
// this package per this wave's report) goes through these four functions,
// never a backend module directly. Mirrors packages/provisioning-pg/src/
// secret/resolve.ts's shape, generalized to all four backends via
// backends.ts's dispatcher.

import type { SecretBackend, SecretRef } from "@loombre/provisioning";
import type { GeneratedSecret } from "./types.js";
import { backendFor } from "./backends.js";
import { SecretNotFoundError } from "./errors.js";

export async function generateSecret(backend: SecretBackend, key: string): Promise<GeneratedSecret> {
  return backendFor(backend).generate(key);
}

/** Like resolveSecret, but returns null instead of throwing when nothing is
 *  stored at ref.key — used by callers (jwt-secret.ts) that need to branch
 *  on "does this already exist" without a try/catch at every call site. Any
 *  OTHER failure (locked store, ambiguous entry, unsupported backend) still
 *  propagates — only genuine absence collapses to null. */
export async function tryResolveSecret(ref: SecretRef): Promise<string | null> {
  try {
    return await resolveSecret(ref);
  } catch (err) {
    if (err instanceof SecretNotFoundError) return null;
    throw err;
  }
}

export async function storeSecret(backend: SecretBackend, key: string, value: string): Promise<SecretRef> {
  return backendFor(backend).store(key, value);
}

export async function resolveSecret(ref: SecretRef): Promise<string> {
  return backendFor(ref.backend).resolve(ref);
}

export async function removeSecret(ref: SecretRef): Promise<void> {
  return backendFor(ref.backend).remove(ref);
}
