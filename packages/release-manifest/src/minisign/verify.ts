// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/src/minisign/verify.ts
//
// P4.3 spike, PROVEN (see README.md DECISION + test/minisign-verify.spec.ts):
// minisign-format ed25519 verification is achievable with node:crypto
// alone — zero new runtime dependencies. Pure function: no fetch, no fs.
// The update-check CLIENT lane reads manifest.json + manifest.json.minisig
// + the pinned public key off disk/network and hands their bytes/text here.
//
// Ed25519 is "PureEdDSA": crypto.verify's `algorithm` argument MUST be
// null (the digest is internal to the signature scheme, never chosen by
// the caller) — this is not an oversight, passing a hash name throws.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { parseMinisignPublicKey, parseMinisignSignatureFile } from "./parse.js";
import type { ManifestVerificationResult } from "./types.js";

function verifyEd25519(message: Uint8Array, signature: Uint8Array, rawPublicKey: Uint8Array): boolean {
  const keyObject = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(rawPublicKey).toString("base64url") },
    format: "jwk",
  });
  return cryptoVerify(null, Buffer.from(message), keyObject, Buffer.from(signature));
}

/**
 * Verifies a minisign detached signature over `manifestBytes`.
 *
 * Checks, in order (any failure returns immediately with a typed reason —
 * fails closed):
 *  1. Both the public key and signature file parse (parse.ts).
 *  2. Neither declares the unsupported prehashed 'ED' variant.
 *  3. The signature's key id matches the public key's key id.
 *  4. The ed25519 signature over `manifestBytes` verifies.
 *  5. The ed25519 global signature over (signature || trusted comment) verifies
 *     — this is what authenticates the trusted comment itself.
 */
export function verifyManifestSignature(
  manifestBytes: Uint8Array,
  minisigFileContents: string,
  publicKeyFileContents: string,
): ManifestVerificationResult {
  const parsedKey = parseMinisignPublicKey(publicKeyFileContents);
  if (!parsedKey.ok) {
    return { valid: false, reason: parsedKey.reason, detail: parsedKey.detail };
  }

  const parsedSig = parseMinisignSignatureFile(minisigFileContents);
  if (!parsedSig.ok) {
    return { valid: false, reason: parsedSig.reason, detail: parsedSig.detail };
  }

  const { keyId, publicKey } = parsedKey.value;
  const { keyId: sigKeyId, signature, trustedComment, globalSignature } = parsedSig.value;

  if (sigKeyId !== keyId) {
    return {
      valid: false,
      reason: "key-id-mismatch",
      detail: `signature key id ${sigKeyId} does not match public key id ${keyId}`,
    };
  }

  if (!verifyEd25519(manifestBytes, signature, publicKey)) {
    return { valid: false, reason: "signature-invalid" };
  }

  const trustedCommentPayload = Buffer.concat([
    Buffer.from(signature),
    Buffer.from(trustedComment, "utf8"),
  ]);
  if (!verifyEd25519(trustedCommentPayload, globalSignature, publicKey)) {
    return { valid: false, reason: "trusted-comment-signature-invalid" };
  }

  return { valid: true, keyId, trustedComment };
}
