// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/license-check.mjs
//
// D12 license gate (CLAUDE.md invariant, LICENSE-INTENT.md): every
// production + bundled dependency must carry an AGPL-3.0-compatible license.
//
// WHY THIS EXISTS (Phase 4 Wave 3 AGPL-readiness finding): a single
// `license-checker-rseidelsohn` run from the repo ROOT is STRUCTURALLY BLIND
// to most production dependencies. pnpm's isolated node-linker never hoists
// workspace-scoped deps to the root node_modules, and root package.json has
// no npm/yarn `"workspaces"` field (workspaces live only in
// pnpm-workspace.yaml), so the root scan sees only ~554 packages and MISSES
// direct prod deps declared inside workspace packages — @nestjs/*,
// acme-client, jose, pg-boss, @napi-rs/keyring, hls.js, and more. The real
// graph is ~798 packages. This script closes that blind spot by running the
// allow-list check FROM EVERY WORKSPACE ROOT (plus the repo root): if any
// workspace's own dependency tree contains a disallowed license, that
// invocation fails, so the union is covered without needing to merge outputs.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Kept in sync with the (now-removed) root package.json "license-check"
// script's flags — the single source of the allow-list is HERE now.
const ALLOW =
  "MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;AGPL-3.0;GPL-3.0;LGPL-3.0;" +
  "MPL-2.0;0BSD;BlueOak-1.0.0;CC0-1.0;CC-BY-4.0;Unlicense;Python-2.0;WTFPL";

// Dev-tooling-only packages, never bundled/shipped, documented in
// LICENSE-INTENT.md's "Tooling exclusions" table (D20 + Wave-3 additions).
// Each is a transitive devDependency and appears in no shipped artifact.
//   - spdx-exceptions / spdx-ranges: imprecise-license transitive deps of
//     the license checker / spdx toolchain itself.
//   - url-template@2.0.8: transitive devDep of @redocly/cli (the OpenAPI
//     lint/codegen toolchain in @loombre/contract). Declares a BARE "BSD"
//     license string the checker can't SPDX-match, but its LICENSE file is
//     verified BSD-3-Clause (3 conditions, non-endorsement clause, NO
//     4-clause advertising clause — read in full Wave-3) = allow-list
//     compatible; excluded only because the string is unmatchable, not the
//     license. Never bundled (build-time OpenAPI tooling only).
const EXCLUDE = "spdx-exceptions@2.5.0;spdx-ranges@2.1.1;url-template@2.0.8";

// pnpm-workspace.yaml globs are apps/* and packages/* — enumerate every
// directory under them that has a package.json, plus the repo root.
function workspaceDirs() {
  const dirs = [ROOT];
  for (const parent of ["apps", "packages"]) {
    const base = join(ROOT, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      if (existsSync(join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

// On Windows, pnpm is a .cmd shim Node cannot spawn without a shell
// (ENOENT) — the Phase-0 f13c21a lesson. Without this, the catch below
// mislabeled the spawn failure as "disallowed license" on ALL 15 trees
// (first Windows leg since this script's Wave-3 rewrite, caught by the
// rename run's [full-ci] matrix). Shell stays off on POSIX (paths with
// spaces).
const WIN = process.platform === "win32";

function checkFrom(startDir) {
  // license-checker-rseidelsohn resolves the dependency tree from --start.
  // --excludePrivatePackages drops the workspace's own @loombre/* packages
  // (private:true, never published). A non-zero exit means a disallowed
  // license was found in that tree — the CLI prints the offender.
  execFileSync(
    "pnpm",
    [
      "exec",
      "license-checker-rseidelsohn",
      "--start",
      startDir,
      "--onlyAllow",
      ALLOW,
      "--excludePrivatePackages",
      "--excludePackages",
      EXCLUDE,
      "--summary",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: WIN },
  );
}

const dirs = workspaceDirs();
let failed = 0;
for (const dir of dirs) {
  const label = dir === ROOT ? "(root)" : dir.slice(ROOT.length + 1);
  try {
    checkFrom(dir);
    console.log(`license-check: PASS  ${label}`);
  } catch (err) {
    failed += 1;
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    console.error(`license-check: FAIL  ${label}`);
    if (out) console.error(out);
  }
}

if (failed > 0) {
  console.error(`\nlicense-check: FAILED — ${failed}/${dirs.length} workspace tree(s) had a disallowed license.`);
  process.exit(1);
}
console.log(`\nlicense-check: PASS (${dirs.length} workspace trees scanned — root blind-spot closed, Wave-3 AGPL finding).`);
