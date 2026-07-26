#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runtime-TS packaging regression guard (STATE.md Phase 4 Open item
 * "Runtime-TS packaging defects (I2 findings)", CLAUDE.md invariant 6/9
 * posture — the built product must run as compiled output, never as raw
 * TypeScript shipped at runtime).
 *
 * THE DEFECT THIS GUARDS AGAINST: @loombre/db and @loombre/jobs used to ship
 * package.json `exports`/`main`/`types` pointing straight at `src/*.ts`.
 * `tsx`/vitest tolerate that (they strip types on the fly), so the bug was
 * invisible in dev and in every test run — it only surfaced the moment a
 * production `node dist/main.js` (no tsx, no --import loader) tried to
 * resolve `@loombre/db`/`@loombre/jobs` and hit ERR_MODULE_NOT_FOUND /
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. Every installer lane (I1
 * tarball, I2 Docker, I3 MSI, I4 pkg) had to shim around it. Fixed
 * structurally in Wave 3 (lane STRUCT): @loombre/db + @loombre/jobs now build
 * real `dist/` output and export it, exactly like every other workspace
 * package (@loombre/controller-ipc, @loombre/playback-engine,
 * @loombre/provisioning, @loombre/provisioning-pg, @loombre/release-manifest,
 * @loombre/sdk, @loombre/secrets, @loombre/shared).
 *
 * WHAT THIS SCRIPT ENFORCES: starting from apps/server and apps/worker (the
 * two things a real deployment actually runs with plain `node`), walk the
 * `dependencies` graph (never `devDependencies` — those are dev/test-only
 * and legitimately never need to survive as compiled output) transitively
 * across every `workspace:*` @loombre/* package. For each package reached
 * this way, its package.json `main`/`types`/`exports` must resolve into
 * `dist/` — never a bare `.ts` file, never a `src/` path segment. A package
 * with no runtime consumer (currently only @loombre/contract: OpenAPI +
 * event-schema files only, no importable code, consumed solely by the
 * codegen script and typecheck-time by @loombre/sdk) is exempt — nothing
 * about "ships as TypeScript" matters for a package nothing ever imports
 * at runtime, and forcing one to grow a dist/ build it doesn't need would
 * be pure busywork.
 *
 * This is a static check over package.json shape — it does not require a
 * prior build (dist/ need not exist on disk yet), so it's cheap to run
 * early in the gate, immediately after depcruise (both are structural
 * checks over the workspace package graph, before the heavier
 * lint/typecheck/test steps).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Reads and JSON-parses a package.json at a given package directory. */
function readPackageJson(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
}

/** Builds the @loombre/<name> -> packages|apps/<dir> map by scanning both
 *  workspace roots — mirrors pnpm-workspace.yaml's own package discovery,
 *  intentionally not hard-coded so a newly added package is picked up
 *  automatically rather than silently skipped. */
function discoverWorkspacePackages() {
  /** @type {Map<string, string>} */
  const nameToDir = new Map();
  for (const root of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      let pkg;
      try {
        pkg = readPackageJson(dir);
      } catch {
        continue; // not every dir under apps/packages need be a package (none currently, but stay defensive)
      }
      if (typeof pkg.name === "string" && pkg.name.startsWith("@loombre/")) {
        nameToDir.set(pkg.name, dir);
      }
    }
  }
  return nameToDir;
}

/** Collects every string found anywhere inside a package.json's
 *  main/types/exports fields (exports can nest arbitrarily — conditional
 *  objects, subpaths, arrays of fallbacks — so this walks the whole shape
 *  rather than assuming one level of nesting). */
function collectEntryPointStrings(pkg) {
  /** @type {string[]} */
  const values = [];
  if (typeof pkg.main === "string") values.push(pkg.main);
  if (typeof pkg.types === "string") values.push(pkg.types);
  if (typeof pkg.typings === "string") values.push(pkg.typings);

  function walk(node) {
    if (typeof node === "string") {
      values.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node && typeof node === "object") {
      for (const value of Object.values(node)) walk(value);
    }
  }
  if (pkg.exports !== undefined) walk(pkg.exports);

  return values;
}

