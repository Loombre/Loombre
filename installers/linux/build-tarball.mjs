#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/build-tarball.mjs
//
// Produces loombre-<version>-linux-<arch>.tar.gz — a self-contained,
// systemd-ready Linux distribution: bundled Node 22 runtime, built
// server+worker with production node_modules, a built web client, bundled
// ffmpeg/ffprobe (scripts/fetch-ffmpeg.mjs), bin/ wrapper scripts, a
// VERSION file, and an unsigned-build sign-hook call. See LAYOUT.md for
// the exact on-disk shape this produces and docs/install/linux.md for the
// operator-facing install flow.
//
// ─────────────────────────────────────────────────────────────────────────
// DESIGN NOTE — "the right pnpm mechanism for a self-contained deploy"
// (this lane's brief explicitly asked this to be investigated+documented):
//
// `pnpm --filter <pkg> deploy <dir> --prod --legacy` is the right primitive
// (isolates one workspace package + its resolved prod dependency graph
// into a standalone directory, `--legacy` because this workspace uses a
// shared lockfile and pnpm's newer deploy implementation refuses that
// combination). It is NOT sufficient on its own, for one specific reason
// discovered while proving this script against the real workspace:
//
//   @loombre/db and @loombre/jobs ship TS SOURCE ONLY, by declared design
//   (their package.json `exports` point at ./src/*.ts, not a built dist —
//   see packages/db's own module header). Every other in-repo consumer
//   (dev server, perf-t0 harness, vitest) bridges this at IMPORT TIME via
//   tsx's esbuild-backed loader. tsx is a devDependency, so `--prod`
//   correctly excludes it — and even if it were vendored in by hand,
//   tsx's `esbuild` dependency resolves a PLATFORM-SPECIFIC native binary
//   (`@esbuild/<platform>-<arch>`) at install time for the CURRENT host,
//   which is wrong when cross-building the linux-x64/arm64 tarball from a
//   developer's macOS machine — proven by inspecting the local pnpm store,
//   which resolved `@esbuild/darwin-arm64` on this build host.
//
// This script avoids the whole native-binary cross-compilation problem by
// PRE-COMPILING @loombre/db and @loombre/jobs to plain ESM JavaScript as a
// packaging-time-only step (precompileRawTsWorkspaceDep below), entirely
// within each deploy tree's own isolated copy of that package (pnpm deploy
// physically copies workspace deps rather than symlinking to the live
// source — confirmed by inspecting a real deploy output — so this never
// touches packages/db or packages/jobs themselves). The deployed copy's
// package.json `exports` is then rewritten (in the copy only) to point at
// the compiled dist/. This was proven end-to-end against the real
// workspace: a compiled worker dist/index.js booting through
// @loombre/jobs -> @loombre/db -> kysely -> pg with ZERO tsx/esbuild in the
// final tree, reaching a real (expected, since nothing was listening)
// ECONNREFUSED from pg-boss's own connection attempt — i.e. the entire
// module graph resolves and executes for real, only the final network hop
// was intentionally pointed at a dead port for that proof.
//
// Two non-obvious things this uncovered, both handled below:
//   1. @loombre/jobs' tsconfig.json `extends: "../../tsconfig.base.json"` —
//      a relative path that no longer resolves once the package is copied
//      to an isolated deploy directory. A first fix (copy tsconfig.base.json
//      alongside, repoint `extends` at the copy) reproduced a TS5083
//      "cannot read file" from the spawned tsc child even though this
//      process's own existsSync + read-back both confirmed the copy
//      present — an inter-process same-directory-sibling-file race this
//      repo's heavy concurrent build activity can apparently trigger.
//      Fixed for real by INLINING tsconfig.base.json's compilerOptions
//      into the local tsconfig.json (local keys win) instead — one file,
//      no `extends`, no second file for a race to exist between.
//   2. A tsc run that ERRORS (e.g. from #1, before it was fixed) can still
//      emit stale/wrong-module-format JS from a partial/previous attempt —
//      observed once as accidental CommonJS output despite `"type":
//      "module"` + `module: "NodeNext"`, which Node's CJS/ESM interop does
//      not always resolve named re-exports through cleanly. This script
//      always wipes each package's `dist/` before compiling and treats a
//      non-zero tsc exit as fatal (never "best effort").
//
// Two more gaps surfaced by the FIRST real container smoke run against a
// deployed tarball (both fixed below, both discoveries worth flagging to
// whichever lane next touches these package.json files):
//   3. apps/server/package.json lists `ajv` under devDependencies, but
//      apps/server/src/common/device-profile-validator.ts imports it at
//      RUNTIME — `pnpm deploy --prod` correctly strips devDependencies,
//      so the deployed server crashed at boot with
//      ERR_MODULE_NOT_FOUND('ajv'). Worked around here by vendoring the
//      already-resolved `ajv` package (pinned in the lockfile, not
//      `pnpm add`-ed) straight into the deployed server's node_modules —
//      see vendorResolvedNpmPackage. The real fix (moving `ajv` to
//      `dependencies` in apps/server/package.json) is one line, but is in
//      apps/ and out of this lane's ownership; flagged in the handoff
//      report as an orchestrator TODO.
//   4. apps/worker depends on `sharp`, which resolves a PLATFORM-SPECIFIC
//      native binary package (`@img/sharp-<platform>-<arch>`) — exactly
//      the esbuild problem from point 1 above, but for a real production
//      dependency this time, so precompiling it away isn't an option.
//      `pnpm deploy` always materializes the BUILD HOST's variant
//      (confirmed: darwin-arm64 got installed even when the deploy's own
//      `--config.supportedArchitectures` was explicitly set to
//      linux/arm64 — optionalDependency resolution for the package
//      actually being installed always targets the CURRENT running
//      process, by npm/pnpm design, not a configurable target). Fixed by
//      fetching the TARGET platform's `@img/sharp-<platform>` and
//      `@img/sharp-libvips-<platform>` packages directly from the npm
//      registry at the EXACT version pnpm-lock.yaml already pins,
//      verifying each against that same lockfile's own recorded sha512
//      integrity before use (see vendorPinnedPlatformNpmPackage) — same
//      "reuse what's already pinned, verify before trusting" discipline
//      scripts/fetch-ffmpeg.mjs uses for ffmpeg, applied to an npm
//      package instead of a GitHub release asset. No lockfile edit, no
//      `pnpm add` — the version being fetched is read FROM the lockfile.
// ─────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  realpathSync,
  cpSync,
  chmodSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { verifyChecksum } from "../../scripts/fetch-ffmpeg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const INSTALLERS_LINUX_DIR = __dirname;
