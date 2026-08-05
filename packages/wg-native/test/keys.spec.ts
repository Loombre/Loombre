// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/wg-native/test/keys.spec.ts
//
// Pure key-utility tests — no native library required (these never touch
// dist/, only node:crypto), so they run unconditionally, unlike
// loopback.spec.ts's wg-gated suites.

import { describe, expect, it } from "vitest";
import { derivePublicKey, generateWgKeyPair, isValidWgKey } from "../src/keys.js";

describe("generateWgKeyPair", () => {
  it("produces standard WireGuard base64 keys (44 chars, 32 raw bytes)", () => {
    const pair = generateWgKeyPair();
    expect(pair.privateKey).toHaveLength(44);
    expect(pair.publicKey).toHaveLength(44);
    expect(Buffer.from(pair.privateKey, "base64")).toHaveLength(32);
    expect(Buffer.from(pair.publicKey, "base64")).toHaveLength(32);
  });

  it("never repeats a key across calls", () => {
    const a = generateWgKeyPair();
    const b = generateWgKeyPair();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe("derivePublicKey", () => {
  it("independently re-derives the SAME public key generateWgKeyPair returned", () => {
    // R11 "prove compatibility... don't assume clamping details": this
    // proves the DER-offset extraction in keys.ts is self-consistent by
    // deriving the public key a SECOND, INDEPENDENT way (re-import the raw
    // private scalar into a fresh KeyObject, ask node:crypto to derive its
    // public key), not just trusting the offsets by inspection. The real
    // cross-implementation proof (this key material actually completes a
    // wireguard-go handshake) lives in loopback.spec.ts.
    for (let i = 0; i < 10; i++) {
      const pair = generateWgKeyPair();
      expect(derivePublicKey(pair.privateKey)).toBe(pair.publicKey);
    }
  });

  it("throws on a malformed private key", () => {
    expect(() => derivePublicKey("not-base64!!!")).toThrow();
    expect(() => derivePublicKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("isValidWgKey", () => {
  it("accepts a real generated key", () => {
    expect(isValidWgKey(generateWgKeyPair().publicKey)).toBe(true);
  });

  it("rejects the wrong length, non-base64, and empty string", () => {
    expect(isValidWgKey("")).toBe(false);
    expect(isValidWgKey("short")).toBe(false);
    expect(isValidWgKey(Buffer.alloc(31).toString("base64"))).toBe(false);
    expect(isValidWgKey("!!!!not-base64-at-all-and-44-chars-long-xxxx")).toBe(false);
  });
});
