// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/update-check/perform-check.ts
//
// The actual notify-only update check (STATE.md P4.3/P4.16): fetches
// manifest.json + manifest.json.minisig from the configured (env-
// overridable) mirror, verifies the signature against the PINNED public
// key via @loombre/release-manifest (never a key the response itself
// supplies — that would make the "verification" meaningless), and decides
// whether a newer release exists for this server's channel. NEVER writes
// anything, NEVER triggers a download, NEVER auto-applies anything — the
// return value is display data for GET /system/update, full stop.
//
// D14 (docs/ops/updating.md documents this exhaustively): the ONLY two
// outbound requests this function ever makes are bare GETs, no query
// string, to the two manifest URLs, with exactly the headers in
// REQUEST_HEADERS below — no current version, no OS, no install id, no
// cookies, nothing else identifying. apps/server/test/common/update-check/
// zero-identifying-payload.spec.ts captures a real outgoing request
// against a local fixture HTTP server and asserts this byte-for-byte.

import {
  verifyManifestSignature,
  MANIFEST_FILENAME,
  MANIFEST_SIGNATURE_FILENAME,
  type ReleaseChannel,
} from "@loombre/release-manifest";
import { isWellFormedManifest } from "./manifest-guard.js";
import { compareSemver, maxSemver } from "./semver-compare.js";

export type UpdateCheckMode = "off" | "manual" | "daily";
export type SystemUpdateVerification = "verified" | "signature-invalid" | "unreachable" | "disabled";

export interface SystemUpdateInfo {
  currentVersion: string;
  channel: ReleaseChannel;
  latestVersion: string | null;
  updateAvailable: boolean;
  notesUrl: string | null;
  checkedAtMs: number | null;
  verification: SystemUpdateVerification;
}

export interface UpdateCheckConfig {
  mode: UpdateCheckMode;
  /** Base URL/directory containing manifest.json + manifest.json.minisig — no trailing slash required, this normalizes it. Env: LOOMBRE_UPDATE_MANIFEST_URL. */
  manifestBaseUrl: string;
  channel: ReleaseChannel;
  currentVersion: string;
  /** The PINNED key text (packages/shared's LOOMBRE_UPDATE_PUBLIC_KEY_TEXT, P4.9) — never taken from the network response. */
  publicKeyText: string;
}

export interface UpdateCheckDeps {
  fetchImpl: typeof fetch;
  clockNowMs: () => number;
}

/**
 * D14: exactly this, nothing more, ever. `Accept` is a normal HTTP
 * negotiation header (not identifying); `User-Agent` is a fixed,
 * generic literal — never the running Loombre version, OS, or any
 * per-install identifier (that would defeat the point).
 */
export const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "loombre-update-check",
  Accept: "application/json, text/plain;q=0.9",
};

function disabledResult(config: UpdateCheckConfig): SystemUpdateInfo {
  return {
    currentVersion: config.currentVersion,
    channel: config.channel,
    latestVersion: null,
    updateAvailable: false,
    notesUrl: null,
    checkedAtMs: null,
    verification: "disabled",
  };
}

function unreachableResult(config: UpdateCheckConfig, checkedAtMs: number): SystemUpdateInfo {
  return {
    currentVersion: config.currentVersion,
    channel: config.channel,
    latestVersion: null,
    updateAvailable: false,
    notesUrl: null,
    checkedAtMs,
    verification: "unreachable",
  };
}

function signatureInvalidResult(config: UpdateCheckConfig, checkedAtMs: number): SystemUpdateInfo {
  return {
    currentVersion: config.currentVersion,
    channel: config.channel,
    latestVersion: null,
    updateAvailable: false,
    notesUrl: null,
    checkedAtMs,
    verification: "signature-invalid",
  };
}

export async function performUpdateCheck(config: UpdateCheckConfig, deps: UpdateCheckDeps): Promise<SystemUpdateInfo> {
  if (config.mode === "off") {
    return disabledResult(config);
  }

  const checkedAtMs = deps.clockNowMs();
  const base = config.manifestBaseUrl.replace(/\/+$/, "");
  const manifestUrl = `${base}/${MANIFEST_FILENAME}`;
  const sigUrl = `${base}/${MANIFEST_SIGNATURE_FILENAME}`;

  let manifestRes: Response;
  let sigRes: Response;
  try {
    [manifestRes, sigRes] = await Promise.all([
      deps.fetchImpl(manifestUrl, { method: "GET", headers: REQUEST_HEADERS }),
      deps.fetchImpl(sigUrl, { method: "GET", headers: REQUEST_HEADERS }),
    ]);
  } catch {
    return unreachableResult(config, checkedAtMs);
  }

  if (!manifestRes.ok || !sigRes.ok) {
    return unreachableResult(config, checkedAtMs);
  }

  let manifestText: string;
  let sigText: string;
  try {
    [manifestText, sigText] = await Promise.all([manifestRes.text(), sigRes.text()]);
  } catch {
    return unreachableResult(config, checkedAtMs);
  }

  const manifestBytes = new TextEncoder().encode(manifestText);
  const verifyResult = verifyManifestSignature(manifestBytes, sigText, config.publicKeyText);
  if (!verifyResult.valid) {
    return signatureInvalidResult(config, checkedAtMs);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(manifestText);
  } catch {
    // Signed but not parseable JSON should never happen for a genuinely
    // signed manifest — treat as "couldn't get a usable result" rather
    // than inventing a fifth verification state.
    return unreachableResult(config, checkedAtMs);
  }

  if (!isWellFormedManifest(parsedJson) || parsedJson.channel !== config.channel) {
    return unreachableResult(config, checkedAtMs);
  }

  const versions = parsedJson.releases.map((r) => r.version);
  const latestVersion = maxSemver(versions);
  if (latestVersion === null) {
    return {
      currentVersion: config.currentVersion,
      channel: config.channel,
      latestVersion: null,
      updateAvailable: false,
      notesUrl: null,
      checkedAtMs,
      verification: "verified",
    };
  }

  const latestEntry = parsedJson.releases.find((r) => r.version === latestVersion)!;
  return {
    currentVersion: config.currentVersion,
    channel: config.channel,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, config.currentVersion) > 0,
    notesUrl: latestEntry.notesUrl,
    checkedAtMs,
    verification: "verified",
  };
}
