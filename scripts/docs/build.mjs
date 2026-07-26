#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs/build.mjs
//
// Addendum A, lane D1 (STATE.md "## Addendum A", deliverable 10) — the
// `pnpm docs:build` entry point, and the docs suite's contribution to
// `pnpm gate` as its final step (scripts/gate.mjs).
//
// Order (each step's rationale inline):
//   1. gen-settings-reference  — writes docs/admin-guide/settings-reference.md
//   2. gen-env-reference       — writes docs/ops/env-reference.md
//      (both generated-include seams must run BEFORE `vitepress build`
//      because VitePress needs the Markdown SOURCE files to exist in docs/
//      to route them. Both are REAL generators reading
//      packages/shared/src/settings-registry.ts (lane S1, landed) as of
//      this session — run via `tsx`, not plain `node`, so they can import
//      that TypeScript source directly with no build-step-ordering
//      dependency on a committed packages/shared/dist/; see each script's
//      own header for the full reasoning. tsx is already a root
//      devDependency — no new install.)
//   3. gen-lpp-spec            — writes docs/developer-guide/plugins/spec.md,
//      a byte-for-byte copy of packages/plugin-protocol/spec/lpp-v1.md (LPP
//      v1, Lane W6). Plain `node`, not `tsx` — the source is already
//      Markdown. Same "must run before vitepress build" reasoning as steps
//      1-2, and folded into the SAME drift check below.
//   4. drift check             — the three generated-include pages above
//      are COMMITTED (so they read correctly on GitHub, same path as the
//      built site). If regeneration just changed any of them, the
//      committed copy was stale relative to its source — fail so the
//      regenerated file gets committed, exactly like a regenerated SDK.
//      Skipped when not in a git checkout.
//   5. collect-screenshots     — writes docs/reference/screenshots.md (must
//      also run before the VitePress build, same reason; scans the other
//      generated pages too, which is fine — they carry no placeholders).
//   6. register-lint           — warnings-only audience-register check
//      (scripts/docs/register-lint.mjs); ALWAYS exits 0, runs after content
//      generation so generated pages get checked too, before the build so
//      warnings are visible even if the build itself later fails.
//   7. vitepress build docs    — the actual static-site build. MUST fail
//      this script (and therefore `pnpm gate`) on a broken build — no swallowing.
//   8. build-api-reference     — redocly build-docs -> docs/.vitepress/dist/
//      api-reference/redoc.html, run AFTER step 7 because `vitepress build`
//      empties/rewrites its own outDir. Also fails loudly on error (mission
//      brief: "the docs build must actually FAIL the gate on broken build").
//
// Nothing here needs network access or telemetry: VitePress's local search
// provider is bundled (no Algolia), its default theme's fonts are inlined
// at build time from files already in node_modules/vitepress (verified —
// see docs/.vitepress/config.mts's header comment), and
// build-api-reference.mjs sets REDOCLY_TELEMETRY=off itself.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const WIN = process.platform === "win32";

function run(label, cmd, args) {
  console.log(`\n=== docs:build: ${label} ===`);
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", shell: WIN });
  if (result.error) {
    console.error(`docs:build: FAIL at "${label}" — ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`docs:build: FAIL at "${label}" (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

run("gen-settings-reference (reads packages/shared/src/settings-registry.ts)", TSX_BIN, ["scripts/docs/gen-settings-reference.mjs"]);
run("gen-env-reference (reads packages/shared/src/settings-registry.ts)", TSX_BIN, ["scripts/docs/gen-env-reference.mjs"]);
run("gen-lpp-spec (copies packages/plugin-protocol/spec/lpp-v1.md)", process.execPath, ["scripts/docs/gen-lpp-spec.mjs"]);
// Drift check (sdk-drift precedent): the three generated pages above are
// COMMITTED (so they read correctly on GitHub, same path as the built
// site). If regeneration just changed any of them, the committed copy was
// stale relative to its source — fail so the regenerated file gets
// committed, exactly like a regenerated SDK. Skipped when not in a git
// checkout.
{
  const drift = spawnSync(
    "git",
    [
      "diff",
      "--exit-code",
      "--",
      "docs/admin-guide/settings-reference.md",
      "docs/ops/env-reference.md",
      "docs/developer-guide/plugins/spec.md",
    ],
    { cwd: REPO_ROOT, stdio: "inherit", shell: WIN },
  );
  if (drift.status === 1) {
    console.error(
      "docs:build: FAIL at \"generated-reference drift\" — one or more of docs/admin-guide/settings-reference.md, " +
        "docs/ops/env-reference.md, docs/developer-guide/plugins/spec.md were regenerated with different content " +
        "than the committed copies. The source changed without the generated docs being re-committed: commit the " +
        "regenerated files.",
    );
    process.exit(1);
  }
}
run("collect-screenshots", process.execPath, ["scripts/docs/collect-screenshots.mjs"]);
run("register-lint (warnings only)", process.execPath, ["scripts/docs/register-lint.mjs"]);
run("vitepress build", join(REPO_ROOT, "node_modules", ".bin", "vitepress"), ["build", "docs"]);
run("build-api-reference", process.execPath, ["scripts/docs/build-api-reference.mjs"]);

console.log("\ndocs:build: ALL STEPS PASSED");
process.exit(0);
