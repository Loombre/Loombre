#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/build-pkg.mjs
//
// Orchestrates the whole macOS .pkg build, end to end, runnable on this
// host with native tooling only (swiftc/swift, pkgbuild, productbuild —
// all Apple-provided, nothing installed). See installers/macos/LAYOUT.md
// for every layout/rationale decision this script encodes.
//
// Usage:
//   node installers/macos/build-pkg.mjs [--arch=arm64|x64] [--smoke]
//
// LOCKFILE FROZEN this wave — this script never runs `pnpm add`/`pnpm
// install` against the workspace lockfile. `pnpm deploy` (used below) does
// not modify pnpm-lock.yaml; it materializes a deployment from what the
// lockfile already resolved.
//
// IMPORTANT (see LAYOUT.md §9): `pnpm deploy --legacy` HARDLINKS files
// cloned from its content-addressable store for workspace (`file:`)
// dependencies on this filesystem. Never edit a file inside a deploy
// output in place (`fs.writeFileSync` on an existing path truncates the
// existing inode — which may be shared with the live repo checkout).
// Always unlink first. `safeRewriteFile` below is the only way this
// script ever mutates a deploy output file, for exactly this reason.

import {
  existsSync, mkdirSync, rmSync, cpSync, chmodSync, writeFileSync, readFileSync,
  unlinkSync, symlinkSync, readdirSync, statSync, renameSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const LANE_DIR = __dirname; // installers/macos
const PKG_DIR = path.join(LANE_DIR, "pkg");
const MENUBAR_DIR = path.join(LANE_DIR, "menubar");
const BUILD_CACHE = path.join(LANE_DIR, ".build-cache");
const DIST_OUT = path.join(LANE_DIR, "dist");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const ARCH = flag("arch", process.arch === "arm64" ? "arm64" : "x64");
const DO_SMOKE = has("smoke");
const SKIP_WORKSPACE_BUILD = has("skip-workspace-build");
const SKIP_SWIFT = has("skip-swift");

if (ARCH !== "arm64" && ARCH !== "x64") {
  throw new Error(`--arch must be arm64 or x64, got ${ARCH}`);
}

function log(msg) {
  console.log(`\n[build-pkg] ${msg}`);
}

function run(cmd, cmdArgs, opts = {}) {
  log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  // NEVER set CI=true (or otherwise auto-confirm) here. This lane hit a
  // real incident during its own development: pnpm, on a shared
  // multi-lane checkout with an in-flux pnpm-lock.yaml, decided a
  // workspace-wide dependency reconciliation was needed before running a
  // script and — with CI=true set — silently proceeded to PRUNE ~600
  // packages' worth of hoisted devDependency symlinks from the shared
  // root node_modules (every other concurrently-running lane's node_modules
  // too), because CI=true bypasses pnpm's own
  // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY safety guard. That guard
  // existing and firing is CORRECT behavior on a shared checkout — this
  // script must never disable it. Recovered via `rm -rf node_modules &&
  // pnpm install --frozen-lockfile` (verified: pnpm-lock.yaml diff
  // unchanged before/after, all 793 top-level + workspace-resolved
  // packages restored). Flagged in the final report as a process lesson
  // for every lane running automated pnpm commands against this shared
  // wave's checkout.
  const res = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: REPO_ROOT, ...opts });
  if (res.status !== 0) {
    throw new Error(`command failed (${res.status}): ${cmd} ${cmdArgs.join(" ")}`);
  }
}

function readVersion() {
  // P4.11 (STATE.md): lane I owns real single-source build-time version
  // injection; not landed yet. Reads the same file it will eventually
  // stamp — see LAYOUT.md §5.
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.version;
}

/** The only way this script ever mutates a `pnpm deploy` output file —
 *  see the module header. Unlinks first so a hardlinked source is never
 *  touched, regardless of pnpm's import strategy on this filesystem. */
