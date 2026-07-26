// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/src/minisign/parse.ts
//
// Pure parsing of the minisign public-key and detached-signature TEXT
// formats (README.md has the full byte-layout citation). No I/O — callers
// read the .pub / .minisig files themselves; the update-check CLIENT lane
// (not this one) owns fetching/reading bytes off disk or network. Every
// failure path returns a typed reason, never throws — a corrupted or
// truncated file is an expected adversarial input, not a bug.

import type { ManifestVerificationFailureReason, MinisignPublicKey } from "./types.js";

// "Ed" / "ED" as the two raw ASCII bytes minisign uses to tag the
// signature algorithm — see README.md for the standard-vs-prehashed
// variant citation.
const SIG_ALG_STANDARD = "Ed";
const SIG_ALG_PREHASHED = "ED";

const KEY_ID_BYTES = 8;
const ED25519_KEY_BYTES = 32;
const ED25519_SIG_BYTES = 64;
/** sig_alg(2) + key_id(8) + raw_public_key(32) */
const PUBKEY_BLOB_BYTES = 2 + KEY_ID_BYTES + ED25519_KEY_BYTES;
/** sig_alg(2) + key_id(8) + signature(64) */
const SIG_BLOB_BYTES = 2 + KEY_ID_BYTES + ED25519_SIG_BYTES;

const TRUSTED_COMMENT_PREFIX = "trusted comment: ";

export type ParsedPublicKey =
  | { ok: true; value: MinisignPublicKey }
  | {
      ok: false;
      reason: Extract<
        ManifestVerificationFailureReason,
        "malformed-public-key" | "unsupported-prehashed-variant"
      >;
      detail: string;
    };

export interface ParsedSignatureFileValue {
  keyId: string;
  /** 64 raw bytes: the ed25519 signature over the manifest payload bytes. */
  signature: Uint8Array;
  trustedComment: string;
  /** 64 raw bytes: the ed25519 signature over (signature || trustedComment utf8 bytes). */
  globalSignature: Uint8Array;
}

export type ParsedSignatureFile =
  | { ok: true; value: ParsedSignatureFileValue }
  | {
      ok: false;
      reason: Extract<
        ManifestVerificationFailureReason,
        "malformed-signature-file" | "unsupported-prehashed-variant"
      >;
      detail: string;
    };

function nonEmptyLines(fileContents: string): string[] {
  return fileContents.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * `Buffer.from(str, "base64")` silently drops invalid trailing characters
 * rather than throwing — a corrupted or truncated base64 line would
 * otherwise "parse successfully" into a garbage-length buffer instead of
 * failing here with a clear reason. Round-tripping catches that: if
 * re-encoding the decoded bytes doesn't reproduce the input (modulo
 * padding), the input wasn't valid base64 to begin with.
 */
function decodeBase64Line(line: string): Buffer | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const decoded = Buffer.from(trimmed, "base64");
  const roundTrip = decoded.toString("base64");
  if (roundTrip.replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) return undefined;
  return decoded;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function parseMinisignPublicKey(fileContents: string): ParsedPublicKey {
  const lines = nonEmptyLines(fileContents);
  const blobLine = lines[1];
  if (lines.length < 2 || blobLine === undefined) {
    return {
      ok: false,
      reason: "malformed-public-key",
      detail: `expected 2 non-empty lines (comment + key blob), got ${lines.length}`,
    };
  }

  const blob = decodeBase64Line(blobLine);
  if (!blob) {
    return { ok: false, reason: "malformed-public-key", detail: "key blob is not valid base64" };
  }

  const alg = blob.subarray(0, 2).toString("latin1");
  if (alg === SIG_ALG_PREHASHED) {
    return {
      ok: false,
      reason: "unsupported-prehashed-variant",
      detail: "public key declares the blake2b-prehashed 'ED' algorithm, which this package does not verify",
    };
  }
  if (alg !== SIG_ALG_STANDARD || blob.length !== PUBKEY_BLOB_BYTES) {
    return {
      ok: false,
      reason: "malformed-public-key",
      detail: `unexpected key blob shape (${blob.length} bytes, algorithm tag "${alg}")`,
    };
  }

  const keyId = toHex(blob.subarray(2, 2 + KEY_ID_BYTES));
  const publicKey = new Uint8Array(blob.subarray(2 + KEY_ID_BYTES, PUBKEY_BLOB_BYTES));
  return { ok: true, value: { keyId, publicKey } };
}

export function parseMinisignSignatureFile(fileContents: string): ParsedSignatureFile {
  const lines = nonEmptyLines(fileContents);
  if (lines.length < 4) {
    return {
      ok: false,
      reason: "malformed-signature-file",
      detail: `expected 4 non-empty lines, got ${lines.length}`,
    };
  }

  const sigLine = lines[1];
  const trustedCommentLine = lines[2];
  const globalSigLine = lines[3];
  if (sigLine === undefined || trustedCommentLine === undefined || globalSigLine === undefined) {
    return { ok: false, reason: "malformed-signature-file", detail: "missing an expected line" };
  }

  const sigBlob = decodeBase64Line(sigLine);
  if (!sigBlob) {
    return {
      ok: false,
      reason: "malformed-signature-file",
      detail: "signature blob is not valid base64",
    };
  }

  const alg = sigBlob.subarray(0, 2).toString("latin1");
  if (alg === SIG_ALG_PREHASHED) {
    return {
      ok: false,
      reason: "unsupported-prehashed-variant",
      detail: "signature declares the blake2b-prehashed 'ED' algorithm, which this package does not verify",
    };
  }
  if (alg !== SIG_ALG_STANDARD || sigBlob.length !== SIG_BLOB_BYTES) {
    return {
      ok: false,
      reason: "malformed-signature-file",
      detail: `unexpected signature blob shape (${sigBlob.length} bytes, algorithm tag "${alg}")`,
    };
  }

  if (!trustedCommentLine.startsWith(TRUSTED_COMMENT_PREFIX)) {
    return {
      ok: false,
      reason: "malformed-signature-file",
      detail: "missing 'trusted comment: ' line",
    };
  }
  const trustedComment = trustedCommentLine.slice(TRUSTED_COMMENT_PREFIX.length);

  const globalSignature = decodeBase64Line(globalSigLine);
  if (!globalSignature || globalSignature.length !== ED25519_SIG_BYTES) {
    return {
      ok: false,
      reason: "malformed-signature-file",
      detail: "global signature is not a valid 64-byte base64 blob",
    };
  }

  const keyId = toHex(sigBlob.subarray(2, 2 + KEY_ID_BYTES));
  const signature = new Uint8Array(sigBlob.subarray(2 + KEY_ID_BYTES, SIG_BLOB_BYTES));
  return {
    ok: true,
    value: {
      keyId,
      signature,
      trustedComment,
      globalSignature: new Uint8Array(globalSignature),
    },
  };
}
