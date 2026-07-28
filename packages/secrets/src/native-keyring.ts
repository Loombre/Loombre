// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/native-keyring.ts
//
// keychain (macOS Security.framework) / dpapi (Windows) / libsecret (Linux)
// all implemented through ONE native library, @napi-rs/keyring — see this
// wave's report for the full evaluation against keytar. One Rust addon
// (github.com/hwchen/keyring-rs via napi.rs bindings) targets the correct
// OS-native store per platform:
//   - macOS  -> Keychain Services (Security.framework)          -> our "keychain"
//   - Windows-> Windows Credential Manager (itself DPAPI-backed) -> our "dpapi"
//   - Linux  -> Secret Service over D-Bus (gnome-keyring/kwallet)-> our "libsecret"
// Naming note (discovery, reported): our SecretBackend enum names predate
// library selection and describe the OS MECHANISM, not this library's own
// vocabulary — @napi-rs/keyring exposes one `Entry`/`AsyncEntry` API
// regardless of platform. "dpapi" here really means "whatever
// Windows-native store this library picks", which happens to be Credential
// Manager (DPAPI-encrypted under the hood), not a raw CryptProtectData call
// Loombre makes itself. Documented rather than silently reinterpreted.
//
// Platform-gated: createNativeKeyringBackend('keychain') throws
// UnsupportedSecretBackendError on any platform other than darwin (and
// symmetrically for 'dpapi'/win32, 'libsecret'/linux) — detect.ts is the
// only caller that picks a native backend for the CURRENT platform;
// requesting the "wrong" one explicitly (LOOMBRE_SECRET_BACKEND override)
// fails loudly rather than silently falling back.
//
// "Where present" (task spec, Linux libsecret): the Secret Service D-Bus
// interface requires a running provider (gnome-keyring, KWallet's
// ksecretsservice, or equivalent) — on a headless/minimal Linux install
// with none running, every call below throws (no D-Bus session, or no
// service registered on it) and detect.ts's auto-detect probe catches that
// and falls back to file0600. This module never tries to start one.

// TYPE-ONLY import (erased at compile time — it emits no require/import
// and cannot execute the addon). The runtime load is deliberately LAZY,
// below; see loadAsyncEntryCtor's header for the v0.9.0-rc.1 Windows
// outage that made this non-negotiable.
import type { AsyncEntry } from "@napi-rs/keyring";
import type { SecretBackend, SecretRef } from "@loombre/provisioning";
import type { SecretBackendImpl } from "./types.js";
import { AmbiguousSecretError, SecretNotFoundError, UnsupportedSecretBackendError } from "./errors.js";
import { generateRandomSecretValue } from "./file0600.js";

/** Fixed service namespace every Loombre-managed credential is filed under
 *  in the OS store — `ref.key` (always caller-chosen, e.g.
 *  "embedded-pg-superuser" or "jwt-signing-secret") is the per-entry
 *  username/account within it. Safe to log; it is not a secret. */
const SERVICE = "com.loombre.secrets";

const PLATFORM_FOR_BACKEND: Record<Extract<SecretBackend, "keychain" | "dpapi" | "libsecret">, NodeJS.Platform> = {
  keychain: "darwin",
  dpapi: "win32",
  libsecret: "linux",
};

function assertPlatformSupportsBackend(backend: SecretBackend, platform: NodeJS.Platform): void {
  const required = (PLATFORM_FOR_BACKEND as Record<string, NodeJS.Platform | undefined>)[backend];
  if (required === undefined) {
    throw new UnsupportedSecretBackendError(backend, `not a native-keyring backend (got "${backend}")`);
  }
  if (platform !== required) {
    throw new UnsupportedSecretBackendError(
      backend,
      `requires platform "${required}", running on "${platform}".`,
    );
  }
}

/**
 * VERIFIED against the real macOS Keychain (this dev host, darwin-arm64,
 * @napi-rs/keyring 1.3.0): a missing entry's `getPassword()` resolves to
 * `null` — it does NOT reject, despite the .d.ts doc comment describing a
 * thrown "NoEntry" error (index.d.ts documents the underlying keyring-rs
 * crate's API contract, which this binding does not surface 1:1 on every
 * platform/version). `deletePassword()` on a missing entry likewise
 * resolves `false` rather than rejecting. The classifier below exists as
 * defense-in-depth for whatever win32/linux (Credential Manager / Secret
 * Service) actually do — untested on this host — should either of those
 * genuinely reject with a NoEntry-shaped message instead of resolving
 * null; Ambiguous is real and documented for all platforms (a third-party
 * app can create a colliding credential), so it is always classified and
 * surfaced distinctly, never swallowed as absence. */
function classifyKeyringError(err: unknown): "no-entry" | "ambiguous" | "other" {
  const message = err instanceof Error ? err.message : String(err);
  if (/no matching entry|not found/i.test(message)) return "no-entry";
  if (/ambiguous/i.test(message)) return "ambiguous";
  return "other";
}

type AsyncEntryConstructor = new (service: string, key: string) => AsyncEntry;

/** Resolves once and is reused; a rejected load stays rejected on purpose
 *  (a missing system DLL does not appear later in the process's lifetime,
 *  and retrying a failed dlopen on every secret operation would just burn
 *  syscalls). */