function safeRewriteFile(filePath, content) {
  if (existsSync(filePath)) unlinkSync(filePath);
  writeFileSync(filePath, content, "utf8");
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

// ---------------------------------------------------------------------
// 1. Workspace build (server + worker + their dependency closure)
//
// Builds each package INDIVIDUALLY, in dependency order, via a DIRECT
// `tsc -p <package>/tsconfig.json` — deliberately never `pnpm run build`
// or any other `pnpm` subcommand that runs a package.json script. THIS IS
// A SHARED, MULTI-LANE CHECKOUT (Phase 4 Wave 1 runs many lanes
// concurrently against the same working tree, STATE.md's lane burn-up
// table) and this lane hit two distinct, reproduced problems live during
// its own development, both stemming from that:
//
//   1. A concurrent lane's in-flight edit left packages/jobs/tsconfig.json
//      transiently broken (`extends` pointing at a path that did not yet
//      exist) — not this lane's file to touch, not a permanent break.
//   2. FAR MORE SERIOUS: `pnpm run <script>` (and even `pnpm install`)
//      intermittently triggers pnpm's own pre-script "deps status check"
//      against the concurrently-edited pnpm-lock.yaml (lane F is this
//      wave's sole lockfile owner and is actively landing changes to it).
//      When that check observes lock drift, it tries to auto-heal via
//      `pnpm install --production` and — without a real TTY — aborts on
//      an interactive confirmation
//      (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). Reproduced multiple
//      times, non-deterministically, across ordinary `pnpm --filter <pkg>
//      run build` calls that had worked moments earlier. **Once, before
//      this script stopped ever setting CI=true to unblock that prompt,
//      the auto-heal actually ran and pruned ~600 packages' worth of
//      hoisted devDependency symlinks from the SHARED root node_modules —
//      every other concurrently-running lane's node_modules too.**
//      Recovered via `rm -rf node_modules && pnpm install
//      --frozen-lockfile` (verified: pnpm-lock.yaml diff unchanged
//      before/after). Full incident + the fix is documented on run()'s
//      own header; this comment is the follow-up hardening: eliminate the
//      trigger entirely by never running a pnpm subcommand that can
//      invoke that check for anything this script can build directly
//      instead. (`pnpm deploy`, used later in this file, has not
//      reproduced the issue — kept as-is; it is not a plain `pnpm run`.)
// ---------------------------------------------------------------------
function buildWorkspace() {
  if (SKIP_WORKSPACE_BUILD) {
    log("skipping workspace build (--skip-workspace-build)");
    return;
  }

  log("building workspace dependency closure package-by-package via direct tsc (never `pnpm run` — see comment above)");

  // Packages with their own intact, self-contained tsconfig.json.
  for (const pkgRelDir of ["packages/shared", "packages/playback-engine", "packages/provisioning", "packages/sdk"]) {
    run("npx", ["tsc", "-p", path.join(REPO_ROOT, pkgRelDir, "tsconfig.json")]);
  }

  // packages/db: self-contained tsconfig.json (no `extends`) — but
  // package.json `exports` still points at src/ (LAYOUT.md §9), so
  // deployApp() patches the DEPLOYED copy afterward. This just needs
  // dist/ to exist.
  log("compiling packages/db to dist/ (LAYOUT.md §9: no build script wired to its exports)");
  run("npx", ["tsc", "-p", "packages/db/tsconfig.json"]);

  // packages/jobs: SCRATCH tsconfig, deliberately never reads the live
  // packages/jobs/tsconfig.json (reason 1 above) — mirrors its
  // last-known-good content (extends root tsconfig.base.json + { outDir:
  // dist, rootDir: src, declaration: true, types: [node] }, include: src)
  // with everything resolved to absolute paths, fully decoupled from that
  // file's live state.
  log("compiling packages/jobs to dist/ via a scratch tsconfig (decoupled from its live tsconfig.json)");
  compileJobsWithScratchConfig();

  // packages/release-manifest: apps/server's own (pnpm-script-based)
  // prebuild step normally builds this first — replicated directly here
  // since this function never invokes pnpm scripts (reason 2 above).
  log("compiling packages/release-manifest to dist/ (normally apps/server's own prebuild step)");
  run("npx", ["tsc", "-p", path.join(REPO_ROOT, "packages", "release-manifest", "tsconfig.json")]);

  // apps/server, apps/worker: their own tsconfig.json is intact; all
  // their workspace dependencies now have real dist/ output on disk.
  log("building @loombre/server and @loombre/worker (deps already built above)");
  run("npx", ["tsc", "-p", path.join(REPO_ROOT, "apps", "server", "tsconfig.json")]);
  run("npx", ["tsc", "-p", path.join(REPO_ROOT, "apps", "worker", "tsconfig.json")]);

  // apps/web: Next.js production build — installer completeness audit
  // (gap 1): the workspace build built server + worker but NEVER the web
  // app, so earlier payloads shipped no UI at all (the readme even pointed
  // users at :3001, the API). Invoked as a DIRECT `npx next build` with
  // cwd=apps/web — the same never-`pnpm run` rationale as every tsc call
  // above (npx resolves apps/web/node_modules/.bin/next without ever
  // invoking pnpm's pre-script deps-status check). `--webpack` matches
  // apps/web's own build script byte-for-byte (Turbopack lacks
  // extensionAlias — see next.config.mjs's header). next.config.mjs's
  // `output: "standalone"` makes this produce the self-contained
  // .next/standalone tree stageWeb() stages into the payload. Workspace
  // deps (@loombre/sdk, @loombre/shared, @loombre/playback-engine) were
  // built by the tsc loop above, so ordering here is load-bearing.
  log("building @loombre/web (npx next build --webpack; output: standalone per next.config.mjs)");
  run("npx", ["next", "build", "--webpack"], { cwd: path.join(REPO_ROOT, "apps", "web") });
}

function compileJobsWithScratchConfig() {
  const jobsDir = path.join(REPO_ROOT, "packages", "jobs");
  const scratchConfig = {
    extends: path.join(REPO_ROOT, "tsconfig.base.json"),
    compilerOptions: {
      outDir: path.join(jobsDir, "dist"),
      rootDir: path.join(jobsDir, "src"),
      declaration: true,
      types: ["node"],
      // tsc resolves `types` against a `typeRoots`/node_modules lookup
      // from the tsconfig's OWN directory by default; this scratch file
      // lives in .build-cache, not packages/jobs, so `@types/node` needs
      // an explicit typeRoots pointing back at the real package's
      // node_modules (and the repo root's, where @types/node is hoisted).
      typeRoots: [
        path.join(jobsDir, "node_modules", "@types"),
        path.join(REPO_ROOT, "node_modules", "@types"),
      ],
    },
    include: [path.join(jobsDir, "src", "**", "*.ts")],
  };
  const scratchPath = path.join(BUILD_CACHE, "packages-jobs.scratch-tsconfig.json");
  mkdirSync(BUILD_CACHE, { recursive: true });
  writeFileSync(scratchPath, JSON.stringify(scratchConfig, null, 2), "utf8");
  run("npx", ["tsc", "-p", scratchPath]);
}

// ---------------------------------------------------------------------
// 2. `pnpm deploy` server + worker into pruned, self-contained dirs
// ---------------------------------------------------------------------
function deployApp(pkgName, outDirName) {
  const rawDeployDir = path.join(BUILD_CACHE, "deploy-raw", outDirName);
  rmSync(rawDeployDir, { recursive: true, force: true });
  mkdirSync(path.dirname(rawDeployDir), { recursive: true });

  log(`pnpm deploy ${pkgName} -> ${rawDeployDir}`);
  run("pnpm", ["--filter", pkgName, "deploy", rawDeployDir, "--prod", "--legacy"]);

  // Patch @loombre/db + @loombre/jobs's deployed package.json to point at
  // dist/ instead of src/*.ts — see LAYOUT.md §9. Walk defensively rather
  // than hardcoding the .pnpm virtual-store hash path (it's derived from
  // the workspace's relative path + a content hash, not guaranteed stable
  // across pnpm versions).
  let patched = 0;
  walk(path.join(rawDeployDir, "node_modules"), (filePath) => {
    if (path.basename(filePath) !== "package.json") return;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return;
    }
    if (manifest.name !== "@loombre/db" && manifest.name !== "@loombre/jobs") return;
    if (typeof manifest.exports !== "object" || manifest.exports === null) return;

    const pkgRoot = path.dirname(filePath);
    let changed = false;
    for (const [key, value] of Object.entries(manifest.exports)) {
      if (typeof value !== "string" || !value.includes("/src/")) continue;
      const rewritten = value.replace("/src/", "/dist/").replace(/\.ts$/, ".js");
      if (!existsSync(path.join(pkgRoot, rewritten))) {
        throw new Error(
          `${manifest.name}: expected compiled output at ${rewritten} (from ${value}) but it doesn't ` +
            `exist under ${pkgRoot} — did the tsc build step run/succeed?`,
        );
      }
      manifest.exports[key] = rewritten;
      changed = true;
    }
    if (changed) {
      safeRewriteFile(filePath, JSON.stringify(manifest, null, 2));
      patched++;
    }
  });
  if (patched > 0) {
    log(`patched ${patched} deployed package.json export map(s) (@loombre/db, @loombre/jobs) to point at dist/`);
  } else {
    // Not fatal: LAYOUT.md §9's workaround is only needed while
    // @loombre/db / @loombre/jobs ship src-pointing exports. If upstream
    // has since fixed that (worth checking for on every rerun — this
    // lane recommends exactly that fix), there's nothing to patch and
    // that's success, not failure. The actual invariant that matters —
    // the deployed app resolves and boots — is proven by smoke.mjs.
    log(
      "no @loombre/db / @loombre/jobs exports needed patching — either they now ship dist-pointing exports " +
        "upstream (LAYOUT.md §9's workaround would then be obsolete) or this deploy has no such dependency.",
    );
  }

  // apps/server-only: ajv is a *runtime* dependency (device-profile
  // validation) miscategorized as devDependency — `--prod` omits it.
  // Vendor in the exact resolved version already pinned in
  // pnpm-lock.yaml for apps/server's own devDependencies entry (NOT a
  // fresh/unpinned fetch) — see LAYOUT.md §9.
  if (pkgName === "@loombre/server") {
    const ajvSourceDir = path.join(REPO_ROOT, "apps", "server", "node_modules", "ajv");
    if (!existsSync(ajvSourceDir)) {
      throw new Error(
        "deployApp(@loombre/server): apps/server/node_modules/ajv not found — run `pnpm install` first, " +
          "or apps/server no longer depends on ajv (update LAYOUT.md §9 + this script together).",
      );
    }
    // ajv resolves its own transitive deps (fast-deep-equal, fast-uri,
    // json-schema-traverse, require-from-string) as SIBLINGS in its own
    // `.pnpm/ajv@<version>/node_modules/` level, not nested under
    // `ajv/node_modules` — copying just the `ajv` dir loses them (found
    // and fixed during this lane's own smoke-testing). Copy the whole
    // sibling level, flattened into the deploy's top-level node_modules.
    const ajvRealPath = spawnSync("readlink", ["-f", ajvSourceDir], { encoding: "utf8" }).stdout.trim();
    const ajvSiblingLevel = path.dirname(ajvRealPath); // .../.pnpm/ajv@X/node_modules/
    const deployNodeModules = path.join(rawDeployDir, "node_modules");
    for (const entry of readdirSync(ajvSiblingLevel, { withFileTypes: true })) {
      const src = path.join(ajvSiblingLevel, entry.name);
      const dest = path.join(deployNodeModules, entry.name);
      rmSync(dest, { recursive: true, force: true });
      cpSync(src, dest, { recursive: true, dereference: true });
    }
    log(`vendored ajv + its ${readdirSync(ajvSiblingLevel).length - 1} resolved transitive deps into the server deploy`);
  }

  // Prune to exactly {dist, node_modules, package.json} — no src/test/
  // vitest.config.ts/.turbo in the shipped payload (LAYOUT.md §1).
  const prunedDir = path.join(BUILD_CACHE, "deploy", outDirName);
  rmSync(prunedDir, { recursive: true, force: true });
  mkdirSync(prunedDir, { recursive: true });
  for (const keep of ["dist", "node_modules", "package.json"]) {
    const src = path.join(rawDeployDir, keep);
    if (!existsSync(src)) throw new Error(`deployApp(${pkgName}): expected ${keep} in deploy output, missing`);
    // verbatimSymlinks: pnpm's deploy layout links packages into .pnpm
    // with RELATIVE symlinks — exactly what lane I1's tarball ships (717
    // relative links, boots on real machines). cpSync's DEFAULT rewrites
    // every link target to an ABSOLUTE build-machine path — the
    // v0.9.0-rc.1 installed tree pointed at /Users/runner/... and the
    // server crash-looped on ERR_MODULE_NOT_FOUND. (dereference: true is
    // NOT the fix: measured on this tree, it copies nested directory
    // symlinks as links and STILL rewrites them absolute.) Relative
    // links survive pkgbuild/BOM and relocate cleanly.
    cpSync(src, path.join(prunedDir, keep), { recursive: true, verbatimSymlinks: true });
  }
  const sizeMb = duSizeMb(prunedDir);
  log(`${outDirName} deploy pruned to dist+node_modules+package.json (${sizeMb} MB)`);
  return prunedDir;
}

