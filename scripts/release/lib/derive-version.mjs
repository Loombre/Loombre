// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/lib/derive-version.mjs
//
// Pure version-derivation logic (STATE.md P4.11): root package.json's
// `version` field is the single source of truth. This module turns that
// one value plus a build mode + optional git short-hash into the exact
// constants `packages/shared/src/version.ts` gets stamped with — kept as
// plain, dependency-free functions so scripts/release/test/derive-version.
// test.mjs can exercise them with node's built-in test runner (no vitest
// workspace wiring needed for a handful of pure functions, and — this
// wave — no lockfile edits at all, see the release-lane report).
//
// Two build modes (mission spec: "dev builds show <version>-dev+<shorthash>
// and release builds the clean semver"):
//   - "dev":     versionFull = "<version>-dev+<shorthash>" (shorthash
//                "unknown" when git metadata isn't available, e.g. a
//                tarball checkout with no .git directory — never throws).
//   - "release": versionFull = "<version>" exactly (what a `git tag v*`
//                release build ships; no build metadata suffix).

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Git short-hash shape minisign/manifest tooling also expects to be a
 *  plain lowercase-hex token — validated so a corrupted/empty `git
 *  rev-parse` result fails loudly instead of silently baking garbage into
 *  the generated file. */
const SHORTHASH_PATTERN = /^[0-9a-f]{4,40}$/i;

export const BUILD_MODES = /** @type {const} */ (["dev", "release"]);

/**
 * @param {string} rawVersion
 * @returns {string} the validated version string
 */
export function assertValidSemver(rawVersion) {
  const trimmed = rawVersion.trim();
  if (!SEMVER_PATTERN.test(trimmed)) {
    throw new Error(
      `derive-version: root package.json "version" (${JSON.stringify(rawVersion)}) is not a valid semver string`,
    );
  }
  return trimmed;
}

/**
 * @param {{ baseVersion: string, mode: "dev" | "release", gitShortHash?: string | null }} input
 * @returns {{ version: string, buildMode: "dev" | "release", gitShortHash: string | null, versionFull: string }}
 */
export function deriveVersion({ baseVersion, mode, gitShortHash }) {
  if (!BUILD_MODES.includes(mode)) {
    throw new Error(`derive-version: unknown build mode ${JSON.stringify(mode)} (expected "dev" or "release")`);
  }
  const version = assertValidSemver(baseVersion);

  if (mode === "release") {
    return { version, buildMode: "release", gitShortHash: null, versionFull: version };
  }

  const normalizedHash =
    gitShortHash !== undefined && gitShortHash !== null && SHORTHASH_PATTERN.test(gitShortHash.trim())
      ? gitShortHash.trim().toLowerCase()
      : null;
  const hashForDisplay = normalizedHash ?? "unknown";
  return {
    version,
    buildMode: "dev",
    gitShortHash: normalizedHash,
    versionFull: `${version}-dev+${hashForDisplay}`,
  };
}

const GENERATED_BANNER = "// GENERATED — do not edit (node scripts/release/stamp-version.mjs)\n";

/**
 * Renders `packages/shared/src/version.ts`'s exact source text. Mirrors the
 * SDK codegen convention (packages/contract/scripts/codegen.mjs): pure data
 * constants only, no hand-written logic in the generated file itself, so
 * the file is safe for packages/playback-engine to transitively reach
 * through @loombre/shared without pulling in any node:* builtin import
 * (.dependency-cruiser.cjs's playback-engine purity rule).
 *
 * @param {{ version: string, buildMode: "dev" | "release", gitShortHash: string | null, versionFull: string }} derived
 * @returns {string}
 */
export function renderVersionFileSource(derived) {
  const hashLiteral = derived.gitShortHash === null ? "null" : JSON.stringify(derived.gitShortHash);
  return (
    GENERATED_BANNER +
    "//\n" +
    "// Single-source version stamping (STATE.md P4.11): root package.json's\n" +
    "// `version` field is authoritative. Regenerate with `pnpm stamp-version`\n" +
    "// (dev mode, default) or `pnpm stamp-version --release` (release mode,\n" +
    "// used by .github/workflows/release.yml before every build-* job).\n" +
    "\n" +
    `export const LOOMBRE_VERSION = ${JSON.stringify(derived.version)};\n` +
    `export const LOOMBRE_BUILD_MODE: "dev" | "release" = ${JSON.stringify(derived.buildMode)};\n` +
    `export const LOOMBRE_GIT_SHORTHASH: string | null = ${hashLiteral};\n` +
    "/** \"<version>-dev+<shorthash>\" in dev builds, exactly \"<version>\" in release builds — /system/info and `loombre --version` both read this one constant. */\n" +
    `export const LOOMBRE_VERSION_FULL = ${JSON.stringify(derived.versionFull)};\n`
  );
}
