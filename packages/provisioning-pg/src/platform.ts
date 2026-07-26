// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/platform.ts
//
// Pure Node-platform -> installer-lane-platform mapping. Deliberately the
// SAME five-member closed set as @loombre/release-manifest's ArtifactPlatform
// minus 'docker' (docker never runs embedded PG — I2's container gets
// Postgres from the compose service, not this package) — installers/
// embedded-pg-manifest.json's `versions.*.platforms` keys are exactly this
// set, and scripts/fetch-embedded-pg.mjs's KNOWN_PLATFORMS mirrors it too.

export type EmbeddedPgPlatform = "linux-x64" | "linux-arm64" | "windows-x64" | "macos-x64" | "macos-arm64";

export const EMBEDDED_PG_PLATFORMS: readonly EmbeddedPgPlatform[] = [
  "linux-x64",
  "linux-arm64",
  "windows-x64",
  "macos-x64",
  "macos-arm64",
];

/** Pure: takes process.platform/process.arch as EXPLICIT arguments (never
 *  reads them itself) so every branch is unit-testable from one host.
 *  Returns null for a combination this package has no pinned binaries for,
 *  rather than guessing. */
export function resolveEmbeddedPgPlatform(nodePlatform: NodeJS.Platform, arch: string): EmbeddedPgPlatform | null {
  if (nodePlatform === "linux") {
    if (arch === "arm64") return "linux-arm64";
    if (arch === "x64") return "linux-x64";
    return null;
  }
  if (nodePlatform === "darwin") {
    if (arch === "arm64") return "macos-arm64";
    if (arch === "x64") return "macos-x64";
    return null;
  }
  if (nodePlatform === "win32") {
    if (arch === "x64") return "windows-x64";
    return null;
  }
  return null;
}

export function isWindowsPlatform(platform: EmbeddedPgPlatform): boolean {
  return platform === "windows-x64";
}
