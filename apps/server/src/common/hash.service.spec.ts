// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/hash.service.spec.ts
//
// hash-wasm argon2id, verified against the exact PRECOMPUTED seed hashes
// (packages/db/seed/seed.mjs) — proves interop with an independently
// generated encoded hash string, not just round-tripping our own output.

import { describe, expect, it } from "vitest";
import { HashService } from "./hash.service.js";

const ADMIN_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$MXoNHb/vkFj5067uEoOI6g$y17ezgyFacz9WCrXHLtnuDnOkSresjh7Wp7uavb+fAQ";
const RESTRICTED_PIN_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$Be3OO5WPRVdFZ6C2FNFC0A$gg5RJ7iQoyewaORwGbgnr/mVm5So67Sp20PS71ltAFI";

describe("HashService", () => {
  const service = new HashService();

  it("verifies the seed admin password hash against its known plaintext", async () => {
    await expect(service.verify(ADMIN_PASSWORD_HASH, "loombre-seed-admin")).resolves.toBe(true);
  });

  it("rejects the wrong plaintext against the seed admin password hash", async () => {
    await expect(service.verify(ADMIN_PASSWORD_HASH, "wrong-password")).resolves.toBe(false);
  });

  it("verifies the seed restricted PIN hash against its known plaintext", async () => {
    await expect(service.verify(RESTRICTED_PIN_HASH, "0000")).resolves.toBe(true);
  });

  it("rejects the wrong PIN against the seed restricted PIN hash", async () => {
    await expect(service.verify(RESTRICTED_PIN_HASH, "1111")).resolves.toBe(false);
  });

  it("hash() produces an encoded argon2id string that verify() accepts, using seed-matching cost params", async () => {
    const encoded = await service.hash("a-new-pin");
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(service.verify(encoded, "a-new-pin")).resolves.toBe(true);
    await expect(service.verify(encoded, "not-it")).resolves.toBe(false);
  });

  it("hash() salts every call independently (two hashes of the same plaintext differ)", async () => {
    const a = await service.hash("same-pin");
    const b = await service.hash("same-pin");
    expect(a).not.toBe(b);
  });
});
