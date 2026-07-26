#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ordered CI gate runner (CLAUDE.md: `pnpm gate`):
 *   codegen -> sdk-drift -> oasdiff -> depcruise -> runtime-imports
 *   -> license-check -> dep-audit -> lint -> typecheck -> test
 *   -> db:migrate-check -> grep-gates -> docs-build
 *
 * runtime-imports (Phase 4 Wave 3, lane STRUCT, STATE.md Phase 4 Open item
 * "Runtime-TS packaging defects (I2 findings)"): scripts/check-runtime-
 * imports.mjs — static package.json-shape check that every workspace
 * package apps/server + apps/worker actually import at runtime resolves
 * into dist/, never raw src/*.ts (the exact defect that made a production
 * `node dist/main.js` crash with ERR_MODULE_NOT_FOUND /
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING before this lane's fix).
 * Placed right after depcruise: both are structural checks over the
 * workspace package graph's shape, before the heavier lint/typecheck/test
 * steps — and both would otherwise stay silently green in dev (tsx/vitest
 * tolerate raw TS; only a real `node` boot doesn't).
 *
 * dep-audit (Phase 4 lane G1, STATE.md P4.15): `pnpm audit --prod --json`
 * gated against audit-allowlist.json — see scripts/dep-audit.mjs's own
 * header. Placed right after license-check: both are dependency-supply-
 * chain gates over the same resolved dependency graph, so a failure in
 * either reads as "the dependency tree itself has a problem" before any
 * source-code gate (lint/typecheck/test) even runs.
 *
 * docs-build (Addendum A, lane D1, STATE.md "## Addendum A" deliverable
 * 10): `node scripts/docs/build.mjs` — VitePress site build + the
 * `redocly build-docs` API reference, wired as the LAST gate step.
 * Deliberately last: it's cheapest to reach only once everything earlier
 * (codegen through grep-gates) has already confirmed the rest of the repo
 * is consistent, and a docs-only PR still gets full gate coverage before
 * this step runs. A broken docs build (bad Markdown link, VitePress config
 * error, the API reference generator failing) fails the gate here;
 * register-lint's own findings are warnings-only and never fail this step
 * (see scripts/docs/register-lint.mjs's header).
 *
 * Stops at the first failing step. Each step prints a clear PASS/FAIL line.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const steps = [
  { name: "codegen", run: runCodegen },
  { name: "sdk-drift", run: runSdkDrift },
  { name: "oasdiff", run: runOasdiff },
  { name: "depcruise", run: runDepcruise },
  { name: "runtime-imports", run: () => runCommand("node", ["scripts/check-runtime-imports.mjs"]) },
  { name: "license-check", run: runLicenseCheck },
  { name: "dep-audit", run: () => runCommand("node", ["scripts/dep-audit.mjs"]) },
  { name: "lint", run: () => runCommand("pnpm", ["run", "lint"]) },
  { name: "typecheck", run: () => runCommand("pnpm", ["run", "typecheck"]) },
  { name: "test", run: () => runCommand("pnpm", ["run", "test"]) },
  { name: "db:migrate-check", run: () => runCommand("pnpm", ["run", "db:migrate-check"]) },
  { name: "grep-gates", run: () => runCommand("node", ["scripts/grep-gates.mjs"]) },
  { name: "docs-build", run: () => runCommand("node", ["scripts/docs/build.mjs"]) },
];

// On Windows, pnpm/turbo are .cmd shims that Node cannot spawn without a
// shell (spawnSync ENOENT). Everywhere else a shell would mis-handle paths
// with spaces, so it stays off.
const WIN = process.platform === "win32";

function runCommand(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: WIN });
  if (result.error) {
    console.error(result.error.message);
    return false;
  }
  return result.status === 0;
}

function runCodegen() {
  return runCommand("pnpm", ["--filter", "@loombre/contract", "run", "codegen"]);
}

function runSdkDrift() {
  return runCommand("git", ["diff", "--exit-code", "--", "packages/sdk"]);
}

function commandExists(cmd) {
  const result = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: WIN });
  return !result.error && result.status === 0;
}

function runOasdiff() {
  const currentPath = "packages/contract/openapi.yaml";

  const baseline = spawnSync("git", ["show", "main:packages/contract/openapi.yaml"], {
    encoding: "utf8",
  });

  if (baseline.status !== 0) {
    console.log("oasdiff: no baseline on main — PASS with note");
    return true;
  }

  if (!commandExists("oasdiff")) {
    console.error(
      "oasdiff: FAIL — the `oasdiff` binary is not installed.\n" +
        "Install it with `brew install oasdiff`, or download a release from " +
        "https://github.com/oasdiff/oasdiff/releases and put it on PATH.",
    );
    return false;
  }

  if (!existsSync(currentPath)) {
    console.error(
      `oasdiff: FAIL — a baseline exists on main but ${currentPath} is missing on this branch.`,
    );
    return false;
  }

  const dir = mkdtempSync(join(tmpdir(), "loombre-oasdiff-"));
  const baselinePath = join(dir, "openapi.main.yaml");
  writeFileSync(baselinePath, baseline.stdout);

  const result = spawnSync("oasdiff", ["breaking", baselinePath, currentPath], {
    stdio: "inherit",
    shell: WIN,
  });

  rmSync(dir, { recursive: true, force: true });

  return result.status === 0;
}

function runDepcruise() {
  return runCommand("pnpm", [
    "exec",
    "depcruise",
    "--config",
    ".dependency-cruiser.cjs",
    "apps",
    "packages",
  ]);
}

function runLicenseCheck() {
  // scripts/license-check.mjs scans EVERY workspace root, not just the repo
  // root (Wave-3 AGPL finding: pnpm's isolated linker hides most prod deps
  // from a root-only scan). Replaces the old `pnpm run license-check`.
  return runCommand("node", ["scripts/license-check.mjs"]);
}

let failed = false;
for (const step of steps) {
  console.log(`\n=== gate: ${step.name} ===`);
  const ok = step.run();
  if (ok) {
    console.log(`[PASS] ${step.name}`);
  } else {
    console.log(`[FAIL] ${step.name}`);
    failed = true;
    break;
  }
}

if (failed) {
  console.error("\ngate: FAILED");
  process.exit(1);
}

console.log("\ngate: ALL STEPS PASSED");
process.exit(0);