const WIN = process.platform === "win32"; // this script only ever targets linux output, but may run on any dev host

// ─────────────────────────────────────────────────────────────────────────
// Pure-ish helpers
// ─────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {
    version: undefined,
    arch: "x64",
    outDir: join(INSTALLERS_LINUX_DIR, "dist"),
    skipAppBuild: false,
    skipFetchFfmpeg: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") out.version = argv[++i];
    else if (arg === "--arch") out.arch = argv[++i];
    else if (arg === "--out-dir") out.outDir = resolve(argv[++i]);
    else if (arg === "--skip-app-build") out.skipAppBuild = true;
    else if (arg === "--skip-fetch-ffmpeg") out.skipFetchFfmpeg = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`build-tarball: unrecognized argument ${JSON.stringify(arg)}`);
  }
  if (out.arch !== "x64" && out.arch !== "arm64") {
    throw new Error(`build-tarball: --arch must be x64 or arm64, got ${JSON.stringify(out.arch)}`);
  }
  return out;
}

export function ffmpegPlatformKey(arch) {
  return arch === "arm64" ? "linux-arm64" : "linux-x64";
}

export function readRepoVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("build-tarball: root package.json has no usable `version` field");
  }
  return pkg.version;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────
// Process helpers
// ─────────────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}${opts.cwd ? `  (cwd=${opts.cwd})` : ""}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: WIN, ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`build-tarball: command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

function ensureEmptyDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────
// Step: build + pnpm-deploy an app
// ─────────────────────────────────────────────────────────────────────────

function pnpmBuild(pkgName) {
  run("pnpm", ["--filter", pkgName, "run", "build"], { cwd: REPO_ROOT });
}

function pnpmDeploy(pkgName, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  run("pnpm", ["--filter", pkgName, "deploy", destDir, "--prod", "--legacy"], { cwd: REPO_ROOT });
}

/** Removes dev-only cruft `pnpm deploy` carries over (it copies the whole
 *  package directory, not just build output — there is no `files`
 *  allowlist in any of these package.json today). Keeps dist/, package.json,
 *  node_modules/, and anything else not explicitly listed (e.g. a `bin/`
 *  a package might ship). */
