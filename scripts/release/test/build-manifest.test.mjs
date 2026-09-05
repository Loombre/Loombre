// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/build-manifest.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManifest,
  buildDockerArtifacts,
  DOCKER_SIDECAR_FILES,
  inferPlatformAndKind,
  validateManifestShape,
} from "../lib/build-manifest-lib.mjs";

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
  // The Burn bootstrapper ships ALONGSIDE the msi and must land in the
  // signed manifest as its own kind — rc.2 published it in SHA256SUMS but
  // not in manifest.json, because this mapping did not exist.
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-windows-x64.exe"), { platform: "windows-x64", kind: "bundle" });
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-rc.2-windows-x64.exe"), {
    platform: "windows-x64",
    kind: "bundle",
  });
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-macos-arm64.pkg"), { platform: "macos-arm64", kind: "pkg" });
  assert.deepEqual(inferPlatformAndKind("loombre-0.9.0-macos-x64.pkg"), { platform: "macos-x64", kind: "pkg" });
  // The two Linux native-package channels (installers/linux/build-rpm.mjs /
  // build-deb.mjs), alongside the pre-existing "tarball" kind for the same
  // platforms.
  assert.deepEqual(inferPlatformAndKind("loombre-1.0.0-beta.1-linux-x64.rpm"), { platform: "linux-x64", kind: "rpm" });
  assert.deepEqual(inferPlatformAndKind("loombre-1.0.0-beta.1-linux-arm64.deb"), { platform: "linux-arm64", kind: "deb" });
  assert.deepEqual(inferPlatformAndKind("loombre-1.0.0-linux-x64.deb"), { platform: "linux-x64", kind: "deb" });
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
  // NOTE: this used to assert on a linux .exe as the "unknown extension"
  // case. `.exe` is now a recognized artifact type (the Windows Burn
  // bootstrapper), so the example moved to an extension we genuinely do
  // not publish. The linux/.exe pairing being nonsensical is NOT what this
  // function rejects — it maps platform and extension independently, the
  // same way it does not reject a macOS .msi. `.deb` (this example's
  // original extension) is ITSELF now a recognized kind (the Linux
  // native-package channel, installers/linux/build-deb.mjs), so the
  // example moved again to an extension we genuinely do not publish.
  assert.equal(inferPlatformAndKind("loombre-0.9.0-linux-x64.zip"), null); // unknown extension
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

// AUD-A5c-001: the web Docker image was never read into the manifest at
// all — build-manifest.mjs's old collectDockerArtifact (singular) only
// ever looked at docker-image.json. These tests exercise the shared,
// pure shaping logic both sidecars now go through; see
// build-manifest-cli.test.mjs for the real-fs test that proves the CLI
// wrapper actually calls it for BOTH sidecar files (a pure-lib-only test
// here would not catch a wrapper that forgot to wire the web sidecar in).

test("DOCKER_SIDECAR_FILES: covers both the server and web image sidecars", () => {
  assert.deepEqual(DOCKER_SIDECAR_FILES, ["docker-image.json", "docker-web-image.json"]);
});

test("buildDockerArtifacts: folds the web image in with its OWN digest, not the server's", () => {
  const serverSidecar = {
    filename: "ghcr.io/loombre/loombre:0.9.0",
    sizeBytes: 0,
    sha256: "a".repeat(64),
    url: "https://ghcr.io/loombre/loombre:0.9.0",
  };
  const webSidecar = {
    filename: "ghcr.io/loombre/loombre-web:0.9.0",
    sizeBytes: 0,
    sha256: "b".repeat(64),
    url: "https://ghcr.io/loombre/loombre-web:0.9.0",
  };
  const artifacts = buildDockerArtifacts({
    "docker-image.json": serverSidecar,
    "docker-web-image.json": webSidecar,
  });
  assert.equal(artifacts.length, 2);
  const webArtifact = artifacts.find((a) => a.filename === webSidecar.filename);
  assert.ok(webArtifact, "web image artifact must be present");
  assert.equal(webArtifact.platform, "docker");
  assert.equal(webArtifact.kind, "docker-image");
  assert.equal(webArtifact.sha256, webSidecar.sha256);
  assert.notEqual(webArtifact.sha256, serverSidecar.sha256); // guards a copy/paste digest swap
  assert.equal(webArtifact.url, webSidecar.url);
});

test("buildDockerArtifacts: omits a sidecar that was not present (e.g. a dev build with only the server image)", () => {
  const artifacts = buildDockerArtifacts({
    "docker-image.json": {
      filename: "ghcr.io/loombre/loombre:0.9.0",
      sizeBytes: 0,
      sha256: "a".repeat(64),
      url: "https://ghcr.io/loombre/loombre:0.9.0",
    },
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].filename, "ghcr.io/loombre/loombre:0.9.0");
});

test("buildManifest: a manifest built with both docker sidecars lists the web image with a correct digest — not just parses", () => {
  const manifest = buildManifest({
    version: "0.9.0",
    releasedAtMs: 1,
    notesUrl: "https://example.invalid/x",
    artifacts: [
      goodArtifact(),
      ...buildDockerArtifacts({
        "docker-image.json": {
          filename: "ghcr.io/loombre/loombre:0.9.0",
          sizeBytes: 0,
          sha256: "c".repeat(64),
          url: "https://ghcr.io/loombre/loombre:0.9.0",
        },
        "docker-web-image.json": {
          filename: "ghcr.io/loombre/loombre-web:0.9.0",
          sizeBytes: 0,
          sha256: "d".repeat(64),
          url: "https://ghcr.io/loombre/loombre-web:0.9.0",
        },
      }),
    ],
  });
  const webEntry = manifest.releases[0].artifacts.find((a) => a.filename === "ghcr.io/loombre/loombre-web:0.9.0");
  assert.ok(webEntry, "manifest.json must list the web Docker image, not just the server image");
  assert.equal(webEntry.sha256, "d".repeat(64));
  assert.deepEqual(validateManifestShape(manifest), []);
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
