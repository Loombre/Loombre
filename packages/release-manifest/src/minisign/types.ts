// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/src/minisign/types.ts
//
// See README.md for the format citation and the standard-vs-prehashed
// variant decision this package encodes (`Ed` supported, `ED` recognized
// and always rejected).

export interface MinisignPublicKey {
  /** 16 lowercase hex chars (the 8 key-id bytes), matching minisign's own display convention. */
  keyId: string;
  /** 32 raw bytes — the ed25519 public key. */
  publicKey: Uint8Array;
}

export type ManifestVerificationFailureReason =
  /** The .pub text did not parse into a well-formed minisign public key blob. */
  | "malformed-public-key"
  /** The .minisig text did not parse into a well-formed minisign signature file. */
  | "malformed-signature-file"
  /** The public key or signature declares the blake2b-prehashed 'ED' algorithm — recognized, never verified (see README.md). */
  | "unsupported-prehashed-variant"
  /** The signature's embedded key id does not match the public key's — signed with a different key. */
  | "key-id-mismatch"
  /** The ed25519 signature over the manifest bytes did not verify. */
  | "signature-invalid"
  /** The ed25519 signature over (signature || trusted comment) did not verify — the trusted comment was tampered with. */
  | "trusted-comment-signature-invalid";

export const MANIFEST_VERIFICATION_FAILURE_REASONS: readonly ManifestVerificationFailureReason[] = [
  "malformed-public-key",
  "malformed-signature-file",
  "unsupported-prehashed-variant",
  "key-id-mismatch",
  "signature-invalid",
  "trusted-comment-signature-invalid",
];

export type ManifestVerificationResult =
  | { valid: true; keyId: string; trustedComment: string }
  | { valid: false; reason: ManifestVerificationFailureReason; detail?: string };