function pruneDeployedAppDir(deployDir) {
  const DROP = ["src", "test", "tsconfig.json", "tsconfig.test.json", "vitest.config.ts", ".turbo", "data", "coverage"];
  for (const name of DROP) {
    rmSync(join(deployDir, name), { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Step: precompile a raw-TS-only workspace dependency (@loombre/db,
// @loombre/jobs). See the file header for why this exists.
//
// *** SAFETY-CRITICAL — READ BEFORE TOUCHING ***
// `pnpm --filter <app> deploy <dir> --prod --legacy` isolates the TARGET
// app package (a real, independent copy — verified: different inode from
// the live apps/server|worker/src). It does NOT isolate "file:"-protocol
// WORKSPACE DEPENDENCIES resolved inside that deploy's node_modules —
// those are HARD-LINKED straight back to the live packages/db and
// packages/jobs source directories (verified: `stat -f %i` on the
// deployed node_modules/.pnpm/@loombre+jobs@file+packages+jobs/.../
// package.json returned the SAME inode number as the live
// packages/jobs/package.json). A first version of this function compiled
// and rewrote package.json IN PLACE at that resolved path, believing it
// was a private copy — it silently mutated packages/db/package.json and
// packages/jobs/{package.json,tsconfig.json} in the live tree (caught via
// `git status` showing unexpected diffs on files this lane must never
// touch; reverted with `git checkout --`, stray leaked dist/ directories
// removed). The design below fixes this at the root: it NEVER WRITES
// THROUGH ANY PATH RESOLVED FROM INSIDE A DEPLOY TREE'S node_modules.
// Instead it builds each dep exactly ONCE into a private staging
// directory made with an explicit `cp -R` of ONLY src/ + package.json +
// tsconfig.json (a real, non-hardlinked copy — cpSync's default content-
// copy semantics, confirmed by differing inode from source), reads
// (never writes) the live node_modules via a *symlink* purely for tsc's
// module resolution during that one compile, then DELETES each deploy's
// hardlinked copy outright (safe: unlinking a directory entry never
// touches the data other hardlinks to the same inode still reference —
// confirmed empirically: packages/db/src's 42 files were untouched after
// this exact delete ran against the deploy copy during triage) and
// replaces it with a real `cpSync` of the precompiled staging output.
// ─────────────────────────────────────────────────────────────────────────

function findRepoTsc() {
  const tscPath = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tscPath)) {
    throw new Error(`build-tarball: ${tscPath} not found — is the workspace's typescript devDependency installed?`);
  }
  return tscPath;
}

// ─────────────────────────────────────────────────────────────────────────
// Vendoring already-pinned npm packages into a deployed --prod tree — see
// the file header's points 3/4 for why these two exist.
// ─────────────────────────────────────────────────────────────────────────

/** Copies an already-resolved package (found in this repo's own root pnpm
 *  store — never `pnpm add`-ed, never affects the lockfile) into
 *  `destNodeModulesDir/<pkgName>`, dereferencing every symlink so the
 *  result is fully self-contained (no relative symlinks pointing back
 *  into the build machine's pnpm store survive into the shipped tarball).
 *  Used for platform-agnostic pure-JS packages only (see vendorPinnedPlatformNpmPackage
 *  for native/platform-specific ones, which this must NOT be used for —
 *  it copies whatever the BUILD HOST resolved, exactly the bug that
 *  function exists to avoid). */
function vendorResolvedNpmPackage(pkgName, fromLivePackageDir, destNodeModulesDir) {
  // Resolved via the ACTUAL consuming package's own node_modules symlink
  // (e.g. apps/server/node_modules/ajv -> .pnpm/ajv@8.20.0/...) rather
  // than scanning the root pnpm store for anything matching `${pkgName}@*`
  // — a first version did that and silently grabbed the WRONG version:
  // the store also has `ajv@6.15.0` (an unrelated transitive dependency
  // of something else entirely) alongside the `ajv@8.20.0` apps/server
  // actually depends on, and both match a loose `startsWith("ajv@")`
  // prefix; alphabetical directory order (6 before 8) silently picked the
  // wrong one, and ajv 6's very different internal layout (`main:
  // "lib/ajv.js"`, no `dist/`) broke the app in a way that only surfaced
  // once actually booted in the container smoke test. Resolving through
  // the real consumer's own symlink makes "which version does THIS
  // package actually use" unambiguous by construction.
  const linkPath = join(fromLivePackageDir, "node_modules", ...pkgName.split("/"));
  if (!existsSync(linkPath)) {
    throw new Error(`build-tarball: ${linkPath} does not exist — is ${pkgName} really a (dev)dependency of ${fromLivePackageDir}?`);
  }
  const src = realpathSync(linkPath);
  const dest = join(destNodeModulesDir, ...pkgName.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log(`build-tarball: vendored ${pkgName} (resolved via ${fromLivePackageDir}'s own node_modules, already pinned) -> ${dest}`);

  // `pkgName` itself resolves fine now, but IT has its own runtime
  // dependencies (ajv -> fast-deep-equal/fast-uri/json-schema-traverse/
  // require-from-string) that normally resolve as SIBLINGS inside
  // `.pnpm/ajv@8.20.0/node_modules/` via Node's upward walk — copying
  // only the `ajv` leaf directory (as an earlier version of this function
  // did) leaves those unresolvable (`Cannot find module
  // 'fast-deep-equal'`), caught by the container smoke test actually
  // booting the app rather than just resolving the entry file. Fixed
  // generically: read `pkgName`'s own package.json "dependencies" and
  // vendor each one too (recursively, so a dependency-of-a-dependency is
  // covered as well), resolved the SAME safe way — via ITS OWN closest
  // node_modules ancestor starting the search from `dirname(src)` (the
  // sibling scope `pkgName` itself resolves from), not the root store.
  const pkgJson = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  for (const depName of Object.keys(pkgJson.dependencies ?? {})) {
    if (existsSync(join(destNodeModulesDir, ...depName.split("/")))) continue; // already vendored (shared transitive dep, or a previous call)
    const depSearchRoot = dirname(src); // e.g. .pnpm/ajv@8.20.0/node_modules/ — where ajv's OWN deps live as siblings
    vendorResolvedNpmPackageFrom(depName, depSearchRoot, destNodeModulesDir);
  }
}

/** Shared tail of vendorResolvedNpmPackage's logic, factored out so
 *  transitive dependencies (found relative to their OWN parent's resolution
 *  scope, not a fixed "live package dir") can reuse it. */
function vendorResolvedNpmPackageFrom(pkgName, searchRootNodeModules, destNodeModulesDir) {
  const linkPath = join(searchRootNodeModules, ...pkgName.split("/"));
  if (!existsSync(linkPath)) {
    throw new Error(`build-tarball: ${linkPath} does not exist while vendoring a transitive dependency`);
  }
  const src = realpathSync(linkPath);
  const dest = join(destNodeModulesDir, ...pkgName.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log(`build-tarball: vendored transitive dependency ${pkgName} -> ${dest}`);

  const pkgJson = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  for (const depName of Object.keys(pkgJson.dependencies ?? {})) {
    if (existsSync(join(destNodeModulesDir, ...depName.split("/")))) continue;
    vendorResolvedNpmPackageFrom(depName, dirname(src), destNodeModulesDir);
  }
}

/** Extracts a single package's pinned `integrity: sha512-...` value for
 *  `name@version` out of the checked-in pnpm-lock.yaml, via a targeted
 *  regex rather than a YAML parser (no new dependency — the lockfile is
 *  frozen for this lane, and this lookup's shape is narrow/stable enough
 *  to not need one). Throws if the exact pin isn't found, rather than
 *  silently falling back to an unpinned fetch. */
function readLockfilePinnedIntegrity(name, version) {
  const lockfileText = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
  // pnpm-lock.yaml entries look like:
  //   '@img/sharp-linux-arm64@0.34.5':
  //     resolution: {integrity: sha512-....}
  const escaped = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`'${escaped}':\\n\\s+resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`);
  const match = lockfileText.match(pattern);
  if (!match) {
    throw new Error(`build-tarball: no pinned integrity found in pnpm-lock.yaml for ${name}@${version}`);
  }
  return match[1];
}

/** Fetches `name@version` straight from the npm registry (never `pnpm
 *  add`-ed — the version is READ from pnpm-lock.yaml, not chosen here),
 *  verifies the downloaded tarball's sha512 against that SAME lockfile's
 *  own pinned integrity before trusting it (fails closed, mirroring
 *  scripts/fetch-ffmpeg.mjs's checksum discipline for a GitHub release
 *  asset), and extracts it into `destNodeModulesDir/<name>`. Exists
 *  specifically for platform-specific optional dependencies (sharp's
 *  native binaries) that `pnpm deploy` can only ever materialize for the
 *  CURRENT build host — see the file header's point 4. */
async function vendorPinnedPlatformNpmPackage(name, version, destNodeModulesDir) {
  const expectedIntegrity = readLockfilePinnedIntegrity(name, version);
  const basename = name.split("/").at(-1);
  const url = `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
  console.log(`build-tarball: fetching ${name}@${version} (pinned in pnpm-lock.yaml) from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`build-tarball: GET ${url} -> HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const actualIntegrity = `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(
      `build-tarball: CHECKSUM MISMATCH for ${name}@${version} (${url})\n` +
        `  expected (from pnpm-lock.yaml): ${expectedIntegrity}\n` +
        `  actual:                         ${actualIntegrity}\n` +
        `  Refusing to vendor a tampered/corrupted package.`,
    );
  }
  console.log(`build-tarball: ${name}@${version} integrity verified against pnpm-lock.yaml`);

  const tmpDir = mkdtempSync(join(tmpdir(), "loombre-vendor-npm-"));
  try {
    const tarballPath = join(tmpDir, "package.tgz");
    writeFileSync(tarballPath, buffer);
    const extractDir = join(tmpDir, "extracted");
    mkdirSync(extractDir, { recursive: true });
    run("tar", ["-xzf", tarballPath, "-C", extractDir]);
    // npm tarballs always unpack to a single top-level "package/" dir.
    const dest = join(destNodeModulesDir, ...name.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(extractDir, "package"), dest, { recursive: true });
    console.log(`build-tarball: vendored ${name}@${version} -> ${dest}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Builds a fully independent, precompiled-to-ESM copy of packages/<pkgDirName>
 * inside `stagingRoot` — see the safety comment above for why this exists
 * and exactly what it never writes through. Idempotent within one build:
 * if the output already exists (e.g. both server and worker need
 * @loombre/db), it is reused rather than rebuilt.
 */
function buildPrecompiledWorkspaceDep(pkgDirName, stagingRoot, { exportsMap, depOverrides = {} }) {
  const outDir = join(stagingRoot, pkgDirName);
  const markerPath = join(outDir, ".precompiled-ok");
  // The marker alone made this cache idempotent across BUILDS, not just
  // within one — stagingRoot lives under .build/cache/, which survives
  // runs, so a later build silently shipped a PREVIOUS build's compile of
  // this package (caught in the supported-latest sweep: the tarball's
  // @loombre/db barrel was missing every LPP-era export and the server
  // died on boot in the container smoke). The marker now records a
  // content fingerprint of everything the compile reads — src/**,
  // package.json, tsconfig.json, and each depOverride target's own
  // marker — and only a matching fingerprint is reused.
  const fingerprint = (() => {
    const h = createHash("sha256");
    const liveDir = join(REPO_ROOT, "packages", pkgDirName);
    const addFile = (p) => {
      h.update(relative(liveDir, p));
      h.update("\0");
      h.update(readFileSync(p));
      h.update("\0");
    };
    const walkSrc = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walkSrc(p);
        else addFile(p);
      }
    };
    walkSrc(join(liveDir, "src"));
    addFile(join(liveDir, "package.json"));
    addFile(join(liveDir, "tsconfig.json"));
    for (const [name, targetDir] of Object.entries(depOverrides).sort(([a], [b]) => a.localeCompare(b))) {
      h.update(name);
      h.update(readFileSync(join(targetDir, ".precompiled-ok"), "utf8"));
    }
    return h.digest("hex");
  })();
  if (existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === fingerprint) {
    console.log(`build-tarball: ${pkgDirName} already precompiled at ${outDir} (fingerprint match) — reusing`);
    return outDir;
  }

  console.log(`build-tarball: precompiling packages/${pkgDirName} to ESM (packaging-time only, into ${outDir} — source untouched)`);
  const liveSrcPkgDir = join(REPO_ROOT, "packages", pkgDirName);
  ensureEmptyDir(outDir);

  // Real, independent copies — NOT the live files, NOT hardlinks (cpSync's
  // default is a genuine content copy for regular files).
  cpSync(join(liveSrcPkgDir, "src"), join(outDir, "src"), { recursive: true });
  cpSync(join(liveSrcPkgDir, "package.json"), join(outDir, "package.json"));
  cpSync(join(liveSrcPkgDir, "tsconfig.json"), join(outDir, "tsconfig.json"));

  // READ-ONLY references to the live package's resolved deps (kysely, pg,
  // pg-boss, ...) for tsc's module resolution — this process only ever
  // READS through these symlinks, nothing here writes into them. Built
  // entry-by-entry (a REAL node_modules dir of individual symlinks) rather
  // than one symlink to the whole live node_modules dir, specifically so
  // `depOverrides` (e.g. jobs -> db) can REPLACE individual entries —
  // jobs must resolve `@loombre/db` to db's already-precompiled dist/
  // output (clean, single-settings .d.ts) rather than db's raw src/*.ts
  // pulled into jobs' own compilation unit under JOBS' tsconfig, which
  // reproduced spurious cascading errors during triage (db's
  // `exactOptionalPropertyTypes: false` override is invisible to a
  // compile that pulls db's .ts source in under a DIFFERENT package's
  // tsconfig — db's own precompile, and ONLY db's own precompile, honors
  // that override). This also matches real runtime resolution: the
  // deployed jobs package will resolve @loombre/db to its precompiled
  // dist/ too (see installPrecompiledDep), so compiling against the same
  // target is correct, not just convenient.
  const nodeModulesDir = join(outDir, "node_modules");
  mkdirSync(nodeModulesDir, { recursive: true });
  // Top-level segment (e.g. "@loombre/db" -> "@loombre") of every override,
  // so a namespaced override never collides with a blanket symlink of its
  // OWN parent namespace dir below (jobs' live node_modules/@loombre is
  // itself a directory containing a "db" symlink — naively symlinking the
  // whole "@loombre" entry, then trying to mkdir "@loombre" again for the
  // override, would either throw or silently write through the original
  // live symlink chain).
  const overriddenTopLevel = new Set(Object.keys(depOverrides).map((name) => name.split("/")[0]));
  const liveNodeModules = join(liveSrcPkgDir, "node_modules");
  if (existsSync(liveNodeModules)) {
    for (const entry of readdirSync(liveNodeModules)) {
      if (overriddenTopLevel.has(entry)) continue;
      run("ln", ["-s", join(liveNodeModules, entry), join(nodeModulesDir, entry)]);
    }
  }
  for (const [name, targetDir] of Object.entries(depOverrides)) {
    mkdirSync(join(nodeModulesDir, dirname(name)), { recursive: true });
    run("ln", ["-s", targetDir, join(nodeModulesDir, name)]);
  }
  // No separate @types vendoring needed: the live node_modules mirror
  // above already includes packages/<pkgDirName>'s OWN resolved
  // devDependencies (@types/node, @types/pg, ...) exactly as pnpm laid
  // them out for the live package — unlike the app-level `pnpm deploy
  // --prod` trees, nothing here filters devDependencies out.

  // packages/jobs' tsconfig.json extends "../../tsconfig.base.json" — a
  // relative path that does not resolve from this staging directory's
  // depth. Inlined (merged into a single self-contained tsconfig.json)
  // rather than copied-alongside-and-repointed: a two-file `extends`
  // chain was tried first during triage and reproduced a TS5083 "cannot
  // read file" from the spawned tsc child even though this process's own
  // existsSync + read-back both confirmed the sibling file present with
  // the right content immediately beforehand — an inter-process
  // same-directory-sibling-file race this repo's heavy concurrent build
  // activity can apparently trigger. One self-contained file removes the
  // second file, and with it the race, entirely.
  const tsconfigPath = join(outDir, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  if (typeof tsconfig.extends === "string") {
    const base = JSON.parse(readFileSync(join(REPO_ROOT, "tsconfig.base.json"), "utf8"));
    const merged = { ...tsconfig, compilerOptions: { ...base.compilerOptions, ...tsconfig.compilerOptions } };
    delete merged.extends;
    writeFileSync(tsconfigPath, JSON.stringify(merged, null, 2) + "\n");
  }

  const distDir = join(outDir, "dist");
  rmSync(distDir, { recursive: true, force: true }); // never trust a partial/previous-config emission
  run(process.execPath, [findRepoTsc(), "-p", tsconfigPath]);
  if (!existsSync(join(distDir, "index.js"))) {
    throw new Error(`build-tarball: precompile of packages/${pkgDirName} did not produce dist/index.js`);
  }

  const pkgJsonPath = join(outDir, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  pkgJson.exports = exportsMap;
  delete pkgJson.typesVersions;
  writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

  // Drop the read-only node_modules dir (individual symlinks) and now-inert
  // TS source/config — the final tarball must never ship a symlink
  // pointing back into the build machine's own repo checkout.
  rmSync(nodeModulesDir, { recursive: true, force: true });
  for (const name of ["src", "tsconfig.json"]) {
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
  writeFileSync(markerPath, fingerprint + "\n");
  return outDir;
}

/** Replaces a deploy tree's hardlinked-to-live-source copy of a workspace
 *  dep with a real `cpSync` of the already-precompiled staging output.
 *  The delete step is safe (see the safety comment above): unlinking a
 *  directory's entries never touches data other hardlinks to the same
 *  inodes still reference elsewhere (i.e. the live packages/ tree). */
function installPrecompiledDep(deployDir, pkgSubpath, precompiledDir) {
  const linkPath = join(deployDir, "node_modules", ...pkgSubpath.split("/"));
  if (!existsSync(linkPath)) return; // this app doesn't depend on this package
  const real = realpathSync(linkPath);
  const deployDirReal = realpathSync(deployDir);
  // Defense in depth after the incident this design fixes (see the
  // safety comment above installPrecompiledDep's neighbors): NEVER delete
  // anything that doesn't resolve to somewhere inside this specific
  // isolated deploy tree, no matter what a future refactor gets wrong.
  if (!real.startsWith(deployDirReal + "/")) {
    throw new Error(
      `build-tarball: REFUSING to delete ${real} — it does not resolve inside the isolated deploy tree ${deployDirReal}. ` +
        `This guard exists specifically to prevent ever again deleting/overwriting something in the live repo.`,
    );
  }
  rmSync(real, { recursive: true, force: true });
  cpSync(precompiledDir, real, { recursive: true });
}

/** Precompiles @loombre/db and @loombre/jobs once (cached across calls via
 *  buildPrecompiledWorkspaceDep's marker file) and installs the result
 *  into one deployed app tree, if present (apps/web has neither as a
 *  dependency, so this is a no-op there). db is built FIRST because
 *  jobs' own compile is given a `depOverrides` entry pointing
 *  `@loombre/db` at db's already-precompiled dist/ output — both so jobs
 *  compiles against the same clean, single-settings .d.ts db's own
 *  precompile produces (pulling db's raw .ts source into jobs' compile
 *  unit under JOBS' tsconfig reproduced spurious cascading type errors
 *  during triage — db's tsconfig.json's `exactOptionalPropertyTypes:
 *  false` override is invisible to a compile that never uses db's own
 *  tsconfig) and because it matches real runtime resolution (the
 *  deployed jobs package resolves @loombre/db to the same precompiled
 *  dist/ too, via installPrecompiledDep below). */
function precompileRawTsDepsIn(deployDir, stagingRoot) {
  const dbDir = buildPrecompiledWorkspaceDep("db", stagingRoot, {
    exportsMap: { ".": "./dist/index.js", "./internal": "./dist/internal/index.js" },
  });
  installPrecompiledDep(deployDir, "@loombre/db", dbDir);

  const jobsDir = buildPrecompiledWorkspaceDep("jobs", stagingRoot, {
    exportsMap: { ".": "./dist/index.js" },
    depOverrides: { "@loombre/db": dbDir },
  });
  installPrecompiledDep(deployDir, "@loombre/jobs", jobsDir);
}

// ─────────────────────────────────────────────────────────────────────────
// Step: fix apps/server's missing-at-runtime `ajv` (file header point 3)
// ─────────────────────────────────────────────────────────────────────────

function fixServerAjv(serverDeployDir) {
  vendorResolvedNpmPackage("ajv", join(REPO_ROOT, "apps", "server"), join(serverDeployDir, "node_modules"));
}

// ─────────────────────────────────────────────────────────────────────────
// Step: fix apps/server's relative-path reach into packages/release-manifest
// ─────────────────────────────────────────────────────────────────────────

/**
 * apps/server/src/common/update-check/release-manifest-import.ts imports
 * @loombre/release-manifest (a FROZEN contract package) via a RELATIVE
 * path into its compiled dist (`../../../../../packages/release-manifest/dist/index.js`)
 * instead of a normal package-specifier import — a DELIBERATE, DOCUMENTED
 * choice by the release lane (see that file's own header comment): their
 * wave was also under a "lockfile frozen" constraint and couldn't add
 * "@loombre/release-manifest" to apps/server/package.json's dependencies.
 * That relative path assumes apps/server/dist sits inside the full
 * monorepo layout (repo-root/apps/server/dist/... with a sibling
 * repo-root/packages/ directory) — true in dev/CI, false once `pnpm
 * deploy` isolates apps/server into its own tree. Fixed by replicating
 * that ONE relative path's target at the equivalent depth under the
 * tarball's own stage root: stageDir/packages/release-manifest/dist/ —
 * release-manifest has zero runtime dependencies of its own (confirmed:
 * its package.json declares none), so a plain directory copy of its
 * already-built dist/ (built as an apps/server "prebuild" step per that
 * file's comment) is sufficient; nothing else to resolve. This package is
 * FROZEN (never edited by this lane) — only its own already-built output
 * is copied, read-only.
 */
function bundleReleaseManifestForServer(stageDir) {
  const src = join(REPO_ROOT, "packages", "release-manifest", "dist");
  if (!existsSync(src)) {
    throw new Error(
      `build-tarball: ${src} does not exist — apps/server's build should have produced it ` +
        `(its "prebuild" script runs tsc against packages/release-manifest/tsconfig.json; ` +
        `re-run without --skip-app-build if you skipped it)`,
    );
  }
  const dest = join(stageDir, "packages", "release-manifest", "dist");
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`build-tarball: bundled packages/release-manifest/dist (apps/server's documented relative-import workaround) -> ${dest}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Step: fix apps/worker's host-platform-only `sharp` native binary (file
// header point 4)
// ─────────────────────────────────────────────────────────────────────────

async function fixWorkerSharp(workerDeployDir, arch) {
  const sharpLink = join(workerDeployDir, "node_modules", "sharp");
  if (!existsSync(sharpLink)) {
    console.warn("build-tarball: apps/worker has no node_modules/sharp — skipping the sharp platform-binary fix (dependency removed upstream?)");
    return;
  }
  const sharpReal = realpathSync(sharpLink);
  // DERIVE the versions from the actually-resolved sharp rather than
  // hardcoding them (Wave-3 install-smoke finding D1: a hardcoded 0.34.5
  // silently desynced when G1 bumped sharp to ^0.35.3 for a libvips CVE,
  // which would fetch the WRONG native binary). sharp pins the exact
  // @img/sharp-libvips-* version it needs in its own optionalDependencies.
  const sharpPkg = JSON.parse(readFileSync(join(sharpReal, "package.json"), "utf8"));
  const sharpVersion = sharpPkg.version;
  const libvipsPkgName = `@img/sharp-libvips-linux-${arch}`;
  const sharpLibvipsVersion = sharpPkg.optionalDependencies?.[libvipsPkgName];
  if (!sharpVersion || !sharpLibvipsVersion) {
    throw new Error(
      `build-tarball: could not derive sharp/libvips versions from ${sharpReal}/package.json ` +
        `(version=${sharpVersion}, ${libvipsPkgName}=${sharpLibvipsVersion}) — sharp's package layout changed; update fixWorkerSharp.`,
    );
  }
  console.log(`build-tarball: resolved sharp ${sharpVersion} + ${libvipsPkgName}@${sharpLibvipsVersion} (derived, not hardcoded)`);
  const imgNodeModules = join(sharpReal, "node_modules"); // sharp's own node_modules — @img/* siblings live here
  const imgDir = join(imgNodeModules, "@img");

  // Remove whatever platform variant `pnpm deploy` materialized for the
  // BUILD HOST (e.g. @img/sharp-darwin-arm64 when building on this Mac) —
  // wrong platform, dead weight, never loadable at runtime on Linux.
  if (existsSync(imgDir)) {
    for (const entry of readdirSync(imgDir)) {
      if (entry.startsWith("sharp-")) {
        rmSync(join(imgDir, entry), { recursive: true, force: true });
        console.log(`build-tarball: removed build-host sharp binary package @img/${entry} (wrong platform for the shipped tarball)`);
      }
    }
  }

  await vendorPinnedPlatformNpmPackage(`@img/sharp-linux-${arch}`, sharpVersion, imgNodeModules);
  await vendorPinnedPlatformNpmPackage(`@img/sharp-libvips-linux-${arch}`, sharpLibvipsVersion, imgNodeModules);
}

// ─────────────────────────────────────────────────────────────────────────
// Step: fix @napi-rs/keyring's host-platform-only native binding (same
// disease as sharp, file header point 4). Both deployed apps load
// @loombre/secrets at boot — apps/server resolves the JWT secret store in
// main.ts, and apps/worker reads UI-entered provider keys through the
// keyring (Addendum A / A9, 29d1b54) — so BOTH deploy dirs need the
// linux binding `pnpm deploy` on a non-Linux build host can never
// materialize. Found by the post-A9 tarball smoke: server and worker both
// crash-looped on `Cannot find module '@napi-rs/keyring-linux-<arch>-gnu'`
// (this smoke had not been re-run between A9 landing and the rename run).
// ─────────────────────────────────────────────────────────────────────────

async function fixKeyringBinding(deployDir, arch, appLabel) {
  // @napi-rs/keyring is a TRANSITIVE dep (via @loombre/secrets), so unlike
  // sharp it is NOT linked at the deploy dir's top-level node_modules —
  // it only exists inside the deploy's .pnpm store
  // (node_modules/.pnpm/@napi-rs+keyring@<v>/node_modules/@napi-rs/keyring,
  // exactly the path in the smoke's crash stack). Resolve it there.
  const topLevelLink = join(deployDir, "node_modules", "@napi-rs", "keyring");
  let keyringReal;
  if (existsSync(topLevelLink)) {
    keyringReal = realpathSync(topLevelLink);
  } else {
    const pnpmDir = join(deployDir, "node_modules", ".pnpm");
    const storeEntry = existsSync(pnpmDir)
      ? readdirSync(pnpmDir).find((e) => e.startsWith("@napi-rs+keyring@"))
      : undefined;
    if (!storeEntry) {
      console.warn(
        `build-tarball: ${appLabel} has no @napi-rs/keyring anywhere in its deploy tree — skipping the keyring platform-binding fix (dependency removed upstream?)`,
      );
      return;
    }
    keyringReal = join(pnpmDir, storeEntry, "node_modules", "@napi-rs", "keyring");
  }
  // DERIVE the binding version from the actually-resolved keyring package's
  // own optionalDependencies (the sharp lesson: never hardcode — a bumped
  // parent would silently fetch the wrong binding).
  const keyringPkg = JSON.parse(readFileSync(join(keyringReal, "package.json"), "utf8"));
  const bindingName = `@napi-rs/keyring-linux-${arch}-gnu`;
  const bindingVersion = keyringPkg.optionalDependencies?.[bindingName] ?? keyringPkg.version;
  if (!bindingVersion) {
    throw new Error(
      `build-tarball: could not derive the ${bindingName} version from ${keyringReal}/package.json — @napi-rs/keyring's layout changed; update fixKeyringBinding.`,
    );
  }
  console.log(`build-tarball: resolved @napi-rs/keyring ${keyringPkg.version} -> ${bindingName}@${bindingVersion} (derived, not hardcoded)`);

  // Drop whatever binding `pnpm deploy` materialized for the BUILD HOST
  // (e.g. @napi-rs/keyring-darwin-arm64 on this Mac) — wrong platform,
  // dead weight, never loadable on Linux. Bindings resolve as SIBLINGS of
  // the keyring package: from keyring/index.js, require() finds them first
  // in keyring's own node_modules, which is exactly where we vendor.
  const napiRsDir = dirname(keyringReal); // .../node_modules/@napi-rs
  for (const entry of readdirSync(napiRsDir)) {
    if (entry.startsWith("keyring-")) {
      rmSync(join(napiRsDir, entry), { recursive: true, force: true });
      console.log(`build-tarball: removed build-host keyring binding @napi-rs/${entry} (wrong platform for the shipped tarball)`);
    }
  }

  await vendorPinnedPlatformNpmPackage(bindingName, bindingVersion, join(keyringReal, "node_modules"));
}

// ─────────────────────────────────────────────────────────────────────────
// Step: bundled Node runtime (installers/linux/node-manifest.json)
// ─────────────────────────────────────────────────────────────────────────

function loadNodeManifest() {
  return JSON.parse(readFileSync(join(INSTALLERS_LINUX_DIR, "node-manifest.json"), "utf8"));
}

async function fetchAndExtractNode(arch, cacheDir) {
  const manifest = loadNodeManifest();
  const platformKey = arch === "arm64" ? "linux-arm64" : "linux-x64";
  const entry = manifest.platforms[platformKey];
  if (!entry) throw new Error(`build-tarball: no node-manifest.json entry for ${platformKey}`);

  const extractedRoot = join(cacheDir, entry.archiveRootDir);
  const nodeBinPath = join(extractedRoot, "bin", "node");
  if (existsSync(nodeBinPath)) {
    console.log(`build-tarball: bundled node already cached at ${nodeBinPath} — skipping download`);
    return nodeBinPath;
  }

  mkdirSync(cacheDir, { recursive: true });
  console.log(`build-tarball: downloading Node ${manifest.nodeVersion} (${platformKey})`);
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`build-tarball: GET ${entry.url} -> HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const check = verifyChecksum(buffer, entry.sha256);
  if (!check.ok) {
    throw new Error(
      `build-tarball: CHECKSUM MISMATCH for bundled Node runtime ${entry.url}\n` +
        `  expected: ${check.expected}\n  actual:   ${check.actual}\n  Refusing to bundle a tampered/corrupted Node runtime.`,
    );
  }

  const tmpArchive = join(cacheDir, basename(entry.url));
  writeFileSync(tmpArchive, buffer);
  run("tar", ["-xJf", tmpArchive, "-C", cacheDir]);
  rmSync(tmpArchive, { force: true });

  if (!existsSync(nodeBinPath)) {
    throw new Error(`build-tarball: expected ${nodeBinPath} after extracting the Node archive, not found`);
  }
  return nodeBinPath;
}

// ─────────────────────────────────────────────────────────────────────────
// Step: ffmpeg (scripts/fetch-ffmpeg.mjs — deliverable 1, reused as-is)
// ─────────────────────────────────────────────────────────────────────────

function fetchFfmpeg(platformKey) {
  run(process.execPath, [join(REPO_ROOT, "scripts", "fetch-ffmpeg.mjs"), "--platform", platformKey]);
  return join(REPO_ROOT, "vendor", "ffmpeg", platformKey);
}

// ─────────────────────────────────────────────────────────────────────────
// Step: embedded PG placeholder (lane B's deliverable — scripts/fetch-embedded-pg.mjs)
// ─────────────────────────────────────────────────────────────────────────

function assemblePg(stageDir, arch) {
  const pgFetchScript = join(REPO_ROOT, "scripts", "fetch-embedded-pg.mjs");
  const pgDir = join(stageDir, "pg");
  mkdirSync(pgDir, { recursive: true });
  const platformKey = `linux-${arch}`;
  if (existsSync(pgFetchScript)) {
    console.log("build-tarball: scripts/fetch-embedded-pg.mjs found — invoking it for the embedded PG payload (lane B)");
    // Mirrors scripts/fetch-ffmpeg.mjs's own CLI shape exactly (same
    // author convention, confirmed via --help): --platform + a
    // vendor/embedded-pg/<platform> output dir, no --out-dir flag — copy
    // its vendored output into the tarball ourselves, same as ffmpeg below.
    run(process.execPath, [pgFetchScript, "--platform", platformKey]);
    const pgVendorDir = join(REPO_ROOT, "vendor", "embedded-pg", platformKey);
    if (existsSync(pgVendorDir)) {
      cpSync(pgVendorDir, pgDir, { recursive: true });
      console.log(`build-tarball: embedded PG payload copied from ${pgVendorDir}`);
      return;
    }
    console.warn(`build-tarball: fetch-embedded-pg.mjs ran but ${pgVendorDir} was not produced — falling back to placeholder README`);
  }
  writeFileSync(
    join(pgDir, "README.md"),
    "# Embedded PostgreSQL — placeholder\n\n" +
      "This directory is where lane B's embedded-PostgreSQL binaries (STATE.md P4.2,\n" +
      "`scripts/fetch-embedded-pg.mjs`) belong. Either that script did not exist yet\n" +
      "when this tarball was built, or it ran but did not produce a\n" +
      "vendor/embedded-pg/<platform> payload for this platform/arch — either way this\n" +
      "is an empty placeholder: install.sh's default posture is the EXTERNAL-Postgres\n" +
      "path (P4.2 — DATABASE_URL env var, `provisioning-status: external`), which\n" +
      "needs nothing here at all.\n\n" +
      "Re-run installers/linux/build-tarball.mjs once scripts/fetch-embedded-pg.mjs\n" +
      "produces vendor/embedded-pg/linux-<arch>/ — it is called automatically (see\n" +
      "assemblePg() in build-tarball.mjs) and this README is replaced by the real\n" +
      "embedded-PG payload.\n",
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Step: bin/ wrapper scripts
// ─────────────────────────────────────────────────────────────────────────

function writeWrapperScripts(stageDir) {
  const binDir = join(stageDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const common = `#!/usr/bin/env bash
# Generated by installers/linux/build-tarball.mjs — do not edit by hand.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
APP_ROOT="$(cd "\${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
NODE_BIN="\${APP_ROOT}/runtime/node/bin/node"
export LOOMBRE_FFMPEG="\${APP_ROOT}/ffmpeg/ffmpeg"
export LOOMBRE_FFPROBE="\${APP_ROOT}/ffmpeg/ffprobe"
export PATH="\${APP_ROOT}/ffmpeg:\${PATH}"
# Pin a deterministic, WRITABLE cwd before exec — apps/server's
# AnomalyLogService defaults LOOMBRE_AUTH_LOG_FILE to "<process.cwd()>/logs/..."
# when unset (found by the container smoke test: a bare invocation with no
# explicit cwd inherited "/", producing an EACCES trying to mkdir "/logs"
# as the unprivileged loombre user). systemd's own WorkingDirectory=
# (installers/linux/systemd/*.template) already pins this for the
# systemd-managed path; this covers --no-systemd / manual invocation too,
# and is intentionally the DATA dir (writable under both plain use and the
# hardened unit's ProtectSystem=strict + ReadWritePaths=<data dir>) rather
# than APP_ROOT (read-only under that same hardening).
if [ -n "\${LOOMBRE_DATA_DIR:-}" ]; then
  cd "\${LOOMBRE_DATA_DIR}"
fi
`;

  writeFileSync(
    join(binDir, "loombre-server"),
    common + `exec "\${NODE_BIN}" "\${APP_ROOT}/lib/server/dist/main.js" "$@"\n`,
  );
  writeFileSync(
    join(binDir, "loombre-worker"),
    common + `exec "\${NODE_BIN}" "\${APP_ROOT}/lib/worker/dist/index.js" "$@"\n`,
  );
  chmodSync(join(binDir, "loombre-server"), 0o755);
  chmodSync(join(binDir, "loombre-worker"), 0o755);
}

// ─────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────

async function assembleTarball(args) {
  const version = args.version ?? readRepoVersion();
  const arch = args.arch;
  const platformKey = ffmpegPlatformKey(arch);
  const tarballName = `loombre-${version}-linux-${arch}`;

  const buildRoot = join(INSTALLERS_LINUX_DIR, ".build");
  const cacheDir = join(buildRoot, "cache");
  const stageDir = join(buildRoot, "stage", tarballName);
  const precompiledDepsDir = join(cacheDir, "precompiled-workspace-deps");
  mkdirSync(buildRoot, { recursive: true });
  ensureEmptyDir(stageDir);

  console.log(`\n=== build-tarball: ${tarballName} ===\n`);

  if (!args.skipAppBuild) {
    console.log("--- building apps/server, apps/worker, apps/web ---");
    pnpmBuild("@loombre/server");
    pnpmBuild("@loombre/worker");
    pnpmBuild("@loombre/web");
  }

  console.log("--- deploying apps/server ---");
  const serverDeployDir = join(stageDir, "lib", "server");
  pnpmDeploy("@loombre/server", serverDeployDir);
  precompileRawTsDepsIn(serverDeployDir, precompiledDepsDir);
  fixServerAjv(serverDeployDir);
  await fixKeyringBinding(serverDeployDir, arch, "apps/server");
  bundleReleaseManifestForServer(stageDir);
  pruneDeployedAppDir(serverDeployDir);

  console.log("--- deploying apps/worker ---");
  const workerDeployDir = join(stageDir, "lib", "worker");
  pnpmDeploy("@loombre/worker", workerDeployDir);
  precompileRawTsDepsIn(workerDeployDir, precompiledDepsDir);
  await fixWorkerSharp(workerDeployDir, arch);
  await fixKeyringBinding(workerDeployDir, arch, "apps/worker");
  pruneDeployedAppDir(workerDeployDir);

  console.log("--- deploying apps/web ---");
  const webDeployDir = join(stageDir, "web");
  pnpmDeploy("@loombre/web", webDeployDir);
  // apps/web has no raw-TS workspace deps of its own (@loombre/sdk already
  // ships compiled dist — see LAYOUT.md), so no precompile step here.
  pruneDeployedAppDir(webDeployDir);

  console.log("--- bundling Node runtime ---");
  const nodeBinPath = await fetchAndExtractNode(arch, cacheDir);
  const nodeRuntimeDir = join(stageDir, "runtime", "node", "bin");
  mkdirSync(nodeRuntimeDir, { recursive: true });
  cpSync(nodeBinPath, join(nodeRuntimeDir, "node"));
  chmodSync(join(nodeRuntimeDir, "node"), 0o755);

  console.log("--- bundling ffmpeg/ffprobe ---");
  if (!args.skipFetchFfmpeg) fetchFfmpeg(platformKey);
  const ffmpegVendorDir = join(REPO_ROOT, "vendor", "ffmpeg", platformKey);
  const ffmpegStageDir = join(stageDir, "ffmpeg");
  mkdirSync(ffmpegStageDir, { recursive: true });
  for (const name of ["ffmpeg", "ffprobe", "LICENSE.txt"]) {
    const src = join(ffmpegVendorDir, name);
    if (existsSync(src)) cpSync(src, join(ffmpegStageDir, name));
  }
  chmodSync(join(ffmpegStageDir, "ffmpeg"), 0o755);
  chmodSync(join(ffmpegStageDir, "ffprobe"), 0o755);

  console.log("--- embedded PG placeholder / lane B payload ---");
  assemblePg(stageDir, arch);

  console.log("--- writing bin/ wrappers + VERSION ---");
  writeWrapperScripts(stageDir);
  writeFileSync(join(stageDir, "VERSION"), version + "\n");

  console.log("--- bundling install.sh / uninstall.sh / systemd units ---");
  for (const name of ["install.sh", "uninstall.sh"]) {
    cpSync(join(INSTALLERS_LINUX_DIR, name), join(stageDir, name));
    chmodSync(join(stageDir, name), 0o755);
  }
  cpSync(join(INSTALLERS_LINUX_DIR, "systemd"), join(stageDir, "systemd"), { recursive: true });

  console.log("--- packaging tarball ---");
  mkdirSync(args.outDir, { recursive: true });
  const outputPath = join(args.outDir, `${tarballName}.tar.gz`);
  rmSync(outputPath, { force: true });
  run("tar", ["-czf", outputPath, "-C", join(stageDir, ".."), tarballName]);

  console.log("--- sign hook (P4.1 unsigned posture, no-op) ---");
  run(process.execPath, [join(REPO_ROOT, "installers", "sign-hook.mjs"), outputPath]);

  const sha256 = sha256File(outputPath);
  const sizeBytes = statSync(outputPath).size;
  console.log(`\n=== build-tarball: DONE ===`);
  console.log(`artifact: ${outputPath}`);
  console.log(`sizeBytes: ${sizeBytes}`);
  console.log(`sha256: ${sha256}`);

  return { outputPath, sha256, sizeBytes, version, arch };
}

const isDirectEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntrypoint) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node installers/linux/build-tarball.mjs [--version <semver>] [--arch x64|arm64] " +
        "[--out-dir <dir>] [--skip-app-build] [--skip-fetch-ffmpeg]",
    );
    process.exit(0);
  }
  assembleTarball(args).catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}

export { assembleTarball };
