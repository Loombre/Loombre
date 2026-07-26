// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/migrate.ts
//
// Deliverable 5's "MIGRATION between backends (file→keychain on first boot
// where available, tested with the file backend as source)". Copies a
// secret's PLAINTEXT VALUE verbatim from its current backend into a target
// backend under the SAME key — never regenerates it (a superuser password
// or a JWT signing secret changing value on migration would invalidate
// whatever it authenticates: an already-initialized PG cluster's scram
// verifier, or every outstanding access token). Same key string is reused
// across backends so a caller can always find "the embedded-pg-superuser
// secret" by key regardless of which backend currently holds it.
//
// Source-copy cleanup: `removeSource` defaults to true — once the value is
// durably readable back from the NEW backend (read-back verified before any
// deletion happens), leaving a second live plaintext copy sitting in the
// OLD backend serves no purpose and is strictly worse for the "secrets in
// OS keychain ... else 0600 file" posture (docs/PLAN.md §10) this whole
// package exists to uphold. Deletion is best-effort (SecretBackendImpl.
// remove()'s own contract) — a failed cleanup never fails the migration
// itself, since the NEW copy is already durable and correct by that point.

import type { SecretBackend, SecretRef } from "@loombre/provisioning";
import { backendFor } from "./backends.js";

export interface MigrateSecretOptions {
  removeSource?: boolean;
}

export interface MigrateSecretResult {
  ref: SecretRef;
  /** false when fromRef.backend === toBackend already (no-op: the value
   *  never moved because it didn't need to). */
  migrated: boolean;
}

export async function migrateSecret(
  fromRef: SecretRef,
  toBackend: SecretBackend,
  opts: MigrateSecretOptions = {},
): Promise<MigrateSecretResult> {
  if (fromRef.backend === toBackend) {
    return { ref: fromRef, migrated: false };
  }

  const removeSource = opts.removeSource ?? true;

  const sourceImpl = backendFor(fromRef.backend);
  const value = await sourceImpl.resolve(fromRef);

  const targetImpl = backendFor(toBackend);
  const newRef = await targetImpl.store(fromRef.key, value);

  // Read-back verification BEFORE touching the source — a target backend
  // that silently drops writes (should never happen, but this is exactly
  // the kind of failure a credential migration must never trust blindly)
  // must not cost the caller their only copy of the secret.
  const readBack = await targetImpl.resolve(newRef);
  if (readBack !== value) {
    throw new Error(
      `@loombre/secrets: migration read-back mismatch for key="${fromRef.key}" ` +
        `(${fromRef.backend} -> ${toBackend}) — refusing to remove the source copy.`,
    );
  }

  if (removeSource) {
    await sourceImpl.remove(fromRef);
  }

  return { ref: newRef, migrated: true };
}
