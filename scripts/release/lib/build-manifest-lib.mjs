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
  // The Windows Burn bootstrapper. Its ABSENCE here is what silently
  // dropped loombre-0.9.0-rc.2-windows-x64.exe from the signed manifest:
  // inferPlatformAndKind returned null, and build-manifest console.warn'd
  // and skipped it, so SHA256SUMS (which globs the directory) listed the
  // file while manifest.json — the artifact a download page or updater
  // actually reads — did not. Adding an artifact type now requires a line
  // here, and collectFileArtifacts FAILS on an unrecognized file rather
  // than warning, so the next one cannot vanish the same way.
  exe: "bundle",
  pkg: "pkg",
  // The two Linux native-package channels (installers/linux/build-rpm.mjs /
  // build-deb.mjs — Fedora/RHEL/derivatives and Debian/Ubuntu respectively),
  // alongside the pre-existing "tarball" channel for the same platforms.
  rpm: "rpm",
  deb: "deb",
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

/** The Docker image sidecar files build-docker's job in release.yml writes
 *  (see build-manifest.mjs's header for the full envelope contract): one
 *  per published image — "docker-image.json" for the server image and
 *  "docker-web-image.json" for the web image (added when the Docker
 *  channel started shipping a second image; AUD-A5c-001 was this list
 *  never growing to cover it, so the web image silently never reached a
 *  signed manifest.json). Both sidecars are build INPUTS, not release
 *  artifacts in their own right (AUD-A5c-002) — build-manifest.mjs deletes
 *  each one from --artifacts-dir once the manifest that folded it in (via
 *  buildDockerArtifacts below) has actually been written, so neither can
 *  leak into a GitHub Release's literal asset list.
 *
 *  NOT a full single source of truth, despite the name suggesting one: a
 *  third sidecar needs edits in THREE places, not one.
 *    1. This array (adds it to buildDockerArtifacts's shaping loop).
 *    2. build-manifest.mjs's collectFileArtifacts, which imports and reads
 *       this exact array for its non-artifact skip-list — genuinely
 *       centralized with (1), so no separate edit needed there in
 *       practice. Forgetting (1) here means collectFileArtifacts no
 *       longer skips the new sidecar and its unrecognized-extension THROW
 *       fires, failing the release build loudly (see that function's
 *       comment in build-manifest.mjs) — safe, not silent.
 *    3. scripts/release/sha256sums.mjs's OWN EXCLUDED_FILES Set
 *       (sha256sums.mjs:26-33), which duplicates these two filenames by
 *       hand. It cannot import this array today: that would pull
 *       sha256sums.mjs into this module's packages/release-manifest/dist
 *       dependency for a two-string list, and scripts/release/ has no
 *       neutral shared module to host just the filename list without
 *       either import direction becoming circular-ish plumbing for no
 *       real payoff. Forgetting (3) is the dangerous one: nothing throws,
 *       the new sidecar just gets checksummed into SHA256SUMS and
 *       published as a literal GitHub Release download asset — the
 *       AUD-A5c-002 class of bug, silently. */
export const DOCKER_SIDECAR_FILES = ["docker-image.json", "docker-web-image.json"];

/**
 * Shapes whichever Docker sidecars were present in --artifacts-dir into
 * release artifacts. Pure: takes already-parsed sidecar JSON (no fs), so
 * this can be unit-tested with in-memory fixtures — the CLI wrapper does
 * the actual reading/deleting.
 *
 * @param {Partial<Record<"docker-image.json" | "docker-web-image.json", { filename: string, sizeBytes: number, sha256: string, url: string }>>} sidecarsByFile
 *   Keyed by DOCKER_SIDECAR_FILES entries; a missing/undefined key means
 *   that sidecar was not present (e.g. a local dev build that only
 *   produced the server image).
 * @returns {Array<{ platform: string, kind: string, filename: string, sizeBytes: number, sha256: string, url: string }>}
 */
export function buildDockerArtifacts(sidecarsByFile) {
  const artifacts = [];
  for (const file of DOCKER_SIDECAR_FILES) {
    const sidecar = sidecarsByFile[file];
    if (!sidecar) continue;
    artifacts.push({
      platform: "docker",
      kind: "docker-image",
      filename: sidecar.filename,
      sizeBytes: sidecar.sizeBytes,
      sha256: sidecar.sha256,
      url: sidecar.url,
    });
  }
  return artifacts;
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
