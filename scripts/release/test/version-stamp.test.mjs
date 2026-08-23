// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/test/version-stamp.test.mjs
//
// Regression cover for QA report browser-admin-F8 — "three different
// version strings visible at once". packages/shared/src/version.ts is a
// committed GENERATED file; nothing re-stamped it across seven release-
// candidate bumps, so root package.json said 0.9.0-rc.7 while the stamp
// still said 0.9.0 and the admin surfaces (sidebar / dashboard header /
// Updates card / Server info / /settings/about) disagreed on screen.
//
// Two layers, mirroring pubkey-consistency.test.mjs's conventions
// (node:test, in-memory fixtures, no new devDependency):
//   1. in-memory unit cases over lib/version-stamp.mjs's pure check;
//   2. the REPO cases — the real package.json + the real version.ts, and
//      the real `stamp-version --check` CLI. These are the ones that were
//      RED before the re-stamp, and the ones that go red again the next
//      time someone bumps the version without running `pnpm stamp-version`
//      (which is also what scripts/gate.mjs's `version-stamp` step runs).
//
// Run via `pnpm scripts:test`, `pnpm release:test`, or
// `node --test scripts/release/test/version-stamp.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWNER_ACTION,
  STAMP_PATH,
  checkVersionStampDrift,
  parseVersionStamp,
} from "../lib/version-stamp.mjs";
import { deriveVersion, renderVersionFileSource } from "../lib/derive-version.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

/** A stamp exactly as `pnpm stamp-version` would render it. */
function stampFor(baseVersion, mode = "dev", gitShortHash = "abc12345") {
  return renderVersionFileSource(deriveVersion({ baseVersion, mode, gitShortHash }));
}

// ---------------------------------------------------------------- parsing

test("parseVersionStamp reads the four constants back out of a dev stamp", () => {
  const parsed = parseVersionStamp(stampFor("1.2.3"));
  assert.deepEqual(parsed, {
    version: "1.2.3",
    buildMode: "dev",
    gitShortHash: "abc12345",
    versionFull: "1.2.3-dev+abc12345",
  });
});

test("parseVersionStamp reads a release stamp (null short-hash, no suffix)", () => {
  const parsed = parseVersionStamp(stampFor("1.2.3", "release"));
  assert.deepEqual(parsed, {
    version: "1.2.3",
    buildMode: "release",
    gitShortHash: null,
    versionFull: "1.2.3",
  });
});

test("parseVersionStamp rejects a file missing a constant", () => {
  const gutted = stampFor("1.2.3").replace(/^export const LOOMBRE_VERSION_FULL.*$/m, "");
  assert.throws(() => parseVersionStamp(gutted), /LOOMBRE_VERSION_FULL/);
});

test("parseVersionStamp rejects an empty/missing file", () => {
  assert.throws(() => parseVersionStamp(""), /missing or empty/);
  assert.throws(() => parseVersionStamp(undefined), /missing or empty/);
});

// ------------------------------------------------------------ drift check

test("checkVersionStampDrift passes when the stamp matches package.json", () => {
  const verdict = checkVersionStampDrift({ baseVersion: "1.2.3", stampSource: stampFor("1.2.3") });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
});

test("checkVersionStampDrift FAILS on the browser-admin-F8 shape: bumped package.json, un-stamped version.ts", () => {
  const verdict = checkVersionStampDrift({
    baseVersion: "0.9.0-rc.7",
    stampSource: stampFor("0.9.0", "dev", "34979cb6"),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems.length, 1);
  const [problem] = verdict.problems;
  assert.equal(problem.type, "drift");
  assert.match(problem.message, /"0\.9\.0"/);
  assert.match(problem.message, /"0\.9\.0-rc\.7"/);
  assert.match(problem.message, /pnpm stamp-version/);
});

test("checkVersionStampDrift tolerates a STALE short-hash — provenance, not identity", () => {
  // A dev stamp always names the commit BEFORE the one carrying it; gating
  // on freshness would fail the gate on every commit.
  const verdict = checkVersionStampDrift({
    baseVersion: "1.2.3",
    stampSource: stampFor("1.2.3", "dev", "0000dead"),
  });
  assert.equal(verdict.ok, true);
});

test("checkVersionStampDrift accepts a release-mode stamp of the same version", () => {
  const verdict = checkVersionStampDrift({
    baseVersion: "1.2.3",
    stampSource: stampFor("1.2.3", "release"),
  });
  assert.equal(verdict.ok, true);
});

test("checkVersionStampDrift catches a hand-edited LOOMBRE_VERSION_FULL", () => {
  const tampered = stampFor("1.2.3").replace('"1.2.3-dev+abc12345"', '"9.9.9-dev+abc12345"');
  const verdict = checkVersionStampDrift({ baseVersion: "1.2.3", stampSource: tampered });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems[0].type, "inconsistent");
  assert.match(verdict.problems[0].message, /LOOMBRE_VERSION_FULL/);
});

test("checkVersionStampDrift catches a release stamp that kept a short-hash", () => {
  const tampered = stampFor("1.2.3", "release").replace(
    "export const LOOMBRE_GIT_SHORTHASH: string | null = null;",
    'export const LOOMBRE_GIT_SHORTHASH: string | null = "abc12345";',
  );
  const verdict = checkVersionStampDrift({ baseVersion: "1.2.3", stampSource: tampered });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems[0].type, "inconsistent");
  assert.match(verdict.problems[0].message, /LOOMBRE_GIT_SHORTHASH/);
});

test("checkVersionStampDrift reports a structural problem instead of throwing", () => {
  const missing = checkVersionStampDrift({ baseVersion: "1.2.3", stampSource: undefined });
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].type, "structural");

  const badSource = checkVersionStampDrift({ baseVersion: 42, stampSource: stampFor("1.2.3") });
  assert.equal(badSource.ok, false);
  assert.equal(badSource.problems[0].type, "structural");
  assert.match(badSource.problems[0].message, /package\.json/);
});

test("OWNER_ACTION names the command a human must run", () => {
  assert.match(OWNER_ACTION, /pnpm stamp-version/);
  assert.match(STAMP_PATH, /^packages\/shared\/src\/version\.ts$/);
});

// -------------------------------------------------------------- this repo

test("REPO: packages/shared/src/version.ts is stamped from the current package.json version", () => {
  const baseVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
  const stampSource = readFileSync(path.join(REPO_ROOT, STAMP_PATH), "utf8");
  const verdict = checkVersionStampDrift({ baseVersion, stampSource });
  assert.equal(
    verdict.ok,
    true,
    `version stamp drift:\n${verdict.problems.map((p) => `[${p.type}] ${p.message}`).join("\n")}`,
  );
});

test("REPO: `stamp-version --check` exits 0 on this tree (scripts/gate.mjs's version-stamp step)", () => {
  const result = spawnSync(process.execPath, ["scripts/release/stamp-version.mjs", "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /stamp-version --check: PASS/);
});

test("REPO: `stamp-version --check` rejects an unknown flag without writing", () => {
  const result = spawnSync(process.execPath, ["scripts/release/stamp-version.mjs", "--nope"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument/);
});
