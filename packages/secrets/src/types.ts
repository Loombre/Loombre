// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/types.ts
//
// The seam every backend module (file0600.ts, native-keyring.ts) implements
// and every caller (store.ts, migrate.ts, jwt-secret.ts) goes through —
// mirrors packages/provisioning-pg/src/secret/types.ts's shape (Wave 1's
// file0600-only half of this same SecretRef contract) plus two additions
// this wave needs: `store()` (write an EXPLICIT value — migrate.ts copies a
// plaintext secret from one backend into another verbatim, never
// regenerating it) and `remove()` (best-effort cleanup of the source
// backend's copy after a successful migration).

import type { SecretRef } from "@loombre/provisioning";

export interface GeneratedSecret {
  ref: SecretRef;
  value: string;
}

export interface SecretBackendImpl {
  /** Generates a fresh random secret and durably stores it, returning both
   *  the SecretRef (safe to log/serialize) and the plaintext value. IDEMPOTENT:
   *  calling this again for the same `key` returns the EXISTING value rather
   *  than rotating it (a caller that wants rotation calls store() with a
   *  freshly generated value instead). */
  generate(key: string): Promise<GeneratedSecret>;
  /** Writes an EXPLICIT plaintext value at `key`, overwriting any existing
   *  one. Used by migrate.ts to copy a secret's value into a new backend
   *  unchanged (never re-derived), and available to any future caller that
   *  needs to persist an operator-supplied value (e.g. a pasted provider API
   *  key) rather than a generated one. */
  store(key: string, value: string): Promise<SecretRef>;
  /** Reads back a previously-generated/stored secret's plaintext value.
   *  Throws SecretNotFoundError if nothing has been stored at `ref.key`. */
  resolve(ref: SecretRef): Promise<string>;
  /** Best-effort delete of the stored value at `ref.key`. Never throws —
   *  a backend that has nothing to delete, or fails to delete, resolves
   *  silently (deletion is always a cleanup nicety, never load-bearing:
   *  the caller has already migrated the value elsewhere by the time this
   *  runs). */
  remove(ref: SecretRef): Promise<void>;
}
