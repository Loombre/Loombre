// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning/src/secret-ref.ts
//
// The P4.7 seam. A ProvisioningRequest never carries a plaintext superuser
// password (docs/PLAN.md §10 "secrets in OS keychain/DPAPI where available,
// else 0600 file") — instead it carries a SecretRef: an opaque pointer
// into whichever secret store P4.7 resolves to on the current platform.
// The caller resolves it to an actual credential only at the moment
// initdb/postmaster needs it, never earlier, and it is never logged.

export type SecretBackend = "keychain" | "dpapi" | "libsecret" | "file0600";

/** Runtime-iterable mirror of SecretBackend's members — single source of
 *  truth for both the TS union (via `(typeof SECRET_BACKENDS)[number]`,
 *  proven in test/type-agreement.spec.ts) and SECRET_REF_SCHEMA's enum. */
export const SECRET_BACKENDS: readonly SecretBackend[] = [
  "keychain",
  "dpapi",
  "libsecret",
  "file0600",
];

export interface SecretRef {
  backend: SecretBackend;
  /**
   * Opaque backend-specific lookup key (a macOS Keychain service/account
   * name, a DPAPI blob file path, a libsecret attribute key, or a 0600
   * file path). NEVER a plaintext secret — this field is safe to log and
   * to serialize; the secret VALUE it points to is not.
   */
  key: string;
}

export const SECRET_REF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["backend", "key"],
  properties: {
    backend: { type: "string", enum: [...SECRET_BACKENDS] },
    key: { type: "string", minLength: 1 },
  },
} as const;
