#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ordered CI gate runner (CLAUDE.md: `pnpm gate` / `pnpm gate:full`):
 *   codegen -> sdk-drift -> version-stamp -> oasdiff -> depcruise
 *   -> runtime-imports -> license-check -> go-licenses-check -> dep-audit
 *   -> lint -> typecheck -> test -> installers-test -> scripts-test
 *   -> db:migrate-check -> grep-gates -> docs-build
 *   -> [gate:full only] web-build-budget
 *
 * Modes (L4, STATE.md ledger item "consider adding the web production
 * build ... to `pnpm gate`" — closed by adding a mode instead of changing
 * the default):
 *   `node scripts/gate.mjs`      (no arg — FAST, the CLAUDE.md inner-loop
 *     default): the 17 steps above, unchanged behavior and unchanged speed.
 *     Full mode APPENDS to the `steps` array below rather than editing it
 *     in place, specifically so a reviewer can diff the array itself and
 *     see no step was silently lost or reordered. The array is the truth,
 *     and every count/chain restatement of it — this header's included —
 *     is pinned against it by scripts/docs-drift.test.mjs, so an added or
 *     reordered step fails the gate until the prose catches up. Spell each
 *     count as "N steps" so that check keeps seeing it.
 *   `node scripts/gate.mjs full` (FULL — what CI's `pnpm gate:full` runs,
 *     and what CLAUDE.md's working agreements call for before any
 *     push/PR): the same 17 steps, plus a final `web-build-budget`
 *     (`pnpm run perf:web-budget`) — builds apps/web's workspace
 *     dependency closure, builds apps/web itself for production, boots it,
 *     and asserts the /browse route's first-load JS gzip size against the
 *     docs/PLAN.md §9.3 budget. That budget threshold is hardcoded in
 *     perf-web-budget.mjs itself; perf/baselines.json is a separate,
 *     hand-curated ledger documenting that budget's history (not read by
 *     the script — see scripts/perf-baseline-check.mjs). This is the only
 *     LOCAL path that catches a production-build-only failure class —
 *     e.g. a barrel import pulling a `node:`-scheme module into the client
 *     graph, which fails webpack with UnhandledSchemeError naming the
 *     offending module — that fast gate and `pnpm test` cannot see (the
 *     real regression this closes: STATE.md's 2026-07-26 entry, the
 *     AccountSection `@loombre/shared` barrel/language-codes defect,
 *     8f11000).
 *   Any other argument is a usage error: prints usage to stderr, exits 1,
 *     runs nothing.
 *
 * version-stamp (QA report browser-admin-F8): `node scripts/release/
 * stamp-version.mjs --check` — packages/shared/src/version.ts is a
 * COMMITTED GENERATED file (STATE.md P4.11 single-source stamping), and
 * nothing re-stamped it across seven release-candidate bumps of root
 * package.json. The result was three different version strings on one
 * admin screen: the sidebar reads package.json (0.9.0-rc.7), /system/info
 * read the stale LOOMBRE_VERSION_FULL, and the Updates card read the
 * staler bare LOOMBRE_VERSION — which also feeds update-check's
 * compareSemver, so `updateAvailable` was computed against the wrong
 * version. Only .github/workflows/release.yml ever re-stamped, so release
 * artifacts self-healed while the committed tree and every dev build went
 * silently stale. Placed IMMEDIATELY after sdk-drift because it is the
 * same class of check — "a generated file drifted from the source it is
 * generated from" — just over a different generated artifact, and just as
 * cheap (two file reads). Short-hash freshness is deliberately not gated;
 * see scripts/release/lib/version-stamp.mjs's header.
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
 * go-licenses-check (STATE.md "Loombre Remote", lane WG1, RG1/RG14):
 * scripts/go-licenses-check.mjs — the SAME license allow-list license-
 * check.mjs enforces over the npm graph, walked over packages/wg-native/
 * native's Go dependency graph instead (license-checker never sees Go
 * modules at all). Placed immediately after license-check: both are the
 * SAME class of dependency-supply-chain gate, just over two different
 * package graphs.
 *
 * dep-audit (Phase 4 lane G1, STATE.md P4.15): `pnpm audit --prod --json`
 * gated against audit-allowlist.json — see scripts/dep-audit.mjs's own
 * header. Placed right after the two license gates: all three are
 * dependency-supply-chain checks over the resolved dependency graph, so a
 * failure in any of them reads as "the dependency tree itself has a
 * problem" before any source-code gate (lint/typecheck/test) even runs.
 *
 * installers-test (repair lane R2-wire-installer-tests, Wave 5 review
 * follow-up): `pnpm run installers:test` — `node --test`, recursively
 * discovering every `*.test.mjs` file under installers/. installers/ is
 * not a pnpm workspace, so turbo's `test` step above never reaches it —
 * the exact gap that left the AUD-A5b-001 x64 Distribution.xml
 * `hostArchitectures` fix with zero regression protection
 * (installers/macos/pkg/distribution-xml.test.mjs
 * ran in no runner at all). Placed immediately after `test`: same class of
 * check, just over a package tree outside the turbo workspace graph.
 * Node-only, deliberately: the Windows tray/service-host C# suites
 * (installers/windows/tray/Loombre.Tray.Tests,
 * installers/windows/service-host/LoombreServiceHost.Tests — AUD-W1-001)
 * stay OUT of this step. There is no dotnet toolchain on dev machines, so
 * wiring `dotnet test` into a step that runs on every `pnpm gate` would
 * fail the inner loop for everyone without the .NET SDK installed. Those
 * suites keep running exactly where they already did —
 * windows-installer-diag.yml and release.yml — see
 * reports/audit-fafa47f/candidates/W1-followups.md for that finding's
 * current (still-open) status.
 *
 * scripts-test (QA backlog #119, d4-i6): `pnpm run scripts:test` —
 * `node --test` over scripts/*.test.mjs + scripts/release/test/**. Placed
 * immediately after installers-test because it exists for the IDENTICAL
 * reason: scripts/ is not a pnpm workspace either, so `turbo run test`
 * above never reaches it, and until this step landed only
 * .github/workflows/ci.yml ran those 165 tests. That left the whole
 * release toolchain (version stamping, manifest building, SHA256SUMS,
 * minisign key consistency, release notes) and the doc-drift gate
 * invisible to the local inner loop — the one place they are cheap to
 * catch. Costs ~0.3s, which is why it is in the fast chain rather than
 * gate:full. scripts/gate-wiring.test.mjs (one of the suites this step
 * runs) is the standing guard that both out-of-workspace trees stay
 * wired.
 *
 * docs-build (Addendum A, lane D1, STATE.md "## Addendum A" deliverable
 * 10): `node scripts/docs/build.mjs` — VitePress site build + the
 * `redocly build-docs` API reference, wired as the LAST of the 17 fixed
 * steps (full mode's web-build-budget, when present, runs after it).
 * Deliberately last among those 17 steps: it's cheapest to reach only once
 * everything earlier (codegen through grep-gates) has already confirmed
 * the rest of the repo is consistent, and a docs-only PR still gets full
 * gate coverage before this step runs. A broken docs build (bad Markdown
 * link, VitePress config error, the API reference generator failing)
 * fails the gate here; register-lint's own findings are warnings-only and
 * never fail this step (see scripts/docs/register-lint.mjs's header).
 *
 * web-build-budget (full mode only, L4): `pnpm run perf:web-budget` —
 * see the Modes section above. Placed after docs-build rather than
 * interleaved: it's by far the most expensive step (a full Next.js
 * production build), so it only runs once every cheaper step has already
 * passed.
 *
 * Stops at the first failing step. Each step prints a clear PASS/FAIL line.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mode argument (L4): no arg = fast (default, unchanged); "full" = fast +
// web-build-budget. Anything else is a usage error — see the Modes section
// in the header comment above.
const MODE_ARG = process.argv[2];
if (MODE_ARG !== undefined && MODE_ARG !== "full") {
  console.error(
    `gate: unrecognized argument "${MODE_ARG}"\n` +
      "usage: node scripts/gate.mjs        # fast (default)\n" +
      "       node scripts/gate.mjs full   # fast + web-build-budget",
  );
  process.exit(1);
}
const FULL = MODE_ARG === "full";

// FAST STEPS — the canonical, ordered list (`version-stamp` is the only
// entry added since gate:full's mode argument landed). Full mode appends
// to this array below rather than editing it in place, so a step-loss
// regression is a one-line diff to catch on review.
const steps = [
  { name: "codegen", run: runCodegen },
  { name: "sdk-drift", run: runSdkDrift },
  { name: "version-stamp", run: () => runCommand("node", ["scripts/release/stamp-version.mjs", "--check"]) },
  { name: "oasdiff", run: runOasdiff },
  { name: "depcruise", run: runDepcruise },
  { name: "runtime-imports", run: () => runCommand("node", ["scripts/check-runtime-imports.mjs"]) },
  { name: "license-check", run: runLicenseCheck },
  { name: "go-licenses-check", run: runGoLicensesCheck },
  { name: "dep-audit", run: () => runCommand("node", ["scripts/dep-audit.mjs"]) },
  { name: "lint", run: () => runCommand("pnpm", ["run", "lint"]) },
  { name: "typecheck", run: () => runCommand("pnpm", ["run", "typecheck"]) },
  { name: "test", run: () => runCommand("pnpm", ["run", "test"]) },
  { name: "installers-test", run: () => runCommand("pnpm", ["run", "installers:test"]) },
  { name: "scripts-test", run: () => runCommand("pnpm", ["run", "scripts:test"]) },
  { name: "db:migrate-check", run: () => runCommand("pnpm", ["run", "db:migrate-check"]) },
  { name: "grep-gates", run: () => runCommand("node", ["scripts/grep-gates.mjs"]) },
  { name: "docs-build", run: () => runCommand("node", ["scripts/docs/build.mjs"]) },
];

if (FULL) {
  steps.push({ name: "web-build-budget", run: () => runCommand("pnpm", ["run", "perf:web-budget"]) });
}

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

function runGoLicensesCheck() {
  // RG1/RG14 (STATE.md "Loombre Remote", lane WG1): license-checker only
  // ever sees the npm graph — packages/wg-native/native's Go module graph
  // is entirely invisible to it. go-licenses-check.mjs closes that gap
  // (same allow-list, walked over the real Go dependency graph).
  return runCommand("node", ["scripts/go-licenses-check.mjs"]);
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
