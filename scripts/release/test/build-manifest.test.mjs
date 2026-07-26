// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/build-manifest.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest, inferPlatformAndKind, validateManifestShape } from "../lib/build-manifest-lib.mjs";

function goodArtifact(overrides = {}) {
  return {
    platform: "linux-x64",
    kind: "tarball",
    filename: "loombre-0.9.0-linux-x64.tar.gz",
    sizeBytes: 12345,
    sha256: "a".repeat(64),
    url: "https://example.invalid/loombre-0.9.0-linux-x64.tar.gz",
    ...overrides,
  };
}

test("inferPlatformAndKind: recognizes the documented naming convention", () => {
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-linux-x64.tar.gz"), { platform: "linux-x64", kind: "tarball" });
  assert.deepEqual(inferPlatformAndKind("loombre-1.2.3-linux-arm64.tar.gz"), { platform: "linux-arm64", kind: "tarball" });
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-windows-x64.msi"), { platform: "windows-x64", kind: "msi" });
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-macos-arm64.pkg"), { platform: "macos-arm64", kind: "pkg" });
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-macos-x64.pkg"), { platform: "macos-x64", kind: "pkg" });
});

test("inferPlatformAndKind: handles a prerelease/build-metadata version embedded in the filename", () => {
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-rc.1-linux-x64.tar.gz"), {
    platform: "linux-x64",
    kind: "tarball",
  });
});

test("inferPlatformAndKind: returns null for an unrecognized filename", () => {
  assert.equal(inferPlatformAndKind("SHA256SUMS"), null);
  assert.equal(inferPlatformAndKind("manifest.json"), null);
  assert.equal(inferPlatformAndKind("manifest.json.minisig"), null);
  assert.equal(inferPlatformAndKind("loombre-0.9.0-freebsd-x64.tar.gz"), null); // unknown platform
  assert.equal(inferPlatformAndKind("loombre-0.9.0-linux-x64.exe"), null); // unknown extension
});

test("buildManifest: assembles a single-release, stable-channel manifest from artifacts", () => {
  const manifest = buildManifest({
    version: "0.9.0",
    releasedAtMs: 1_753_315_200_000,
    notesUrl: "https://example.invalid/releases/0.9.0",
    artifacts: [goodArtifact()],
  });
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.channel, "stable");
  assert.equal(manifest.releases.length, 1);
  assert.equal(manifest.releases[0].version, "0.9.0");
  assert.equal(manifest.releases[0].artifacts.length, 1);
});

test("validateManifestShape: accepts a well-formed manifest", () => {
  const manifest = buildManifest({
    version: "0.9.0",
    releasedAtMs: 1,
    notesUrl: "https://example.invalid/x",
    artifacts: [goodArtifact()],
  });
  assert.deepEqual(validateManifestShape(manifest), []);
});

test("validateManifestShape: rejects a bad manifestVersion", () => {
  const manifest = buildManifest({ version: "0.9.0", releasedAtMs: 1, notesUrl: "x", artifacts: [goodArtifact()] });
  manifest.manifestVersion = 2;
  const errors = validateManifestShape(manifest);
  assert.ok(errors.some((e) => e.includes("manifestVersion")));
});

test("validateManifestShape: rejects an unknown channel", () => {
  const manifest = buildManifest({ version: "0.9.0", releasedAtMs: 1, notesUrl: "x", artifacts: [goodArtifact()] });
  manifest.channel = "beta";
  const errors = validateManifestShape(manifest);
  assert.ok(errors.some((e) => e.includes("channel")));
});

test("validateManifestShape: rejects a malformed version string", () => {
  const manifest = buildManifest({ version: "not-a-version", releasedAtMs: 1, notesUrl: "x", artifacts: [goodArtifact()] });
  const errors = validateManifestShape(manifest);
  assert.ok(errors.some((e) => e.includes("version")));
});

test("validateManifestShape: rejects a bad artifact platform/kind/sha256", () => {
  const manifest = buildManifest({
    version: "0.9.0",
    releasedAtMs: 1,
    notesUrl: "x",
    artifacts: [goodArtifact({ platform: "freebsd", kind: "zip", sha256: "not-hex" })],
  });
  const errors = validateManifestShape(manifest);
  assert.ok(errors.some((e) => e.includes("platform")));
  assert.ok(errors.some((e) => e.includes("kind")));
  assert.ok(errors.some((e) => e.includes("sha256")));
});

test("validateManifestShape: rejects a negative sizeBytes", () => {
  const manifest = buildManifest({
    version: "0.9.0",
    releasedAtMs: 1,
    notesUrl: "x",
    artifacts: [goodArtifact({ sizeBytes: -1 })],
  });
  const errors = validateManifestShape(manifest);
  assert.ok(errors.some((e) => e.includes("sizeBytes")));
});

test("validateManifestShape: rejects a non-array releases field without throwing", () => {
  const manifest = { manifestVersion: 1, channel: "stable", releases: "nope" };
  const errors = validateManifestShape(manifest);
  assert.ok(errors.some((e) => e.includes("releases must be an array")));
});

test("validateManifestShape: accepts a docker-image artifact", () => {
  const manifest = buildManifest({
    version: "0.9.0",
    releasedAtMs: 1,
    notesUrl: "x",
    artifacts: [
      goodArtifact({
        platform: "docker",
        kind: "docker-image",
        filename: "ghcr.io/loombre/loombre:0.9.0",
        sha256: "b".repeat(64),
        url: "https://ghcr.io/loombre/loombre:0.9.0",
      }),
    ],
  });
  assert.deepEqual(validateManifestShape(manifest), []);
});