/** A raw-TS-at-runtime leak: an entry-point string that is (or points
 *  inside) `src/`, or that names a `.ts`/`.tsx`/`.mts`/`.cts` file
 *  directly — the exact shape of the fixed defect. `.d.ts`/`.d.mts`/
 *  `.d.cts` declaration files are fine anywhere (types-only, erased before
 *  Node ever sees them) and explicitly NOT flagged. */
function findRawTsLeaks(entryPoints) {
  const leaks = [];
  for (const value of entryPoints) {
    if (/(^|\/)src(\/|$)/.test(value)) {
      leaks.push({ value, reason: "points into a src/ directory" });
      continue;
    }
    if (/\.(ts|tsx|mts|cts)$/.test(value) && !/\.d\.(ts|mts|cts)$/.test(value)) {
      leaks.push({ value, reason: "points at a raw .ts source file, not compiled output" });
    }
  }
  return leaks;
}

// @loombre/contract ships only openapi.yaml + event-schemas (no "exports"/
// "main"/"types" at all — see packages/contract/package.json) and nothing
// in apps/server or apps/worker's runtime dependency closure imports it;
// it is consumed only by the codegen script and, at typecheck time, by
// @loombre/sdk. There is nothing "raw TS at runtime" could mean for it.
const RUNTIME_EXEMPT = new Set(["@loombre/contract"]);

const nameToDir = discoverWorkspacePackages();

const ENTRYPOINTS = ["@loombre/server", "@loombre/worker"];

/** @type {Set<string>} */
const visited = new Set();
/** @type {string[]} */
const queue = [...ENTRYPOINTS];
/** @type {{name: string, dir: string, leaks: {value: string, reason: string}[]}[]} */
const violations = [];
/** @type {string[]} */
const checked = [];

while (queue.length > 0) {
  const name = queue.shift();
  if (visited.has(name)) continue;
  visited.add(name);

  const dir = nameToDir.get(name);
  if (dir === undefined) {
    console.error(`check-runtime-imports: FAIL — "${name}" is a workspace dependency but no packages/*/apps/* directory declares that package.json "name".`);
    process.exit(1);
  }

  const pkg = readPackageJson(dir);

  // Queue this package's own runtime (never dev-only) workspace
  // dependencies so the walk covers the FULL transitive closure, not just
  // apps/server + apps/worker's direct deps.
  const deps = pkg.dependencies ?? {};
  for (const [depName, versionSpec] of Object.entries(deps)) {
    if (depName.startsWith("@loombre/") && String(versionSpec).startsWith("workspace:")) {
      queue.push(depName);
    }
  }

  // apps/server and apps/worker are themselves entry points executed
  // directly (`node dist/main.js` / `node dist/index.js`), not imported —
  // they're subject to the exact same "must be compiled output" rule as
  // every workspace package they depend on, so no special-case here.
  if (RUNTIME_EXEMPT.has(name)) {
    checked.push(`${name} (exempt — no runtime importer)`);
    continue;
  }

  const entryPoints = collectEntryPointStrings(pkg);
  const leaks = findRawTsLeaks(entryPoints);
  checked.push(name);
  if (leaks.length > 0) {
    violations.push({ name, dir, leaks });
  }
}

if (violations.length > 0) {
  console.error(`check-runtime-imports: FAIL — ${violations.length} package(s) in apps/server + apps/worker's runtime dependency closure still expose raw TypeScript source instead of built dist/ output:\n`);
  for (const { name, dir, leaks } of violations) {
    console.error(`  ${name} (${dir}/package.json):`);
    for (const { value, reason } of leaks) {
      console.error(`    "${value}" — ${reason}`);
    }
  }
  console.error(
    "\nA production `node dist/main.js` (no tsx, no --import loader) will fail with " +
      "ERR_MODULE_NOT_FOUND / ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING the moment this " +
      "package is imported. Fix: add a real `build` script (tsc -p tsconfig.json emitting to " +
      "dist/ with declaration + declarationMap + sourceMap), and point main/types/exports at " +
      "the dist/ equivalents — see packages/db or packages/jobs for the reference shape.",
  );
  process.exit(1);
}

console.log(
  `check-runtime-imports: PASS — ${checked.length} package(s) in apps/server + apps/worker's runtime closure all resolve to dist/ (or are explicitly runtime-exempt): ${checked.join(", ")}`,
);
process.exit(0);