function duSizeMb(dir) {
  const res = spawnSync("du", ["-sm", dir], { encoding: "utf8" });
  return res.stdout.trim().split(/\s+/)[0];
}

// ---------------------------------------------------------------------
// 3. Menubar (Swift)
// ---------------------------------------------------------------------
function buildMenubar() {
  if (SKIP_SWIFT) {
    log("skipping swift build (--skip-swift)");
    return;
  }
  // Builds @loombre/controller-ipc's dist directly via tsc — deliberately
  // NOT `pnpm --filter @loombre/controller-ipc run build`. On this shared,
  // concurrently-edited checkout (see run()'s own header for the more
  // serious incident this is a smaller cousin of), ANY `pnpm run`/`pnpm
  // install` invocation can intermittently trigger pnpm's own "deps
  // status check" pre-script hook, which — whenever it happens to observe
  // pnpm-lock.yaml mid-edit by the concurrent lockfile-owning lane — may
  // decide the workspace needs a `pnpm install --production` reconcile
  // and then abort on the no-TTY confirmation prompt (a real, reproduced
  // race, not hypothetical). A direct `tsc -p` compile touches nothing
  // but this one package's own dist/ and never invokes pnpm's installer
  // at all, so it cannot hit that race.
  run("npx", ["tsc", "-p", path.join(REPO_ROOT, "packages", "controller-ipc", "tsconfig.json")]);

  log("verifying menubar/fixtures.json against @loombre/controller-ipc's real schemas");
  run("node", [path.join(MENUBAR_DIR, "verify-fixtures.mjs")], { cwd: REPO_ROOT });

  // P4.11 single-source version: regenerate GeneratedVersion.swift from
  // root package.json so the menu's "Loombre Controller vX" can never
  // drift from the release again (a real install showed v0.0.1).
  const version = readVersion();
  writeFileSync(
    path.join(MENUBAR_DIR, "Sources", "LoombreMenubar", "GeneratedVersion.swift"),
    `// SPDX-License-Identifier: AGPL-3.0-only\n// GENERATED at pkg-build time by installers/macos/build-pkg.mjs\n// (buildMenubar) from root package.json — do not hand-edit the version.\n// The checked-in value is a dev placeholder for bare \`swift build\` runs;\n// build-pkg.mjs overwrites it before every release build and \`git\n// checkout\`-restores nothing (the file is committed with the placeholder).\n\nlet loombreGeneratedVersion = "${version}"\n`,
    "utf8",
  );
  log(`stamped GeneratedVersion.swift = ${version}`);

  log("swift build -c release (LoombreMenubar)");
  run("swift", ["build", "-c", "release"], { cwd: MENUBAR_DIR });

  log("swift test (LoombreIPCKit unit tests)");
  run("swift", ["test"], { cwd: MENUBAR_DIR });
}

