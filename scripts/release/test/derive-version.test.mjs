// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/derive-version.test.mjs
//
// Pure node:test coverage for scripts/release/lib/derive-version.mjs — no
// vitest workspace wiring, no new devDependency, no lockfile edit (this
// wave's release lane is barred from touching pnpm-lock.yaml, see the
// lane report). Run via `pnpm release:test` or `node --test
// scripts/release/test/`.

import test from "node:test";
import assert from "node:assert/strict";
import { assertValidSemver, deriveVersion, renderVersionFileSource } from "../lib/derive-version.mjs";

test("assertValidSemver accepts a plain pre-1.0 version", () => {
  assert.equal(assertValidSemver("0.9.0"), "0.9.0");
});

test("assertValidSemver accepts prerelease + build metadata", () => {
  assert.equal(assertValidSemver("1.2.3-rc.1+build.7"), "1.2.3-rc.1+build.7");
});

test("assertValidSemver rejects a malformed version", () => {
  assert.throws(() => assertValidSemver("v1.2"), /not a valid semver/);
  assert.throws(() => assertValidSemver("1.2.3.4"), /not a valid semver/);
  assert.throws(() => assertValidSemver(""), /not a valid semver/);
});

test("deriveVersion dev mode appends -dev+<shorthash>", () => {
  const derived = deriveVersion({ baseVersion: "0.9.0", mode: "dev", gitShortHash: "abc1234" });
  assert.equal(derived.version, "0.9.0");
  assert.equal(derived.buildMode, "dev");
  assert.equal(derived.gitShortHash, "abc1234");
  assert.equal(derived.versionFull, "0.9.0-dev+abc1234");
});

test("deriveVersion dev mode falls back to 'unknown' hash when git metadata is absent", () => {
  const derived = deriveVersion({ baseVersion: "0.9.0", mode: "dev", gitShortHash: null });
  assert.equal(derived.gitShortHash, null);
  assert.equal(derived.versionFull, "0.9.0-dev+unknown");
});

test("deriveVersion dev mode rejects a malformed shorthash rather than baking it in", () => {
  const derived = deriveVersion({ baseVersion: "0.9.0", mode: "dev", gitShortHash: "not a hash!" });
  assert.equal(derived.gitShortHash, null);
  assert.equal(derived.versionFull, "0.9.0-dev+unknown");
});

test("deriveVersion release mode is the clean semver with no suffix, ignoring any shorthash", () => {
  const derived = deriveVersion({ baseVersion: "0.9.0", mode: "release", gitShortHash: "abc1234" });
  assert.equal(derived.buildMode, "release");
  assert.equal(derived.gitShortHash, null);
  assert.equal(derived.versionFull, "0.9.0");
});

test("deriveVersion rejects an unknown mode", () => {
  assert.throws(() => deriveVersion({ baseVersion: "0.9.0", mode: "prod" }), /unknown build mode/);
});

test("deriveVersion propagates a bad base version as a validation error", () => {
  assert.throws(() => deriveVersion({ baseVersion: "not-semver", mode: "dev" }), /not a valid semver/);
});

test("renderVersionFileSource produces a GENERATED banner and the four expected exports (dev)", () => {
  const derived = deriveVersion({ baseVersion: "0.9.0", mode: "dev", gitShortHash: "abc1234" });
  const source = renderVersionFileSource(derived);
  assert.match(source, /^\/\/ GENERATED — do not edit/);
  assert.match(source, /export const LOOMBRE_VERSION = "0\.9\.0";/);
  assert.match(source, /export const LOOMBRE_BUILD_MODE: "dev" \| "release" = "dev";/);
  assert.match(source, /export const LOOMBRE_GIT_SHORTHASH: string \| null = "abc1234";/);
  assert.match(source, /export const LOOMBRE_VERSION_FULL = "0\.9\.0-dev\+abc1234";/);
});

test("renderVersionFileSource null-hash renders a literal `null`, not the string \"null\" (release mode)", () => {
  const derived = deriveVersion({ baseVersion: "1.0.0", mode: "release" });
  const source = renderVersionFileSource(derived);
  assert.match(source, /export const LOOMBRE_GIT_SHORTHASH: string \| null = null;/);
  assert.match(source, /export const LOOMBRE_VERSION_FULL = "1\.0\.0";/);
});

test("renderVersionFileSource output is valid, parseable TypeScript-shaped source (no unbalanced quotes)", () => {
  const derived = deriveVersion({ baseVersion: "0.9.0", mode: "dev", gitShortHash: "deadbeef" });
  const source = renderVersionFileSource(derived);
  // Every exported const line ends with a semicolon and the file has no
  // stray template artefacts left over from string interpolation.
  const exportLines = source.split("\n").filter((line) => line.startsWith("export const"));
  assert.equal(exportLines.length, 4);
  for (const line of exportLines) {
    assert.ok(line.endsWith(";"), `expected line to end with ';': ${line}`);
  }
});
