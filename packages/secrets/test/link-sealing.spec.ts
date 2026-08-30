// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/test/link-sealing.spec.ts
//
// Sealed mail-link references (MRV-R1). Pure crypto pins (seal/unseal
// roundtrip, tamper rejection, key mismatch, plaintext opacity) plus the
// file0600 read-or-create resolution both processes share.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LinkSealError, resolveLinkSealingSecret, sealLinkToken, unsealLinkToken } from "../src/link-sealing.js";

const dir = mkdtempSync(join(tmpdir(), "loombre-link-sealing-test-"));
const FILE0600_ENV = { LOOMBRE_SECRET_BACKEND: "file0600" } as const;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sealLinkToken / unsealLinkToken", () => {
  const secret = "an-install-sealing-secret";

  it("roundtrips, and the sealed form never contains the plaintext", () => {
    const plaintext = "reset-token-Aa1_-0123456789abcdef";
    const sealed = sealLinkToken(secret, plaintext);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(plaintext);
    expect(unsealLinkToken(secret, sealed)).toBe(plaintext);
  });

  it("two seals of the same plaintext differ (fresh iv) and both unseal", () => {
    const a = sealLinkToken(secret, "same-token");
    const b = sealLinkToken(secret, "same-token");
    expect(a).not.toBe(b);
    expect(unsealLinkToken(secret, a)).toBe("same-token");
    expect(unsealLinkToken(secret, b)).toBe("same-token");
  });

  it("rejects tampered ciphertext, a wrong key, and malformed input — all as LinkSealError, never echoing content", () => {
    const plaintext = "SECRET-PLAINTEXT-cafebabe0042";
    const sealed = sealLinkToken(secret, plaintext);
    const [prefix, iv, ct, tag] = sealed.split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = [prefix, iv, flipped.toString("base64url"), tag].join(".");

    for (const bad of [tampered, "v1.only.three", "v2." + sealed.slice(3), "not-sealed-at-all"]) {
      let thrown: unknown;
      try {
        unsealLinkToken(secret, bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LinkSealError);
      expect((thrown as Error).message).not.toContain(plaintext);
      expect((thrown as Error).message).not.toContain(bad);
    }
    expect(() => unsealLinkToken("a-different-secret", sealed)).toThrow(LinkSealError);
  });
});

describe("resolveLinkSealingSecret (file0600 read-or-create)", () => {
  it("creates on first resolve and returns the SAME secret on the second — the server-creates, worker-reads contract", async () => {
    const key = join(dir, "mail-link-sealing-key");
    const first = await resolveLinkSealingSecret({ key, env: FILE0600_ENV });
    const second = await resolveLinkSealingSecret({ key, env: FILE0600_ENV });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(unsealLinkToken(second, sealLinkToken(first, "cross-process-token"))).toBe("cross-process-token");
  });
});
