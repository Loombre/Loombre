// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/lib/build-manifest-lib.mjs
//
// Pure logic for assembling + validating a release manifest.json
// (@loombre/release-manifest's ReleaseManifest shape, P4.3). Kept separate
// from build-manifest.mjs (the CLI/fs-walking wrapper) so
// scripts/release/test/build-manifest.test.mjs can exercise it with
// node:test and in-memory fixtures — no real files, no CI environment
// needed.
//
// Validation note (see the release-lane report's "deviations" section):
// this hand-rolled structural validator mirrors
// packages/release-manifest/src/manifest.ts's RELEASE_MANIFEST_SCHEMA
// field-for-field, rather than running it through ajv. ajv is a
// devDependency of @loombre/release-manifest (used by THAT package's own
// test suite) and of packages/contract, but not a reachable production
// dependency from scripts/release/ without a pnpm-lock.yaml edit — barred
// this wave (lockfile freeze, lane F is sole owner — see
// release-manifest-import.ts's header in apps/server for the identical
// constraint on the server side). The enum arrays used below
// (ARTIFACT_PLATFORMS/ARTIFACT_KINDS/RELEASE_CHANNELS) are imported
// directly from the frozen package, so this validator cannot silently
// drift from the authoritative source even though the shape-checking code
// itself is hand-written rather than ajv-compiled.

import {
  RELEASE_MANIFEST_VERSION,
  RELEASE_CHANNELS,
  ARTIFACT_PLATFORMS,
  ARTIFACT_KINDS,
} from "../../../packages/release-manifest/dist/manifest.js";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * @param {import("../../../packages/release-manifest/dist/manifest.js").ReleaseManifest} manifest
 * @returns {string[]} validation error messages (empty = valid)
 */
export function validateManifestShape(manifest) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (typeof manifest !== "object" || manifest === null) {
    return ["manifest must be an object"];
  }
  if (manifest.manifestVersion !== RELEASE_MANIFEST_VERSION) {
    push(`manifestVersion must be ${RELEASE_MANIFEST_VERSION}, got ${JSON.stringify(manifest.manifestVersion)}`);
  }
  if (!RELEASE_CHANNELS.includes(manifest.channel)) {
    push(`channel must be one of ${RELEASE_CHANNELS.join(", ")}, got ${JSON.stringify(manifest.channel)}`);
  }
  if (!Array.isArray(manifest.releases)) {
    push("releases must be an array");
    return errors;
  }

  manifest.releases.forEach((release, i) => {
    const prefix = `releases[${i}]`;
    if (typeof release.version !== "string" || !SEMVER_PATTERN.test(release.version)) {
      push(`${prefix}.version must be a valid semver string, got ${JSON.stringify(release.version)}`);
    }
    if (typeof release.releasedAtMs !== "number" || !Number.isInteger(release.releasedAtMs) || release.releasedAtMs < 0) {
      push(`${prefix}.releasedAtMs must be a non-negative integer`);
    }
    if (typeof release.notesUrl !== "string" || release.notesUrl.length === 0) {
      push(`${prefix}.notesUrl must be a non-empty string`);
    }
    if (!Array.isArray(release.artifacts)) {
      push(`${prefix}.artifacts must be an array`);
      return;
    }
    release.artifacts.forEach((artifact, j) => {
      const aprefix = `${prefix}.artifacts[${j}]`;
      if (!ARTIFACT_PLATFORMS.includes(artifact.platform)) {
        push(`${aprefix}.platform must be one of ${ARTIFACT_PLATFORMS.join(", ")}, got ${JSON.stringify(artifact.platform)}`);
      }
      if (!ARTIFACT_KINDS.includes(artifact.kind)) {
        push(`${aprefix}.kind must be one of ${ARTIFACT_KINDS.join(", ")}, got ${JSON.stringify(artifact.kind)}`);
      }
      if (typeof artifact.filename !== "string" || artifact.filename.length === 0) {
        push(`${aprefix}.filename must be a non-empty string`);
      }
      if (typeof artifact.sizeBytes !== "number" || !Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
        push(`${aprefix}.sizeBytes must be a non-negative integer`);
      }
      if (typeof artifact.sha256 !== "string" || !SHA256_PATTERN.test(artifact.sha256)) {
        push(`${aprefix}.sha256 must be 64 lowercase hex characters, got ${JSON.stringify(artifact.sha256)}`);
      }
      if (typeof artifact.url !== "string" || artifact.url.length === 0) {
        push(`${aprefix}.url must be a non-empty string`);
      }
    });
  });

  return errors;
}

/** Filename convention every build-* job's artifact must follow:
 *  loombre-<version>-<platform>.<ext>  (e.g. loombre-0.9.0-linux-x64.tar.gz) */
const ARTIFACT_FILENAME_PATTERN = /^loombre-(.+?)-(linux-x64|linux-arm64|windows-x64|macos-arm64|macos-x64)\.(.+)$/;

const EXTENSION_TO_KIND = {
  "tar.gz": "tarball",
  msi: "msi",
  pkg: "pkg",
};

/**
 * @param {string} filename
 * @returns {{ platform: string, kind: string } | null}
 */
export function inferPlatformAndKind(filename) {
  const match = ARTIFACT_FILENAME_PATTERN.exec(filename);
  if (!match) return null;
  const [, , platform, extRest] = match;
  const kind = EXTENSION_TO_KIND[extRest] ?? EXTENSION_TO_KIND[extRest.split(".").pop()];
  if (!kind || !platform) return null;
  return { platform, kind };
}

/**
 * @param {{
 *   version: string,
 *   releasedAtMs: number,
 *   notesUrl: string,
 *   channel?: string,
 *   artifacts: Array<{ platform: string, kind: string, filename: string, sizeBytes: number, sha256: string, url: string }>,
 * }} input
 * @returns {import("../../../packages/release-manifest/dist/manifest.js").ReleaseManifest}
 */
export function buildManifest(input) {
  return {
    manifestVersion: RELEASE_MANIFEST_VERSION,
    channel: input.channel ?? "stable",
    releases: [
      {
        version: input.version,
        releasedAtMs: input.releasedAtMs,
        notesUrl: input.notesUrl,
        artifacts: input.artifacts,
      },
    ],
  };
}
