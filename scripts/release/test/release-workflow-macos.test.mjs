// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/release-workflow-macos.test.mjs
//
// Shape guard for .github/workflows/release.yml's build-macos job. The
// macOS .pkg bundles arch-specific binaries (Node, ffmpeg/ffprobe,
// embedded PostgreSQL, the wg-native dylib, the Swift menubar app), so an
// Intel Mac needs its own x64 .pkg built on an Intel runner — the release
// job must fan out over both arches, and nothing in the job body may
// hard-code one of them (that is exactly how the x64 leg was missing
// through v0.9.0-rc.11 while the build script already supported it).
// Text-level assertions on purpose: node-builtins-only, no YAML parser
// dependency, same as every other script under scripts/release/.
// Run via `pnpm scripts:test` or `node --test scripts/release/test/`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const WORKFLOW = readFileSync(
  path.join(REPO_ROOT, ".github/workflows/release.yml"),
  "utf8",
);

/** Text of one top-level job (2-space indent under `jobs:`), up to the next job key. */
function jobBlock(jobId) {
  // Terminates at the next 2-space job key OR end of file (`release` is last).
  const re = new RegExp(
    `^  ${jobId}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:[ \\t]*$|$(?![\\s\\S]))`,
    "m",
  );
  const match = re.exec(WORKFLOW);
  assert.ok(match, `release.yml has no top-level job "${jobId}"`);
  return match[1];
}

const buildMacos = jobBlock("build-macos");
const release = jobBlock("release");

test("build-macos fans out over arm64 AND x64 via a matrix", () => {
  assert.match(
    buildMacos,
    /^\s+strategy:\s*$/m,
    "build-macos must declare a strategy/matrix",
  );
  assert.match(
    buildMacos,
    /arch:\s*arm64\b/,
    "matrix must include the arm64 leg",
  );
  assert.match(
    buildMacos,
    /arch:\s*x64\b/,
    "matrix must include the x64 (Intel) leg",
  );
  assert.match(
    buildMacos,
    /runs-on:\s*\$\{\{\s*matrix\.runner\s*\}\}/,
    "runs-on must come from the matrix",
  );
});

test("the x64 leg runs on GitHub's Intel image (macos-15-intel, the last x86_64 image — retires August 2027)", () => {
  assert.match(buildMacos, /macos-15-intel/);
});

test("a failing Intel leg must not cancel the arm64 build (fail-fast off)", () => {
  assert.match(buildMacos, /fail-fast:\s*false/);
});

test("no step hard-codes a single arch — every pkg reference and --arch flag comes from the matrix", () => {
  assert.doesNotMatch(
    buildMacos,
    /--arch=(arm64|x64)\b/,
    "build-pkg.mjs --arch must be matrix-driven",
  );
  assert.doesNotMatch(
    buildMacos,
    /macos-(arm64|x64)\.pkg/,
    "staged/smoked .pkg filename must be matrix-driven",
  );
  assert.doesNotMatch(
    buildMacos,
    /release-artifacts-macos\s*$/m,
    "upload-artifact name must be per-arch or the two legs collide",
  );
  assert.match(
    buildMacos,
    /release-artifacts-macos-\$\{\{\s*matrix\.arch\s*\}\}/,
    "upload-artifact name must carry matrix.arch",
  );
});

test("each leg proves its runner's CPU matches its arch before building (host-arch swift/go outputs + --arch payload must agree)", () => {
  // `swift build` and `go build -buildmode=c-shared` emit HOST-arch
  // binaries while --arch picks the Node/ffmpeg/PG payload; a runner
  // label silently repointed to the other arch would ship a mixed .pkg.
  assert.match(buildMacos, /uname -m/);
});

test("the release job still gathers every per-arch macOS artifact", () => {
  assert.match(
    release,
    /needs:\s*\[[^\]]*\bbuild-macos\b[^\]]*\]/,
    "release must depend on build-macos",
  );
  assert.match(
    release,
    /pattern:\s*release-artifacts-\*/,
    "download pattern must match the per-arch artifact names",
  );
  assert.match(
    release,
    /merge-multiple:\s*true/,
    "per-arch artifacts must merge into one dist/release",
  );
});
