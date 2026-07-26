// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/release-manifest/test/helpers/minisign-fixtures.ts
//
// TEST-ONLY signing infrastructure — not exported from src/ (see README.md
// "What this package does NOT do": producing a real release's .minisig is
// the release-manager tool's job, a separate lane). This is what lets
// test/minisign-verify.spec.ts be a real spike rather than a mock: a real
// ed25519 keypair generated via node:crypto, hand-encoded into the actual
// minisign wire format documented in README.md, so the verify side in
// src/minisign is exercised against genuine minisign-shaped bytes.
//
// Not a *.spec.ts / *.test.ts file, so vitest does not collect it as a
// suite on its own.

import { generateKeyPairSync, sign as cryptoSign, randomBytes, type KeyObject } from "node:crypto";

export interface MinisignFixtureKeypair {
  rawPublicKey: Buffer;
  keyId: Buffer;
  privateKey: KeyObject;
}

export function generateFixtureKeypair(): MinisignFixtureKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const rawPublicKey = Buffer.from(pubJwk.x, "base64url");
  const keyId = randomBytes(8);
  return { rawPublicKey, keyId, privateKey };
}

export function buildPublicKeyFile(
  keypair: MinisignFixtureKeypair,
  opts: { alg?: "Ed" | "ED" } = {},
): string {
  const alg = opts.alg ?? "Ed";
  const blob = Buffer.concat([Buffer.from(alg, "ascii"), keypair.keyId, keypair.rawPublicKey]);
  return `untrusted comment: minisign public key ${keypair.keyId.toString("hex")}\n${blob.toString("base64")}\n`;
}

export function defaultTrustedComment(): string {
  return `timestamp:${Math.floor(Date.now() / 1000)}\tfile:manifest.json`;
}

export function buildSignatureFile(
  keypair: MinisignFixtureKeypair,
  message: Uint8Array,
  opts: { alg?: "Ed" | "ED"; trustedComment?: string; keyIdOverride?: Buffer } = {},
): string {
  const alg = opts.alg ?? "Ed";
  const keyId = opts.keyIdOverride ?? keypair.keyId;
  const trustedComment = opts.trustedComment ?? defaultTrustedComment();

  const signature = cryptoSign(null, Buffer.from(message), keypair.privateKey);
  const sigBlob = Buffer.concat([Buffer.from(alg, "ascii"), keyId, signature]);

  const globalPayload = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);
  const globalSignature = cryptoSign(null, globalPayload, keypair.privateKey);

  return (
    "untrusted comment: signature from minisign secret key\n" +
    `${sigBlob.toString("base64")}\n` +
    `trusted comment: ${trustedComment}\n` +
    `${globalSignature.toString("base64")}\n`
  );
}
