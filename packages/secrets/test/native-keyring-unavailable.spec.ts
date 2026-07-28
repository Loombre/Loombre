// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/test/native-keyring-unavailable.spec.ts
//
// THE v0.9.0-rc.1 WINDOWS FIELD BUG, as an executable regression test.
//
// On a clean Windows 11 machine both LoombreServer and LoombreWorker died
// at boot, three restarts each, before writing a single application log
// line. Cause (real install, real logs):
//
//   Error: Cannot find native binding.
//     [cause]: Error: The specified module could not be found.
//       \\?\C:\Program Files\Loombre\server\node_modules\@napi-rs\
//       keyring-win32-x64-msvc\keyring.win32-x64-msvc.node
//       code: 'ERR_DLOPEN_FAILED'
//
// The .node file was PRESENT (Node resolved it — resolution checks
// existence); what was missing was VCRUNTIME140.dll, which that addon
// imports and which ships with the Visual C++ redistributable, NOT with
// Windows. Every GitHub Actions windows runner has it (Visual Studio is
// preinstalled), which is exactly why the release's own install smoke
// asserted /healthz 200 while the same MSI could not boot on a fresh VM.
//
// The dlopen failure is environmental and will recur — on any Windows host
// without the redistributable, on a Linux box with no libsecret provider
// and a future addon that hard-fails instead of returning an error, on any
// OS/arch @napi-rs ships no prebuilt for. What made it FATAL was ours:
// native-keyring.ts imported `@napi-rs/keyring` STATICALLY at module
// scope, so the addon's throw propagated through the import graph and
// killed the process — even though detect.ts already documents
// "fallback = ... addon didn't load" as a supported, tested outcome and
// file0600 is a complete working backend on every platform.
//
// So this file pins the contract the code CLAIMED but did not have: an
// unloadable native addon degrades to file0600, it never takes the server
// down. The mock reproduces the real failure shape — a module whose very
// evaluation throws — rather than one that merely exports something odd.

import { describe, expect, it, vi } from "vitest";

// Hoisted by vitest above the imports below: any attempt to load
// @napi-rs/keyring in this file's module graph now fails exactly the way
// the real addon failed on the field machine.
vi.mock("@napi-rs/keyring", () => {
  const cause = new Error(
    "The specified module could not be found.\n\\\\?\\C:\\Program Files\\Loombre\\server\\node_modules\\@napi-rs\\keyring-win32-x64-msvc\\keyring.win32-x64-msvc.node",
  );
  (cause as NodeJS.ErrnoException).code = "ERR_DLOPEN_FAILED";
  throw cause;
});

describe("native keyring unavailable (addon fails to dlopen)", () => {
  it("importing the module does not throw — a dead addon must not poison the import graph", async () => {
    // The regression itself: with a static top-level import this line is
    // where the server died. It must now resolve.
    const mod = await import("../src/native-keyring.js");
    expect(typeof mod.probeNativeKeyringAvailable).toBe("function");
    expect(typeof mod.createNativeKeyringBackend).toBe("function");
  });

  it("probeNativeKeyringAvailable reports false instead of throwing", async () => {
    const { probeNativeKeyringAvailable } = await import("../src/native-keyring.js");
    await expect(probeNativeKeyringAvailable("dpapi", "win32")).resolves.toBe(false);
    await expect(probeNativeKeyringAvailable("keychain", "darwin")).resolves.toBe(false);
    await expect(probeNativeKeyringAvailable("libsecret", "linux")).resolves.toBe(false);
  });

  it("auto-detect falls back to file0600 on every platform whose addon is dead", async () => {
    const { detectSecretBackend } = await import("../src/detect.js");
    for (const platform of ["win32", "darwin", "linux"] as const) {
      await expect(detectSecretBackend({}, platform)).resolves.toEqual({
        backend: "file0600",
        source: "fallback",
      });
    }
  });

  it("an explicit override still wins without probing (a dead addon cannot break it)", async () => {
    const { detectSecretBackend } = await import("../src/detect.js");
    await expect(
      detectSecretBackend({ LOOMBRE_SECRET_BACKEND: "file0600" }, "win32"),
    ).resolves.toEqual({ backend: "file0600", source: "override" });
  });

  it("platform validation still happens synchronously — a wrong-platform request fails loudly, not lazily", async () => {
    const { createNativeKeyringBackend } = await import("../src/native-keyring.js");
    const { UnsupportedSecretBackendError } = await import("../src/errors.js");
    // Construction must NOT need the addon (that is what made it fatal);
    // the platform guard is pure logic and keeps its eager, loud behaviour.
    expect(() => createNativeKeyringBackend("keychain", "linux")).toThrow(UnsupportedSecretBackendError);
    expect(() => createNativeKeyringBackend("dpapi", "win32")).not.toThrow();
  });

  it("actually USING a backend whose addon is dead rejects with UnsupportedSecretBackendError", async () => {
    const { createNativeKeyringBackend } = await import("../src/native-keyring.js");
    const { UnsupportedSecretBackendError } = await import("../src/errors.js");
    const impl = createNativeKeyringBackend("dpapi", "win32");
    // An operator who explicitly set LOOMBRE_SECRET_BACKEND=dpapi on a
    // machine with no redistributable gets a typed, explanatory failure at
    // the point of use — not a raw ERR_DLOPEN_FAILED stack, and not a
    // silent fallback that would contradict "env always wins".
    await expect(impl.store("k", "v")).rejects.toThrow(UnsupportedSecretBackendError);
    await expect(impl.generate("k")).rejects.toThrow(UnsupportedSecretBackendError);
    await expect(impl.resolve({ backend: "dpapi", key: "k" })).rejects.toThrow(UnsupportedSecretBackendError);
    // remove() is best-effort by contract and must stay silent.
    await expect(impl.remove({ backend: "dpapi", key: "k" })).resolves.toBeUndefined();
  });
});