let keyringLoad: Promise<AsyncEntryConstructor> | undefined;

/**
 * Loads @napi-rs/keyring's AsyncEntry ON DEMAND, converting any load
 * failure into this package's own typed error.
 *
 * WHY LAZY — v0.9.0-rc.1, real Windows 11 install, both LoombreServer and
 * LoombreWorker dead on arrival with three restarts each and zero
 * application log output:
 *
 *   Error: Cannot find native binding.
 *     [cause]: Error: The specified module could not be found.
 *       ...\@napi-rs\keyring-win32-x64-msvc\keyring.win32-x64-msvc.node
 *       code: 'ERR_DLOPEN_FAILED'
 *
 * The .node file was present and correct. The addon imports
 * VCRUNTIME140.dll, which ships with the Visual C++ redistributable and
 * NOT with Windows — so it loaded on every CI runner (Visual Studio
 * preinstalled) and on no clean machine. This module used to import the
 * addon at module scope, so that environmental failure propagated up the
 * whole import graph and killed the process, taking down a server whose
 * OTHER secret backend (file0600) works everywhere and needs nothing
 * native at all.
 *
 * detect.ts has always documented `source: "fallback"` as covering "the
 * addon didn't load"; a static import made that documented path
 * unreachable. Deferring the load to first USE is what makes it real: the
 * module graph stays clean, detect.ts's probe catches the failure, and an
 * install with no OS credential store simply keeps its secrets in
 * file0600 — degraded, working, and logged, instead of a boot loop.
 */
async function loadAsyncEntryCtor(backend: SecretBackend): Promise<AsyncEntryConstructor> {
  keyringLoad ??= import("@napi-rs/keyring").then((mod) => mod.AsyncEntry as AsyncEntryConstructor);
  try {
    return await keyringLoad;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new UnsupportedSecretBackendError(
      backend,
      `the @napi-rs/keyring native addon failed to load on this host (${detail.split("\n")[0]}). ` +
        `On Windows this is usually a missing Visual C++ redistributable (VCRUNTIME140.dll); ` +
        `on Linux, a build with no prebuilt for this OS/arch. Auto-detect falls back to the ` +
        `file0600 backend automatically — set LOOMBRE_SECRET_BACKEND=file0600 to select it explicitly.`,
    );
  }
}

async function safeGetPassword(entry: AsyncEntry, backend: SecretBackend, key: string): Promise<string | null> {
  try {
    const value = await entry.getPassword();
    return value ?? null;
  } catch (err) {
    const kind = classifyKeyringError(err);
    if (kind === "no-entry") return null;
    if (kind === "ambiguous") throw new AmbiguousSecretError(backend, key, err);
    throw err;
  }
}

export function createNativeKeyringBackend(backend: SecretBackend, platform: NodeJS.Platform = process.platform): SecretBackendImpl {
  assertPlatformSupportsBackend(backend, platform);

  // Async now (it awaits the deferred addon load) — note that
  // createNativeKeyringBackend itself stays SYNCHRONOUS and still throws
  // eagerly for a wrong-platform request. Only the part that genuinely
  // needs native code is deferred; the pure-logic guard above keeps
  // failing loudly at construction, as it always did.
  const entryFor = async (key: string): Promise<AsyncEntry> => {
    const AsyncEntryCtor = await loadAsyncEntryCtor(backend);
    return new AsyncEntryCtor(SERVICE, key);
  };

  return {
    async generate(key: string) {
      const entry = await entryFor(key);
      const existing = await safeGetPassword(entry, backend, key);
      if (existing !== null) {
        return { ref: { backend, key }, value: existing };
      }
      const value = generateRandomSecretValue();
      await entry.setPassword(value);
      return { ref: { backend, key }, value };
    },

    async store(key: string, value: string): Promise<SecretRef> {
      await (await entryFor(key)).setPassword(value);
      return { backend, key };
    },

    async resolve(ref: SecretRef): Promise<string> {
      const value = await safeGetPassword(await entryFor(ref.key), backend, ref.key);
      if (value === null) throw new SecretNotFoundError(ref);
      return value;
    },

    async remove(ref: SecretRef): Promise<void> {
      try {
        await (await entryFor(ref.key)).deletePassword();
      } catch {
        // Best-effort per SecretBackendImpl.remove's contract — which now
        // also absorbs "the addon never loaded", so an uninstall/rotate
        // path on a host with no native store stays silent rather than
        // erroring about a credential that cannot exist there anyway.
      }
    },
  };
}

/** Cheap real availability probe used by detect.ts's auto-detect: a
 *  round-trip write+read+delete against a throwaway key, on THIS platform's
 *  native backend. Returns false (never throws) for any failure — a locked
 *  keychain prompt the user dismissed, no D-Bus session, an unsupported
 *  platform/backend pairing, or the native addon failing to load at all
 *  (e.g. an unpinned OS/arch @napi-rs/keyring has no prebuilt for). */
export async function probeNativeKeyringAvailable(backend: SecretBackend, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    const impl = createNativeKeyringBackend(backend, platform);
    const probeKey = `__loombre_probe__${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await impl.store(probeKey, "probe");
    const readBack = await impl.resolve({ backend, key: probeKey });
    await impl.remove({ backend, key: probeKey });
    return readBack === "probe";
  } catch {
    return false;
  }
}
