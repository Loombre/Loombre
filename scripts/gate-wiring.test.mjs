// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/gate-wiring.test.mjs
//
// d4-i6 (QA backlog #119). `pnpm gate`'s `test` step is `turbo run test`,
// which walks the pnpm WORKSPACE graph — so a test tree that is not a
// workspace is invisible to it, and stays invisible no matter how many
// suites grow there. Two such trees exist:
//
//   installers/  — caught once already (AUD-A5b-001's x64 Distribution.xml
//                  fix shipped with its regression test running in no
//                  runner at all), which is why the `installers-test` gate
//                  step exists.
//   scripts/     — the same shape, unnoticed for longer: 165 tests
//                  (fetch-ffmpeg, fetch-embedded-pg, dep-audit, all of
//                  scripts/release/test, docs-drift, this file) that only
//                  .github/workflows/ci.yml ran. The doc-drift gate and
//                  every release-tooling regression were invisible to the
//                  local inner loop, which is exactly where they are
//                  cheapest to catch.
//
// This file is the standing guard: a tree outside the workspace graph must
// have BOTH a root script and a gate step, or it silently has no local
// coverage. Adding a third such tree means adding a row below, a root
// script, and a gate step — in the same change.
//
// Run directly with: node --test scripts/gate-wiring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const OUT_OF_WORKSPACE_SUITES = [
  { tree: "installers/", script: "installers:test", step: "installers-test" },
  { tree: "scripts/", script: "scripts:test", step: "scripts-test" },
];

/** scripts/gate.mjs's fast-step array — the same parse docs-drift.test.mjs
 *  uses, kept local so neither file imports the other. */
function fastStepsBlock() {
  const src = read("scripts/gate.mjs");
  const block = /const steps = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, "scripts/gate.mjs: could not find the `const steps = [ ... ];` array");
  return block[1];
}

test("every test tree outside the pnpm workspace graph has a root script", () => {
  const { scripts } = JSON.parse(read("package.json"));
  for (const { tree, script } of OUT_OF_WORKSPACE_SUITES) {
    assert.ok(
      typeof scripts[script] === "string" && scripts[script].length > 0,
      `package.json: no "${script}" script — nothing runs ${tree}'s tests at all`,
    );
  }
});

test("...and a scripts/gate.mjs step that runs it, since `turbo run test` cannot", () => {
  const steps = fastStepsBlock();
  for (const { tree, script, step } of OUT_OF_WORKSPACE_SUITES) {
    assert.match(
      steps,
      new RegExp(`name: "${step}"`),
      `scripts/gate.mjs: no "${step}" step — ${tree} is not a pnpm workspace, so the gate's ` +
        "`test` step (turbo) never reaches it and `pnpm gate` would not run its suite",
    );
    assert.match(
      steps,
      new RegExp(`"${script}"`),
      `scripts/gate.mjs: the "${step}" step does not invoke "${script}"`,
    );
  }
});
