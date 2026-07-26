// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/test/support/real-binaries.ts
//
// Shared support for the REAL, no-mocks integration suites (this package's
// exit bar): resolves this host's platform, ensures the pinned binaries are
// vendored (fetching them for real over the network via
// scripts/fetch-embedded-pg.mjs's exported fetchEmbeddedPg — the exact same
// code path `node scripts/fetch-embedded-pg.mjs` itself runs, not a
// reimplementation), and gates the suites the same way the repo's other
// real-hardware/real-binary suites do (docs/PLAYBACK.md Step 7 CI-fix
// precedent, apps/worker/test/transcode/vt-tonemap-args.integration.spec.ts):
// LOUD skip off the proven platform (darwin-arm64 — this lane's own
// research + integration tests ran here), hard-fail escalation behind an
// explicit env var for owner-hardware CI legs.

import { resolveEmbeddedPgPlatform, type EmbeddedPgPlatform } from "../../src/platform.js";
import { resolveVendorBinaries, type VendorBinaries } from "../../src/binaries.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
export const VENDOR_DIR = join(REPO_ROOT, "vendor", "embedded-pg");

export const PG_CURRENT_VERSION = "18.4.0";
export const PG_UPGRADE_FROM_VERSION = "17.10.0";

export const REQUIRE_ENV_VAR = "LOOMBRE_REQUIRE_PG_PROVISIONING_INTEGRATION";

export function hostPlatform(): EmbeddedPgPlatform | null {
  return resolveEmbeddedPgPlatform(process.platform, process.arch);
}

/** True only on the platform this lane's real integration tests were
 *  proven against (darwin-arm64 — see the package report). Other
 *  platforms/architectures skip loudly rather than silently, unless the
 *  REQUIRE env var escalates that skip to a hard failure (owner-hardware
 *  CI leg pattern, matching vt-tonemap-args.integration.spec.ts). */
export function isProvenIntegrationHost(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

export function requireEnvSet(): boolean {
  return process.env[REQUIRE_ENV_VAR] === "1";
}

/**
 * Ensures the given pg version's binaries are vendored for this host,
 * fetching them for real (network) if missing, then resolves+verifies
 * every binary path this package needs. Throws if the host platform isn't
 * one of the five pinned targets, or if the fetch fails (caller should
 * only invoke this after isProvenIntegrationHost() gates the suite —
 * fetch failures inside a gated suite are real bugs, not "no network"
 * skips, since CI's own darwin-arm64 runners are the exact ones this was
 * proven against).
 */
export async function ensureRealBinaries(pgVersion: string): Promise<{ platform: EmbeddedPgPlatform; binaries: VendorBinaries }> {
  const platform = hostPlatform();
  if (!platform) {
    throw new Error(`real-binaries test support: unsupported host platform ${process.platform}/${process.arch}`);
  }

  try {
    return { platform, binaries: resolveVendorBinaries(VENDOR_DIR, platform, pgVersion) };
  } catch {
    // scripts/fetch-embedded-pg.mjs is a plain repo script, not a typed
    // workspace package — no .d.ts exists for it. A non-literal specifier
    // (built at runtime, not a string TS can statically resolve) makes
    // this a `Promise<any>` import rather than a TS7016 "could not find a
    // declaration file" error; the explicit cast right after gives the
    // rest of this function a real type to work with. Must be an ABSOLUTE
    // file URL: vite-node resolves runtime-relative specifiers against the
    // module's root-relative ID and clamps `..` at the package root, so a
    // "../../../../scripts/…" string resolves to /scripts/… on a clean
    // clone (only reachable when vendor/ is empty — the cached-binaries
    // fast path above masked this on any warmed checkout).
    const fetchScriptUrl = pathToFileURL(join(REPO_ROOT, "scripts", "fetch-embedded-pg.mjs")).href;
    const mod = (await import(/* @vite-ignore */ fetchScriptUrl)) as {
      fetchEmbeddedPg: (opts: { platform: string; pgVersion: string; vendorDir: string }) => Promise<string>;
    };
    await mod.fetchEmbeddedPg({ platform: "host", pgVersion, vendorDir: VENDOR_DIR });
    return { platform, binaries: resolveVendorBinaries(VENDOR_DIR, platform, pgVersion) };
  }
}
