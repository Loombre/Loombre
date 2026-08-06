// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/sha256sums.test.mjs
//
// AUD-A5c-002: docker-web-image.json is a build INPUT (see
// build-manifest.mjs's header), not a release artifact — it must never be
// checksummed into the signed SHA256SUMS the way a real download is.
// docker-image.json already got this treatment (EXCLUDED_FILES);
// docker-web-image.json did not, so it was checksummed AND (separately,
// via release.yml's `dist/release/*` asset glob) published as a literal
// GitHub Release download.
//
// Run via `pnpm release:test` or `node --test scripts/release/test/`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXCLUDED_FILES, main } from "../sha256sums.mjs";

test("EXCLUDED_FILES excludes both Docker image sidecars, not just the server one", () => {
  assert.ok(EXCLUDED_FILES.has("docker-image.json"));
  assert.ok(EXCLUDED_FILES.has("docker-web-image.json"));
});

test("main: SHA256SUMS output covers real artifacts but never docker-image.json or docker-web-image.json", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loombre-sha256sums-test-"));
  const outPath = path.join(dir, "SHA256SUMS");
  const originalArgv = process.argv;
  try {
    writeFileSync(path.join(dir, "loombre-0.9.0-linux-x64.tar.gz"), "fake tarball bytes");
    writeFileSync(
      path.join(dir, "docker-image.json"),
      JSON.stringify({ filename: "x", sizeBytes: 0, sha256: "1".repeat(64), url: "x" }),
    );
    writeFileSync(
      path.join(dir, "docker-web-image.json"),
      JSON.stringify({ filename: "y", sizeBytes: 0, sha256: "2".repeat(64), url: "y" }),
    );

    process.argv = [originalArgv[0], originalArgv[1], "--artifacts-dir", dir, "--out", outPath];
    main();

    const sums = readFileSync(outPath, "utf8");
    assert.match(sums, /loombre-0\.9\.0-linux-x64\.tar\.gz/);
    assert.doesNotMatch(sums, /docker-image\.json/);
    assert.doesNotMatch(sums, /docker-web-image\.json/);
  } finally {
    process.argv = originalArgv;
    rmSync(dir, { recursive: true, force: true });
  }
});
