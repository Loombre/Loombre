// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/test/detect.spec.ts
//
// Platform-independent: exercises the override/parse logic directly and
// the auto-detect fallback path for a platform this host cannot probe for
// real (probeNativeKeyringAvailable's platform-mismatch branch always
// resolves false without touching any OS store — proven in
// native-keyring.spec.ts). The one "detects the real native store"
// assertion for THIS host's actual platform lives beside the other
// darwin-gated real-Keychain tests in native-keyring.spec.ts, not here.

import { describe, expect, it } from "vitest";
import { detectSecretBackend, parseBackendOverride } from "../src/detect.js";

describe("parseBackendOverride", () => {
  it("returns undefined for unset/empty/whitespace-only", () => {
    expect(parseBackendOverride(undefined)).toBeUndefined();
    expect(parseBackendOverride("")).toBeUndefined();
    expect(parseBackendOverride("   ")).toBeUndefined();
  });

  it("accepts every closed SecretBackend member", () => {
    expect(parseBackendOverride("keychain")).toBe("keychain");
    expect(parseBackendOverride("dpapi")).toBe("dpapi");
    expect(parseBackendOverride("libsecret")).toBe("libsecret");
    expect(parseBackendOverride("file0600")).toBe("file0600");
  });

  it("throws loudly on a value outside the enum (typo protection)", () => {
    expect(() => parseBackendOverride("keychain ")).not.toThrow(); // trimmed first
    expect(() => parseBackendOverride("keychainn")).toThrow(/LOOMBRE_SECRET_BACKEND/);
  });
});

describe("detectSecretBackend", () => {
  it("an explicit override wins unconditionally, even on a platform where it can't work", async () => {
    const result = await detectSecretBackend({ LOOMBRE_SECRET_BACKEND: "file0600" }, "linux");
    expect(result).toEqual({ backend: "file0600", source: "override" });
  });

  it("falls back to file0600 on a platform with no native backend mapping (freebsd et al.)", async () => {
    const result = await detectSecretBackend({}, "freebsd" as NodeJS.Platform);
    expect(result).toEqual({ backend: "file0600", source: "fallback" });
  });

  it("REAL: on this host's actual platform, auto-detect picks the native backend when the probe genuinely succeeds", async () => {
    // Deliberately NOT mocked: `platform` mismatches between the caller's
    // label and the ACTUALLY-LOADED native addon are meaningless (the
    // addon is compiled per-OS at install time — see native-keyring.spec.ts's
    // header — so passing a fake `platform` string does not change what
    // Security.framework/Credential Manager/Secret Service calls actually
    // happen). The only honest way to exercise the "native probe succeeds"
    // branch is against THIS process's real platform, which is exactly
    // what happens with no override in production. Only darwin is
    // independently verified real-hardware-true today (this dev host);
    // other platforms fall through untested here (same posture as every
    // other darwin-gated real-store assertion in this package).
    if (process.platform !== "darwin") return;
    const result = await detectSecretBackend({}, "darwin");
    expect(result).toEqual({ backend: "keychain", source: "native" });
  });
});
