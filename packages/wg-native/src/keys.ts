// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/src/keys.ts
//
// WireGuard X25519 keypairs, generated with node:crypto — NOT a
// hand-rolled Curve25519 implementation (RG1's whole point: reuse
// wireguard-go's own crypto for the DEVICE side; this file only needs to
// produce key MATERIAL in WG's base64 wire format, which is standard
// RFC 7748 X25519).
//
// node:crypto's 'x25519' KeyObject export gives DER (PKCS8 for private,
// SPKI for public), not the raw 32-byte scalar WG's base64 config format
// wants — both DER encodings for X25519 have a FIXED, algorithm-pinned
// header (the OID 1.3.101.110 leaves no variable-length fields before the
// raw key bytes), so the raw key is always the last 32 bytes. Offsets
// verified two ways: (1) direct byte-for-byte inspection of Node's actual
// DER output (both headers are exactly what RFC 8410 specifies for X25519,
// no ambiguity), and (2) EMPIRICALLY — this lane's dedicated debugging
// session ran a full real wireguard-go handshake (both directions) between
// two node:crypto-generated keypairs converted through EXACTLY this
// extraction, real UDP, real HTTP payload through the tunnel — R11's "prove
// compatibility via the handshake test, don't assume clamping details"
// satisfied for real, not by inspection alone. Node's X25519 keygen
// clamps the scalar per RFC 7748 the same way WireGuard's own key
// generation does — both ultimately follow the same spec, so no extra
// clamping step is needed here.

import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";

/** PKCS8 DER for X25519: a fixed 16-byte header, then the raw 32-byte
 *  private scalar. */
const PKCS8_X25519_HEADER_LEN = 16;
/** SPKI DER for X25519: a fixed 12-byte header, then the raw 32-byte
 *  public key. */
const SPKI_X25519_HEADER_LEN = 12;
const X25519_KEY_LEN = 32;

export interface WgKeyPair {
  /** Standard WireGuard base64 private key (44 chars). */
  privateKey: string;
  /** Standard WireGuard base64 public key (44 chars). */
  publicKey: string;
}

/** Generates a fresh WireGuard-compatible X25519 keypair. */
export function generateWgKeyPair(): WgKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey: privDer.subarray(PKCS8_X25519_HEADER_LEN).toString("base64"),
    publicKey: pubDer.subarray(SPKI_X25519_HEADER_LEN).toString("base64"),
  };
}

/** Derives the base64 public key for a base64 private key — used by
 *  tests to prove generateWgKeyPair's extraction is self-consistent
 *  (derive independently, compare against what generateKeyPairSync itself
 *  returned) rather than trusting the DER offsets by inspection alone. */
export function derivePublicKey(privateKeyBase64: string): string {
  const raw = Buffer.from(privateKeyBase64, "base64");
  if (raw.length !== X25519_KEY_LEN) {
    throw new Error(`invalid WG private key: expected ${X25519_KEY_LEN} bytes, got ${raw.length}`);
  }
  const der = Buffer.concat([pkcs8Header(), raw]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  return pubDer.subarray(SPKI_X25519_HEADER_LEN).toString("base64");
}

/** The fixed PKCS8 X25519 header bytes (everything before the raw 32-byte
 *  scalar) — extracted once from a real node:crypto-generated key so this
 *  file never hand-encodes ASN.1 itself. */
function pkcs8Header(): Buffer {
  return Buffer.from("302e020100300506032b656e04220420", "hex");
}

/** True iff `value` is a syntactically valid WireGuard base64 key (44
 *  chars decoding to exactly 32 bytes) — does NOT verify it's a valid
 *  curve point, same posture wg(8) itself has for a config file key. */
export function isValidWgKey(value: string): boolean {
  if (value.length !== 44) return false;
  try {
    return Buffer.from(value, "base64").length === X25519_KEY_LEN;
  } catch {
    return false;
  }
}
