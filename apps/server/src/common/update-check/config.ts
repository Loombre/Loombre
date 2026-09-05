// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/update-check/config.ts
//
// STATE.md P4.3/P4.16 env resolution — pure functions of `process.env`-
// shaped input, so apps/server/test/common/update-check/config.spec.ts can
// exercise every branch without setting real environment variables.
//
// DECISION (documented at length in docs/ops/updating.md and the release-
// lane report): LOOMBRE_UPDATE_CHECK defaults to "daily", not "off"/
// "manual". docs/PLAN.md §10 says plainly "the server checks and
// notifies" (P4.3) — that is a feature of the product, not something
// buried behind opt-in, the same way comparable self-hosted media-server
// software checks for updates by default. D14's "no telemetry, no
// phone-home" requirement is satisfied by making the CONTENT of the
// request carry zero identifying information (see perform-check.ts's
// REQUEST_HEADERS + the zero-identifying-payload test) — not by making
// the check itself rare. LOOMBRE_UPDATE_CHECK=off/manual remain full
// opt-outs for anyone who wants zero background network regardless.

import type { ReleaseChannel } from "@loombre/release-manifest";
import type { UpdateCheckConfig, UpdateCheckMode } from "./perform-check.js";

const VALID_MODES: readonly UpdateCheckMode[] = ["off", "manual", "daily"];

export function resolveUpdateCheckMode(raw: string | undefined): UpdateCheckMode {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed && (VALID_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as UpdateCheckMode;
  }
  return "daily";
}

// The project's own stable channel. GitHub resolves `releases/latest` to
// the newest non-draft, non-pre-release release, so pre-releases (the
// 1.0.0-beta.N line) are never announced here — while only those exist the
// URL answers 404, which surfaces as `verification: "unreachable"`, never a
// crash, never a blocked boot (nothing here is on any user-facing hot
// path). Mirrors and airgapped installs override via
// LOOMBRE_UPDATE_MANIFEST_URL.
export const DEFAULT_MANIFEST_BASE_URL = "https://github.com/Loombre/Loombre/releases/latest/download";

export function resolveManifestBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MANIFEST_BASE_URL;
}

export const UPDATE_CHECK_CHANNEL: ReleaseChannel = "stable";

export const DAILY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckEnv {
  LOOMBRE_UPDATE_CHECK?: string | undefined;
  LOOMBRE_UPDATE_MANIFEST_URL?: string | undefined;
}

export function resolveUpdateCheckConfig(
  env: UpdateCheckEnv,
  currentVersion: string,
  publicKeyText: string,
): UpdateCheckConfig {
  return {
    mode: resolveUpdateCheckMode(env.LOOMBRE_UPDATE_CHECK),
    manifestBaseUrl: resolveManifestBaseUrl(env.LOOMBRE_UPDATE_MANIFEST_URL),
    channel: UPDATE_CHECK_CHANNEL,
    currentVersion,
    publicKeyText,
  };
}
