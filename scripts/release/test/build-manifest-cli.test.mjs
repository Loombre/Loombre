// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/build-manifest-cli.test.mjs
//
// Real-fs coverage for scripts/release/build-manifest.mjs's fs-touching
// collection functions (collectFileArtifacts, collectDockerArtifacts,
// deleteConsumedDockerSidecars) — the pure lib tests in
// build-manifest.test.mjs can't reach these, because
// build-manifest-lib.mjs's buildDockerArtifacts takes already-parsed
// sidecar JSON and never touches disk.
//
// AUD-A5c-001: the actual regression was that build-manifest.mjs's CLI
// wrapper never READ docker-web-image.json in the first place (its old
// collectDockerArtifact, singular, was hardcoded to "docker-image.json").
// A lib-only test proving buildDockerArtifacts shapes a web sidecar
// correctly would NOT have caught that, since it never exercises the
// wrapper that decides which sidecar files to read. This file does.
//
// AUD-A5c-002: also proves both sidecars are deleted from --artifacts-dir
// once deleteConsumedDockerSidecars is called, so neither can leak into
// release.yml's later `gh release create ... dist/release/*` asset glob —
// that is how this wave resolves "checksummed into SHA256SUMS AND
// published as a literal download": both sidecars are consistently
// treated as build inputs, consumed and removed by the one script that
// reads them.
//
// collectDockerArtifacts/deleteConsumedDockerSidecars are two functions,
// not one, because folding the delete into the read made
// collectDockerArtifacts non-idempotent: a run that failed anywhere
// between reading the sidecar and writing manifest.json would have
// already deleted it, so a retry silently produced a manifest missing the
// Docker images. The "leaves the sidecars intact for a retry" tests below
// cover that.
//
// Run via `pnpm release:test` or `node --test scripts/release/test/`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectFileArtifacts, collectDockerArtifacts, deleteConsumedDockerSidecars } from "../build-manifest.mjs";

function makeArtifactsDir() {
  return mkdtempSync(path.join(tmpdir(), "loombre-build-manifest-test-"));
}

function writeSidecar(dir, filename, sidecar) {
  writeFileSync(path.join(dir, filename), `${JSON.stringify(sidecar, null, 2)}\n`);
}

