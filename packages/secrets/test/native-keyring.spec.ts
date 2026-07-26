// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/test/native-keyring.spec.ts
//
// Two halves, same "require-ffmpeg posture" this task specifies (see
// apps/worker/test/support/require-ffmpeg.ts / real-battery.integration.spec.ts
// for the repo's established convention):
//
//   1. Platform-VALIDATION tests run on every runner/OS — they exercise
//      createNativeKeyringBackend's own platform-mismatch guard via the
//      injectable `platform` parameter, never touching a real OS credential
//      store, so they're deterministic everywhere.
//   2. The REAL round-trip test against this host's actual OS credential
//      store only runs when process.platform matches a backend this suite
//      knows how to drive from CI/dev hosts today (darwin's Keychain — the
//      only one verified against real hardware in this wave, per the task's
//      "Real keychain tests darwin-gated" instruction). Every other host
//      prints a loud, explicit skip notice rather than silently reporting
//      green with zero coverage.

import { describe, expect, it } from "vitest";
import { createNativeKeyringBackend, probeNativeKeyringAvailable } from "../src/native-keyring.js";
import { UnsupportedSecretBackendError } from "../src/errors.js";

describe("native-keyring: platform validation (runs on every OS)", () => {
  it("keychain requires darwin", () => {
    expect(() => createNativeKeyringBackend("keychain", "linux")).toThrow(UnsupportedSecretBackendError);
    expect(() => createNativeKeyringBackend("keychain", "darwin")).not.toThrow();
  });

  it("dpapi requires win32", () => {
    expect(() => createNativeKeyringBackend("dpapi", "darwin")).toThrow(UnsupportedSecretBackendError);
    expect(() => createNativeKeyringBackend("dpapi", "win32")).not.toThrow();
  });

  it("libsecret requires linux", () => {
    expect(() => createNativeKeyringBackend("libsecret", "win32")).toThrow(UnsupportedSecretBackendError);
    expect(() => createNativeKeyringBackend("libsecret", "linux")).not.toThrow();
  });

  it("file0600 is not a native-keyring backend at all (accepted by the type signature, rejected at runtime)", () => {
    expect(() => createNativeKeyringBackend("file0600", "linux")).toThrow(UnsupportedSecretBackendError);
  });

  it("probeNativeKeyringAvailable never throws, even for an unsupported platform pairing", async () => {
    await expect(probeNativeKeyringAvailable("keychain", "linux")).resolves.toBe(false);
  });
});

const isDarwin = process.platform === "darwin";
if (!isDarwin) {
  console.warn(
    "[loombre] packages/secrets: skipping REAL macOS Keychain round-trip tests — " +
      `this host is "${process.platform}", not darwin. Zero coverage of the actual Security.framework ` +
      "integration on this run; verify on a macOS host before shipping a keychain-backend change.",
  );
}

describe.skipIf(!isDarwin)("keychain (darwin, REAL macOS Keychain — Security.framework)", () => {
  function uniqueKey(label: string): string {
    return `loombre-secrets-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  it("generate() writes a real Keychain entry and is idempotent on re-call", async () => {
    const backend = createNativeKeyringBackend("keychain");
    const key = uniqueKey("generate");
    try {
      const first = await backend.generate(key);
      expect(first.ref).toEqual({ backend: "keychain", key });
      expect(first.value.length).toBeGreaterThan(20);

      const second = await backend.generate(key);
      expect(second.value).toBe(first.value);
    } finally {
      await backend.remove({ backend: "keychain", key });
    }
  });

  it("store()/resolve()/remove() round-trip an explicit value through the real Keychain", async () => {
    const backend = createNativeKeyringBackend("keychain");
    const key = uniqueKey("store");

    const ref = await backend.store(key, "correct horse battery staple");
    expect(await backend.resolve(ref)).toBe("correct horse battery staple");

    await backend.remove(ref);
    await expect(backend.resolve(ref)).rejects.toThrow();
  });

  it("resolve() on a never-written key throws SecretNotFoundError, not a raw native error", async () => {
    const backend = createNativeKeyringBackend("keychain");
    const key = uniqueKey("missing");
    await expect(backend.resolve({ backend: "keychain", key })).rejects.toThrow(/no secret found/i);
  });

  it("probeNativeKeyringAvailable resolves true on a real, unlocked login Keychain", async () => {
    await expect(probeNativeKeyringAvailable("keychain")).resolves.toBe(true);
  });
});
