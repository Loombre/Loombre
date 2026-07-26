// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/secret/types.ts
//
// The seam P4.7's Wave-2 (G1) keychain/dpapi/libsecret backends implement
// without touching any call site in this package — every caller goes
// through generateSecret()/resolveSecret() in ./resolve.ts, never a
// backend module directly.

import type { SecretRef } from "@loombre/provisioning";

export interface GeneratedSecret {
  ref: SecretRef;
  value: string;
}

export interface SecretBackendImpl {
  /** Generates a fresh random secret and durably stores it, returning both
   *  the SecretRef (safe to log/serialize) and the plaintext value (used
   *  immediately, never persisted by the CALLER). IDEMPOTENT: calling this
   *  again for the same `key` returns the EXISTING value rather than
   *  rotating it — critical for the embedded-PG superuser secret, whose
   *  stored scram-sha-256 verifier inside an already-initialized cluster
   *  would silently stop matching a freshly-regenerated password. */
  generate(key: string): Promise<GeneratedSecret>;
  /** Reads back a previously-generated secret's plaintext value. Throws if
   *  nothing has been generated at `ref.key` yet. */
  resolve(ref: SecretRef): Promise<string>;
}