test("collectDockerArtifacts: includes the web image with its own digest when both sidecars are present", () => {
  const dir = makeArtifactsDir();
  try {
    const serverSidecar = {
      filename: "ghcr.io/loombre/loombre:0.9.0",
      sizeBytes: 0,
      sha256: "1".repeat(64),
      url: "https://ghcr.io/loombre/loombre:0.9.0",
    };
    const webSidecar = {
      filename: "ghcr.io/loombre/loombre-web:0.9.0",
      sizeBytes: 0,
      sha256: "2".repeat(64),
      url: "https://ghcr.io/loombre/loombre-web:0.9.0",
    };
    writeSidecar(dir, "docker-image.json", serverSidecar);
    writeSidecar(dir, "docker-web-image.json", webSidecar);

    const { artifacts, consumedFiles } = collectDockerArtifacts(dir);

    // The exact AUD-A5c-001 assertion: a test that only checked "the
    // manifest parses" would pass even under the old collectDockerArtifact
    // (singular), which never read docker-web-image.json at all and would
    // silently return just the server artifact here.
    assert.equal(artifacts.length, 2, "both the server and web Docker images must be collected");
    const webArtifact = artifacts.find((a) => a.filename === webSidecar.filename);
    assert.ok(webArtifact, "web image artifact is missing from the collected artifacts");
    assert.equal(webArtifact.sha256, webSidecar.sha256, "web image digest must be its OWN sidecar's digest");
    assert.notEqual(webArtifact.sha256, serverSidecar.sha256);
    assert.equal(webArtifact.platform, "docker");
    assert.equal(webArtifact.kind, "docker-image");
    assert.equal(webArtifact.url, webSidecar.url);
    assert.deepEqual(consumedFiles.slice().sort(), ["docker-image.json", "docker-web-image.json"]);
    // collectDockerArtifacts by itself must NOT delete anything — see the
    // idempotency tests below.
    assert.equal(existsSync(path.join(dir, "docker-image.json")), true);
    assert.equal(existsSync(path.join(dir, "docker-web-image.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteConsumedDockerSidecars: AUD-A5c-002 — removes both sidecars from --artifacts-dir once the manifest that folded them in is written (neither is a release asset)", () => {
  const dir = makeArtifactsDir();
  try {
    writeSidecar(dir, "docker-image.json", {
      filename: "ghcr.io/loombre/loombre:0.9.0",
      sizeBytes: 0,
      sha256: "3".repeat(64),
      url: "https://ghcr.io/loombre/loombre:0.9.0",
    });
    writeSidecar(dir, "docker-web-image.json", {
      filename: "ghcr.io/loombre/loombre-web:0.9.0",
      sizeBytes: 0,
      sha256: "4".repeat(64),
      url: "https://ghcr.io/loombre/loombre-web:0.9.0",
    });

    const { consumedFiles } = collectDockerArtifacts(dir);
    deleteConsumedDockerSidecars(dir, consumedFiles);

    // If either file were still here, release.yml's `gh release create
    // ... dist/release/*` glob would publish it as a literal download
    // asset — the AUD-A5c-002 defect. docker-web-image.json used to
    // survive to that point; docker-image.json only didn't because of a
    // separate, easy-to-forget `rm -f` step in release.yml.
    assert.equal(existsSync(path.join(dir, "docker-image.json")), false);
    assert.equal(existsSync(path.join(dir, "docker-web-image.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectDockerArtifacts: tolerates a dev build with only the server image sidecar present", () => {
  const dir = makeArtifactsDir();
  try {
    writeSidecar(dir, "docker-image.json", {
      filename: "ghcr.io/loombre/loombre:0.9.0",
      sizeBytes: 0,
      sha256: "5".repeat(64),
      url: "https://ghcr.io/loombre/loombre:0.9.0",
    });
    const { artifacts, consumedFiles } = collectDockerArtifacts(dir);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].filename, "ghcr.io/loombre/loombre:0.9.0");
    assert.deepEqual(consumedFiles, ["docker-image.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The second item from the opus review of this wave: collectDockerArtifacts
// used to unlinkSync each sidecar the instant it read it, so ANY failure
// between that read and main()'s writeFileSync (a schema-validation error,
// an unrecognized file elsewhere in --artifacts-dir throwing first, a
// disk-full write) left the sidecar already deleted with no manifest ever
// written. A retry against that same --artifacts-dir would then silently
// produce a manifest with no Docker artifacts at all — the same
// silent-omission class as AUD-A5c-001, just reached a different way.
// Splitting collection (read-only) from deleteConsumedDockerSidecars
// (called only after a confirmed-successful write, see build-manifest.mjs's
// main()) closes that gap: a run that never reaches the write step leaves
// the sidecars untouched for the retry.

test("collectDockerArtifacts: is idempotent on its own — a second call before any delete finds the SAME sidecars and returns the SAME artifacts (simulates a retry after a run that failed before writing manifest.json)", () => {
  const dir = makeArtifactsDir();
  try {
    writeSidecar(dir, "docker-image.json", {
      filename: "ghcr.io/loombre/loombre:0.9.0",
      sizeBytes: 0,
      sha256: "8".repeat(64),
      url: "https://ghcr.io/loombre/loombre:0.9.0",
    });
    writeSidecar(dir, "docker-web-image.json", {
      filename: "ghcr.io/loombre/loombre-web:0.9.0",
      sizeBytes: 0,
      sha256: "9".repeat(64),
      url: "https://ghcr.io/loombre/loombre-web:0.9.0",
    });

    // Run 1: collects, but the caller (standing in for a main() that then
    // hit a validation error or a write failure) never calls
    // deleteConsumedDockerSidecars.
    const first = collectDockerArtifacts(dir);
    assert.equal(first.artifacts.length, 2);
    assert.equal(existsSync(path.join(dir, "docker-image.json")), true, "a run that never wrote the manifest must not have consumed the sidecar");
    assert.equal(existsSync(path.join(dir, "docker-web-image.json")), true);

    // Run 2 (the retry): the directory is untouched, so it must produce
    // the identical result — under the old eager-delete behavior this
    // second call would have returned an EMPTY artifacts array with no
    // error, because run 1 would already have deleted both sidecars.
    const second = collectDockerArtifacts(dir);
    assert.deepEqual(second.artifacts, first.artifacts);
    assert.deepEqual(second.consumedFiles.slice().sort(), ["docker-image.json", "docker-web-image.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteConsumedDockerSidecars: only removes what collectDockerArtifacts actually reported as consumed — a dev build with just the server sidecar leaves nothing else to fail deleting", () => {
  const dir = makeArtifactsDir();
  try {
    writeSidecar(dir, "docker-image.json", {
      filename: "ghcr.io/loombre/loombre:0.9.0",
      sizeBytes: 0,
      sha256: "e".repeat(64),
      url: "https://ghcr.io/loombre/loombre:0.9.0",
    });
    const { consumedFiles } = collectDockerArtifacts(dir);
    assert.doesNotThrow(() => deleteConsumedDockerSidecars(dir, consumedFiles));
    assert.equal(existsSync(path.join(dir, "docker-image.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectFileArtifacts: still skips both docker sidecars as non-artifact files (unaffected by the fix)", () => {
  const dir = makeArtifactsDir();
  try {
    writeFileSync(path.join(dir, "loombre-0.9.0-linux-x64.tar.gz"), "fake tarball bytes");
    writeSidecar(dir, "docker-image.json", { filename: "x", sizeBytes: 0, sha256: "6".repeat(64), url: "x" });
    writeSidecar(dir, "docker-web-image.json", { filename: "y", sizeBytes: 0, sha256: "7".repeat(64), url: "y" });

    const artifacts = collectFileArtifacts(dir, "https://example.invalid/download");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].filename, "loombre-0.9.0-linux-x64.tar.gz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