function assembleAppBundle(payloadRoot) {
  const binPath = path.join(MENUBAR_DIR, ".build", "release", "LoombreMenubar");
  if (!existsSync(binPath)) {
    throw new Error(`assembleAppBundle: ${binPath} missing — did buildMenubar() run?`);
  }
  const appDir = path.join(payloadRoot, "Applications", "Loombre.app");
  const contentsDir = path.join(appDir, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  mkdirSync(macosDir, { recursive: true });
  cpSync(binPath, path.join(macosDir, "Loombre"));
  chmodSync(path.join(macosDir, "Loombre"), 0o755);

  // Contents/Resources/AppIcon.icns — without it Finder, the Dock and the
  // "Loombre.app wants to..." system prompts all render the generic blank
  // application document. The .icns is a COMMITTED, regenerable container
  // (scripts/build-app-icons.mjs, from design/blaze's 1024px source);
  // generating it here would tie the pkg build to macOS-only `iconutil`
  // for no benefit, since it is identical for every build.
  const resourcesDir = path.join(contentsDir, "Resources");
  mkdirSync(resourcesDir, { recursive: true });
  const icnsSource = path.join(REPO_ROOT, "design", "blaze", "assets", "icons", "loombre.icns");
  if (!existsSync(icnsSource)) {
    throw new Error(
      `assembleAppBundle: missing ${icnsSource} — run \`node scripts/build-app-icons.mjs\` to regenerate the icon containers`,
    );
  }
  cpSync(icnsSource, path.join(resourcesDir, "AppIcon.icns"));

  const version = readVersion();
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Loombre</string>
  <key>CFBundleDisplayName</key><string>Loombre</string>
  <key>CFBundleIdentifier</key><string>com.loombre.menubar</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>Loombre</string>
  <!-- Names Resources/AppIcon.icns. NO extension, by convention — macOS
       appends .icns itself, and writing "AppIcon.icns" here works on some
       OS versions and silently falls back to the blank generic icon on
       others. -->
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- Menu-bar-only utility: no Dock icon, no Cmd-Tab entry. Belt-and-
       suspenders alongside AppDelegate.swift's own
       NSApp.setActivationPolicy(.accessory) call, which already makes
       this true even without this key (a plain SPM executable has no
       Info.plist at all when run via swift run). -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
  writeFileSync(path.join(contentsDir, "Info.plist"), infoPlist, "utf8");
  log(`assembled /Applications/Loombre.app (Info.plist LSUIElement=true, version ${version})`);
}

// ---------------------------------------------------------------------
// 4. Runtime fetches (node / ffmpeg / embedded-pg)
// ---------------------------------------------------------------------
async function fetchRuntimes(payloadRoot) {
  const runtimeDir = path.join(payloadRoot, "opt", "loombre", readVersion(), "runtime");

  const { fetchNode } = await import(path.join(PKG_DIR, "fetch-node.mjs"));
  const nodeResult = await fetchNode({ arch: ARCH, destDir: path.join(runtimeDir, "node") });
  log(`bundled Node ${nodeResult.version} (darwin-${ARCH})`);

  const { fetchFfmpeg } = await import(path.join(PKG_DIR, "fetch-ffmpeg.mjs"));
  const ffmpegResult = await fetchFfmpeg({ platform: "macos", arch: ARCH, destDir: path.join(runtimeDir, "ffmpeg") });
  log(`ffmpeg staged (placeholder=${ffmpegResult.placeholder}): ${ffmpegResult.version}`);

  const { fetchEmbeddedPg } = await import(path.join(PKG_DIR, "fetch-embedded-pg.mjs"));
  // Vendor-layout shape, NOT a flat runtime/pg: apps/server's embedded
  // provisioning resolves binaries as <vendorDir>/<platform>/<version>/bin
  // (packages/provisioning-pg/src/vendor-layout.ts), and the loombre-server
  // shim points LOOMBRE_EMBEDDED_PG_VENDOR_DIR at runtime/pg. The rc.1
  // payload staged pg FLAT, which — together with the shim's dev-default
  // DATABASE_URL — is why the installed server could never use the
  // PostgreSQL it shipped (LAYOUT.md §8's deferred wiring, now landed).
  const pgVendorPlatform = `macos-${ARCH}`;
  const pgFetchDir = path.join(runtimeDir, "pg-fetch");
  const pgResult = await fetchEmbeddedPg({ platform: "macos", arch: ARCH, destDir: pgFetchDir });
  log(`embedded-PG staged=${pgResult.staged} placeholder=${pgResult.placeholder}`);
  if (pgResult.staged && pgResult.version) {
    const pgVendorDir = path.join(runtimeDir, "pg", pgVendorPlatform, pgResult.version);
    mkdirSync(path.dirname(pgVendorDir), { recursive: true });
    renameSync(pgFetchDir, pgVendorDir);
    log(`embedded-PG restaged vendor-shaped: runtime/pg/${pgVendorPlatform}/${pgResult.version}`);
  } else {
    renameSync(pgFetchDir, path.join(runtimeDir, "pg"));
  }

  return { nodeResult, ffmpegResult, pgResult };
}

/**
 * Workaround for a DELIBERATE, DOCUMENTED deviation in newly-landed lane-I
 * code (apps/server/src/common/update-check/release-manifest-import.ts,
 * discovered mid-lane): under this wave's LOCKFILE FROZEN rule (lane F is
 * sole lockfile owner), apps/server cannot add a real
 * `"@loombre/release-manifest": "workspace:*"` dependency (that needs a
 * pnpm-lock.yaml change), so it reaches packages/release-manifest/dist by
 * a hardcoded RELATIVE import instead
 * (`../../../../../packages/release-manifest/dist/index.js`, 5 levels up
 * from apps/server/{src,dist}/common/update-check/ to repo root). That
 * file's own header already documents the intended follow-up once the
 * freeze lifts (declare the real dependency, delete the relative-import
 * shim) — this is not a bug to fix, just a packaging-time consequence to
 * route around: a `pnpm deploy` output does NOT preserve the monorepo's
 * directory depth, so the relative import silently resolves to nowhere
 * once deployed. Stages packages/release-manifest's dist at the exact
 * depth 5 `../` from `<payloadRoot>/opt/loombre/<version>/server/dist/
 * common/update-check/` actually lands at — one level ABOVE the version
 * dir, i.e. `<payloadRoot>/opt/loombre/packages/release-manifest/dist`, NOT
 * inside it (verified empirically against the real ERR_MODULE_NOT_FOUND
 * path Node printed when this was first wrong — see this lane's report)
 * — so the payload boots without needing to touch apps/server's source at
 * all. Flagged in the final report for lane I.
 */
function stagePackagesReleaseManifestForRawRelativeImport(payloadRoot) {
  const srcDist = path.join(REPO_ROOT, "packages", "release-manifest", "dist");
  if (!existsSync(path.join(srcDist, "index.js"))) {
    throw new Error(
      `stagePackagesReleaseManifestForRawRelativeImport: ${srcDist}/index.js missing — build packages/release-manifest first ` +
        `(this is the same package apps/server's own prebuild script builds).`,
    );
  }
  const destDist = path.join(payloadRoot, "opt", "loombre", "packages", "release-manifest", "dist");
  mkdirSync(path.dirname(destDist), { recursive: true });
  cpSync(srcDist, destDist, { recursive: true });
  log("staged packages/release-manifest/dist at the depth apps/server's raw relative import expects (see comment above)");
}

// ---------------------------------------------------------------------
// 4b. Web app staging (installer completeness audit, gap 1)
//
// apps/web builds a Next `output: "standalone"` tree (next.config.mjs) in
// the MONOREPO layout: `<standalone>/apps/web/server.js` +
// `<standalone>/node_modules` (+ a nested `<standalone>/apps/web/
// node_modules`). Runnable staging = copy the whole standalone root into
// `<versionDir>/web/`, then overlay the two pieces Next's standalone
// output contract deliberately leaves to the deployer (their docs:
// "should be copied by deployment"): `apps/web/.next/static` and
// `apps/web/public`. bin/loombre-web then runs
// `<versionDir>/web/apps/web/server.js` on the bundled Node with
// NODE_ENV=production + PORT/HOSTNAME (see that shim).
//
// verbatimSymlinks is NOT just safety consistency here: measured on this
// tree, the standalone output contains 22 RELATIVE symlinks (pnpm-style
// links into its own .pnpm level, e.g. apps/web/node_modules/next) — the
// cpSync default would rewrite them to absolute build-machine paths, the
// exact ERR_MODULE_NOT_FOUND class of failure deployApp()'s prune copy
// comment documents from the v0.9.0-rc.1 incident.
// ---------------------------------------------------------------------
function stageWeb(versionDir) {
  const webAppDir = path.join(REPO_ROOT, "apps", "web");
  const standaloneDir = path.join(webAppDir, ".next", "standalone");
  const standaloneServerJs = path.join(standaloneDir, "apps", "web", "server.js");
  if (!existsSync(standaloneServerJs)) {
    throw new Error(
      `stageWeb: ${standaloneServerJs} missing — apps/web has no production standalone build. ` +
        "Run `pnpm --filter @loombre/web build`, or rerun build-pkg without --skip-workspace-build " +
        "(buildWorkspace() now builds the web app itself via `npx next build --webpack`).",
    );
  }

  const destDir = path.join(versionDir, "web");
  cpSync(standaloneDir, destDir, { recursive: true, verbatimSymlinks: true });

  // Static chunks: REQUIRED (the app is unstyled, script-less HTML without
  // them). Copied from the real build output — the authoritative source —
  // over whatever the standalone tree contained.
  const staticSrc = path.join(webAppDir, ".next", "static");
  if (!existsSync(staticSrc)) {
    throw new Error(
      `stageWeb: ${staticSrc} missing — inconsistent .next build output (standalone exists but static does not). ` +
        "Re-run `pnpm --filter @loombre/web build`.",
    );
  }
  cpSync(staticSrc, path.join(destDir, "apps", "web", ".next", "static"), {
    recursive: true,
    verbatimSymlinks: true,
  });

  // public/: optional in principle (Next tolerates its absence), copied
  // when present.
  const publicSrc = path.join(webAppDir, "public");
  if (existsSync(publicSrc)) {
    cpSync(publicSrc, path.join(destDir, "apps", "web", "public"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  log(`web staged: standalone + .next/static + public -> web/ (${duSizeMb(destDir)} MB)`);
  return destDir;
}

// ---------------------------------------------------------------------
// 5. Payload assembly
// ---------------------------------------------------------------------
function assemblePayload(serverDeployDir, workerDeployDir) {
  const version = readVersion();
  const payloadRoot = path.join(BUILD_CACHE, "payload", ARCH);
  rmSync(payloadRoot, { recursive: true, force: true });
  mkdirSync(payloadRoot, { recursive: true });

  const versionDir = path.join(payloadRoot, "opt", "loombre", version);
  mkdirSync(versionDir, { recursive: true });

  // bin/ shims (loombre-web: installer completeness audit, gap 1)
  mkdirSync(path.join(versionDir, "bin"), { recursive: true });
  for (const shim of ["loombre-server", "loombre-worker", "loombre-web"]) {
    cpSync(path.join(PKG_DIR, "bin", shim), path.join(versionDir, "bin", shim));
    chmodSync(path.join(versionDir, "bin", shim), 0o755);
  }

  // server/, worker/ — verbatimSymlinks for the same reason as
  // deployApp's prune copy: the default silently rewrites pnpm's
  // relative .pnpm links to absolute build-machine paths.
  cpSync(serverDeployDir, path.join(versionDir, "server"), { recursive: true, verbatimSymlinks: true });
  cpSync(workerDeployDir, path.join(versionDir, "worker"), { recursive: true, verbatimSymlinks: true });

  // web/ — the third service's payload (installer completeness audit,
  // gap 1): Next standalone tree + static assets, run by bin/loombre-web
  // under com.loombre.web.plist. See stageWeb()'s own header.
  stageWeb(versionDir);

  stagePackagesReleaseManifestForRawRelativeImport(payloadRoot);

  writeFileSync(path.join(versionDir, "VERSION"), `${version}\n`, "utf8");

  // /opt/loombre/current -> <version>  (relative symlink, upgrade swap point)
  symlinkSync(version, path.join(payloadRoot, "opt", "loombre", "current"));

  // /Library/Application Support/Loombre/{db,config,secrets,ipc} — empty,
  // ownership+mode fixed up by postinstall (payload perms here are just
  // "exists"; pkgbuild --ownership recommended + postinstall's chown/chmod
  // do the real work per LAYOUT.md's table).
  for (const sub of ["db", "config", "secrets", "ipc"]) {
    mkdirSync(path.join(payloadRoot, "Library", "Application Support", "Loombre", sub), { recursive: true });
  }
  // /Library/Logs/Loombre
  mkdirSync(path.join(payloadRoot, "Library", "Logs", "Loombre"), { recursive: true });

  // /Library/LaunchDaemons — THREE daemons since the completeness audit
  // (server, worker, web UI). The upgrade path stays coherent across all
  // three: preinstall boots each out, this payload lays the plists back
  // down, postinstall bootstraps them again — anyone adding a fourth
  // daemon must touch this list, preinstall's LABEL list, postinstall's
  // PLIST loop, and the homebrew cask's `uninstall launchctl:` stanza
  // together (plus LAYOUT.md).
  const launchDaemonsDir = path.join(payloadRoot, "Library", "LaunchDaemons");
  mkdirSync(launchDaemonsDir, { recursive: true });
  for (const plist of ["com.loombre.server.plist", "com.loombre.worker.plist", "com.loombre.web.plist"]) {
    cpSync(path.join(PKG_DIR, "launchd", plist), path.join(launchDaemonsDir, plist));
  }

  // /Library/LaunchAgents — the menubar controller, the ONE piece that
  // runs in the logged-in user's GUI session rather than as _loombre.
  // Without it the rc.1 pkg installed a fully working stack and put
  // nothing whatsoever on screen; see the plist's own header for the
  // field report and the Windows HKLM-Run-key precedent it mirrors.
  const launchAgentsDir = path.join(payloadRoot, "Library", "LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });
  cpSync(
    path.join(PKG_DIR, "launchagents", "com.loombre.menubar.plist"),
    path.join(launchAgentsDir, "com.loombre.menubar.plist"),
  );

  return { payloadRoot, versionDir, version };
}

// ---------------------------------------------------------------------
// 6. pkgbuild + productbuild
// ---------------------------------------------------------------------

// AUD-A5b-001: Distribution.xml's hostArchitectures used to be hardcoded
// "arm64" regardless of --arch, so an --arch=x64 build shipped Intel
// binaries end to end while declaring the package arm64-only — Installer
// refuses that on the exact Mac it was built for. Apple's attribute wants
// its OWN identifiers ("arm64", "x86_64"), not this script's --arch
// spelling ("arm64", "x64") — hence the explicit map rather than passing
// ARCH straight through. Exported (with renderDistributionXml) so
// pkg/distribution-xml.test.mjs can assert the substitution without
// running the whole build.
export function hostArchitecturesFor(arch) {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x86_64";
  throw new Error(`hostArchitecturesFor: unknown arch "${arch}" (expected "arm64" or "x64")`);
}

export function renderDistributionXml({ template, version, pkgFilename, arch }) {
  return template
    .replaceAll("__VERSION__", version)
    .replaceAll("__PKG_FILENAME__", pkgFilename)
    .replaceAll("__HOST_ARCHITECTURES__", hostArchitecturesFor(arch));
}

// THE rc.6 FIELD BUG ("install successful, app never launches or appears
// in Applications"): pkgbuild without --component-plist runs automatic
// component analysis, which marks every .app bundle in the payload
// BundleIsRelocatable=true — a <relocate> entry in the shipped
// PackageInfo. At install time PackageKit resolves a relocatable bundle's
// destination by asking LaunchServices/Spotlight for an EXISTING copy of
// the bundle id anywhere on the target volume and installs over THAT
// instead of the payload path. Observed live (/var/log/install.log,
// 2026-08-08, four consecutive installs): "Applications/Loombre.app
// relocated to Users/ozzy/App Development/Loombre/installers/macos/
// .build-cache/payload/arm64/Applications/Loombre.app" — the staged
// payload copy in this very build tree swallowed the install. The install
// still exits 0, /Applications/Loombre.app never exists, and the
// LaunchAgent's hardcoded ProgramArguments path spawns nothing. Any stray
// copy (a build tree, ~/Downloads, the Trash) hijacks every later
// install/upgrade the same way, and each hijack re-registers the stray
// with LaunchServices, cementing it as the next target.
//
// This component plist pins the bundle to its payload path
// unconditionally. BundleIsVersionChecked is OFF deliberately: with it
// on, Installer compares CFBundleVersions before overwriting, and
// rc-suffixed versions ("0.9.0-rc.6") do not compare reliably under its
// numeric segment rules — the pkg payload is authoritative for this
// bundle (preinstall already booted the running app out), so it always
// overwrites. Exported so pkg/component-plist.test.mjs can round-trip
// the rendered plist through the real pkgbuild without running the whole
// build; smoke.mjs asserts the built artifact's PackageInfo has no
// <relocate> entries.
export function renderComponentPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>RootRelativeBundlePath</key>
    <string>Applications/Loombre.app</string>
    <key>BundleIsRelocatable</key>
    <false/>
    <key>BundleIsVersionChecked</key>
    <false/>
    <key>BundleOverwriteAction</key>
    <string>upgrade</string>
  </dict>
</array>
</plist>
`;
}

function buildPkg(payloadRoot, version) {
  const outRoot = path.join(BUILD_CACHE, "pkgbuild-out");
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  mkdirSync(DIST_OUT, { recursive: true });

  // Stage the install scripts and FORCE the exec bit before pkgbuild:
  // PackageKit refuses a non-executable preinstall outright (error 112,
  // "./preinstall: isn't executable" — the v0.9.0-rc.1 install failure on
  // a real Mac: the scripts were tracked 100644, so every checkout
  // reproduced the broken mode). Git modes are now 100755 too; this
  // staging chmod makes the pkg immune to any future mode regression.
  const scriptsStage = path.join(outRoot, "scripts");
  cpSync(path.join(PKG_DIR, "scripts"), scriptsStage, { recursive: true });
  for (const script of readdirSync(scriptsStage)) {
    chmodSync(path.join(scriptsStage, script), 0o755);
  }

  // Pins Applications/Loombre.app non-relocatable — see
  // renderComponentPlist's header for the rc.6 relocation field bug this
  // prevents. Never drop this flag: pkgbuild's no-plist analysis default
  // is BundleIsRelocatable=true.
  const componentPlistPath = path.join(outRoot, "component-plist.plist");
  writeFileSync(componentPlistPath, renderComponentPlist(), "utf8");

  const componentPkg = path.join(outRoot, "loombre-component.pkg");
  run("pkgbuild", [
    "--root", payloadRoot,
    "--scripts", scriptsStage,
    "--identifier", "com.loombre.pkg",
    "--version", version,
    "--install-location", "/",
    "--ownership", "recommended",
    "--component-plist", componentPlistPath,
    componentPkg,
  ]);

  const distributionXmlPath = path.join(outRoot, "Distribution.xml");
  const distTemplate = readFileSync(path.join(PKG_DIR, "Distribution.xml.tmpl"), "utf8");
  const distributionXml = renderDistributionXml({
    template: distTemplate,
    version,
    pkgFilename: "loombre-component.pkg",
    arch: ARCH,
  });
  writeFileSync(distributionXmlPath, distributionXml, "utf8");

  const finalPkgName = `loombre-${version}-macos-${ARCH}.pkg`;
  const finalPkgPath = path.join(DIST_OUT, finalPkgName);
  run("productbuild", [
    "--distribution", distributionXmlPath,
    "--package-path", outRoot,
    "--resources", path.join(PKG_DIR, "resources"),
    finalPkgPath,
  ]);

  return finalPkgPath;
}

// ---------------------------------------------------------------------
// 7. sign-hook (no-op; lane I1's deliverable — see LAYOUT.md §7)
//
// LANDED with a real, simple shape: `signHook(artifactPath) ->
// { signed: false, reason }`, matching installers/linux/build-tarball.mjs's
// call convention (also invocable as `node installers/sign-hook.mjs
// <artifact>` — this calls it in-process instead, equivalent per its own
// header). Differs from this lane's original guess (an object-arg
// `signArtifact({filePath, platform, arch, kind})`) — updated to match the
// real thing rather than the assumption; noted in the final report as a
// LAYOUT.md §7 correction, not a "STOP" (the real shape needed no
// reconciliation discussion, just matching it).
// ---------------------------------------------------------------------
async function callSignHook(filePath) {
  const signHookPath = path.join(REPO_ROOT, "installers", "sign-hook.mjs");
  if (existsSync(signHookPath)) {
    log(`calling installers/sign-hook.mjs (lane I1)`);
    const mod = await import(signHookPath);
    if (typeof mod.signHook !== "function") {
      throw new Error(
        "installers/sign-hook.mjs exists but does not export signHook() — its shape changed again. STOP + reconcile with lane I1.",
      );
    }
    const result = mod.signHook(filePath);
    log(`sign-hook result: ${JSON.stringify(result)}`);
    return;
  }
  log(
    "installers/sign-hook.mjs not found — running inline no-op fallback. " +
      "See installers/macos/LAYOUT.md §7 for the assumed call shape.",
  );
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------
async function main() {
  log(`Loombre macOS .pkg build — arch=${ARCH} smoke=${DO_SMOKE}`);
  const version = readVersion();
  log(`version (root package.json, see LAYOUT.md §5): ${version}`);

  buildWorkspace();
  const serverDeployDir = deployApp("@loombre/server", "server");
  const workerDeployDir = deployApp("@loombre/worker", "worker");

  buildMenubar();

  const { payloadRoot } = assemblePayload(serverDeployDir, workerDeployDir);
  assembleAppBundle(payloadRoot);
  await fetchRuntimes(payloadRoot);

  const pkgPath = buildPkg(payloadRoot, version);
  await callSignHook(pkgPath);

  const sizeBytes = statSync(pkgPath).size;
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
  log(`BUILT: ${pkgPath} (${sizeBytes} bytes, ${sizeMb} MB)`);

  const report = {
    version,
    arch: ARCH,
    pkgPath,
    sizeBytes,
    builtAtMs: Date.now(),
  };
  mkdirSync(BUILD_CACHE, { recursive: true });
  writeFileSync(path.join(BUILD_CACHE, "last-build-report.json"), JSON.stringify(report, null, 2), "utf8");

  if (DO_SMOKE) {
    log("running local smoke checks (installers/macos/smoke.mjs)");
    run("node", [path.join(LANE_DIR, "smoke.mjs"), `--arch=${ARCH}`], { cwd: REPO_ROOT });
  }

  log("done.");
}

// Guarded (not a bare top-level call) so pkg/distribution-xml.test.mjs can
// `import` this module for its pure helpers above without kicking off a
// real, multi-minute workspace build as a side effect of import — the
// exact isDirectEntrypoint pattern installers/linux/smoke.mjs already uses
// for the same reason.
const isDirectEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectEntrypoint) {
  main().catch((err) => {
    console.error("\n[build-pkg] FAILED:", err);
    process.exit(1);
  });
}
