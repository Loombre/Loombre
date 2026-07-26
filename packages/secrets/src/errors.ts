// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/errors.ts
//
// Typed error classes this package throws — same "instanceof over string
// parsing" discipline packages/provisioning-pg/src/errors.ts uses for the
// same SecretRef seam's Wave-1 half (file0600 only).

import type { SecretBackend, SecretRef } from "@loombre/provisioning";

/** A SecretBackend this platform/build cannot service at all (e.g.
 *  'keychain' requested on Linux, or the native keyring addon failed to
 *  load for this OS/arch). Distinct from SecretNotFoundError: this means
 *  the BACKEND itself is unusable here, not that a particular key is
 *  missing from an otherwise-working backend. */
export class UnsupportedSecretBackendError extends Error {
  readonly backend: string;

  constructor(backend: string, reason: string) {
    super(`@loombre/secrets: backend "${backend}" is unavailable on this platform/build — ${reason}`);
    this.name = "UnsupportedSecretBackendError";
    this.backend = backend;
  }
}

/** resolve() was called for a ref whose backend has no stored value at
 *  ref.key. Never includes the value it failed to find (there isn't one). */
export class SecretNotFoundError extends Error {
  readonly ref: SecretRef;

  constructor(ref: SecretRef) {
    super(`@loombre/secrets: no secret found for backend="${ref.backend}" key="${ref.key}".`);
    this.name = "SecretNotFoundError";
    this.ref = ref;
  }
}

/** The underlying OS credential store reported more than one matching
 *  credential for a (service, key) pair — @napi-rs/keyring's own
 *  "Ambiguous" condition (only reachable if a third-party app wrote a
 *  colliding entry under the same service namespace). Loombre cannot pick
 *  one safely; the caller must resolve the ambiguity out-of-band (e.g. via
 *  the OS's own Keychain Access / Credential Manager UI). */
export class AmbiguousSecretError extends Error {
  readonly backend: SecretBackend;
  readonly key: string;

  constructor(backend: SecretBackend, key: string, cause: unknown) {
    super(
      `@loombre/secrets: backend="${backend}" reports more than one credential for key="${key}" — ` +
        "resolve the collision in the OS credential store directly (Loombre will not guess which one is ours).",
    );
    this.name = "AmbiguousSecretError";
    this.backend = backend;
    this.key = key;
    this.cause = cause;
  }
}
