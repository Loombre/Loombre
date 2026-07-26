// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/secrets/src/detect.ts
//
// Backend auto-detect (deliverable 5: "Backend auto-detect with explicit
// override env"). LOOMBRE_SECRET_BACKEND, when set, wins unconditionally —
// an operator who explicitly asks for "file0600" on macOS gets exactly
// that, no probing, no silent override (same "env always wins" posture
// P4.17/jwt-secret.ts documents for LOOMBRE_JWT_SECRET). Without an
// override, the platform's native store is tried first via a cheap
// round-trip probe (native-keyring.ts's probeNativeKeyringAvailable) and
// file0600 is the universal fallback when it fails or the platform has no
// native backend at all (there is currently no 'libsecret'-equivalent
// mapped for anything but linux, etc.).

import type { SecretBackend } from "@loombre/provisioning";
import { SECRET_BACKENDS } from "@loombre/provisioning";
import { probeNativeKeyringAvailable } from "./native-keyring.js";

const NATIVE_BACKEND_FOR_PLATFORM: Partial<Record<NodeJS.Platform, SecretBackend>> = {
  darwin: "keychain",
  win32: "dpapi",
  linux: "libsecret",
};

export interface DetectBackendEnv {
  LOOMBRE_SECRET_BACKEND?: string | undefined;
}

/** Parses+validates an explicit override without probing anything — throws
 *  a plain Error (not UnsupportedSecretBackendError, which is about
 *  platform mismatch, not a typo) for a value outside the closed
 *  SecretBackend enum, so a misspelled env var fails loudly at boot rather
 *  than silently falling through to auto-detect. */
export function parseBackendOverride(raw: string | undefined): SecretBackend | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!(SECRET_BACKENDS as readonly string[]).includes(trimmed)) {
    throw new Error(
      `@loombre/secrets: LOOMBRE_SECRET_BACKEND="${trimmed}" is not one of ${SECRET_BACKENDS.join(", ")}.`,
    );
  }
  return trimmed as SecretBackend;
}

export interface DetectedBackend {
  backend: SecretBackend;
  /** "override" = LOOMBRE_SECRET_BACKEND was honored verbatim; "native" =
   *  this platform's OS store probed successfully; "fallback" = no native
   *  backend exists for this platform, or the probe failed (locked store,
   *  no D-Bus session, addon didn't load for this OS/arch, ...). */
  source: "override" | "native" | "fallback";
}

export async function detectSecretBackend(
  env: DetectBackendEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<DetectedBackend> {
  const override = parseBackendOverride(env.LOOMBRE_SECRET_BACKEND);
  if (override) return { backend: override, source: "override" };

  const native = NATIVE_BACKEND_FOR_PLATFORM[platform];
  if (native && (await probeNativeKeyringAvailable(native, platform))) {
    return { backend: native, source: "native" };
  }

  return { backend: "file0600", source: "fallback" };
}
