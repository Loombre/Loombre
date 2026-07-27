#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/windows/build-msi.mjs
//
// Orchestrates the Windows MSI end-to-end:
//   1. workspace build          — tsc-build @loombre/server + @loombre/worker
//                                  and their workspace deps, `next build`
//                                  @loombre/web
//   2. stage payloads           — pnpm-deploy server/worker (pruned prod
//                                  node_modules); stage web's build output
//                                  (see stageWeb()'s WARNING — apps/web has
//                                  no `output: 'standalone'` yet, so this
//                                  step ships an INCOMPLETE web payload,
//                                  flagged loudly, not silently); fetch
//                                  node runtime (placeholder — see
//                                  fetchNodeRuntime()); consume lane I1's
//                                  scripts/fetch-ffmpeg.mjs and lane B's
//                                  scripts/fetch-embedded-pg.mjs IF they
//                                  exist yet, else placeholder + warn (same
//                                  pattern lane I1 itself used for the
//                                  sign-hook per this lane's brief)
//   3. dotnet publish tray       — win-x64 self-contained single-file
//   4. dotnet publish svc-host   — win-x64 self-contained single-file
//   5. dotnet test               — the plain-net8.0 test projects (portable
//                                  logic only — see each .csproj's header)
//   6. wix build                 — Package.wxs + fragments -> the .msi
//   7. sign-hook                 — installers/sign-hook.mjs (lane I1,
//                                  no-op in v1 per P4.1) — calls it if
//                                  present, warns + skips if absent
//
// Runnable end-to-end on any host with `dotnet` (>= 8 SDK) on PATH and the
// `wix` dotnet tool installed (`dotnet tool install --global wix` or a
// local tool manifest — see ensureWixInstalled()). On THIS lane's actual
// build host (macOS, no dotnet — see the I3 report), steps 1-2 run and are
// proven; steps 3-7 are detected-absent and this script exits with a clear,
// non-destructive report rather than attempting a partial dotnet/wix run.
//
// CI invocation (lane I's release.yml, once wired — see the I3 report for
// the exact commands): a `windows-latest` OR any dotnet+wix-provisioned
// runner running:
//   node installers/windows/build-msi.mjs --version <semver>
// with the repo's frozen lockfile already `pnpm install --frozen-lockfile`'d.
//
// No pnpm dependency changes: everything here is `pnpm --filter … build`,
// `pnpm --filter … deploy` (both stock pnpm CLI features, no new devDeps),
// plus `dotnet`/`wix` invocations. Zero new entries needed in the root
// lockfile or LICENSE-INTENT.md.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const WINDOWS_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const OUT_DIR = path.join(WINDOWS_DIR, "out"); // gitignored — see repo .gitignore's "Windows installer lane (I3)" block
const STAGE_DIR = path.join(OUT_DIR, "stage");

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1] : fallback;
}
const SKIP_TESTS = args.includes("--skip-tests");

function log(msg) {
  console.log(`[build-msi] ${msg}`);
}
function warn(msg) {
  console.warn(`[build-msi] WARNING: ${msg}`);
}
function stop(msg) {
  console.error(`[build-msi] STOP: ${msg}`);
  process.exit(1);
}

function which(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// pnpm on Windows is normally a `.cmd` shim (npm -g, corepack, and
// pnpm/action-setup all shim this way; only the standalone installer ships a
// real pnpm.exe). Node refuses to spawn cmd/bat scripts without an explicit
// shell (CVE-2024-27980) — a bare execFileSync("pnpm", …) dies with ENOENT.
// Routing through cmd.exe would reintroduce the metacharacter surface that
// refusal exists to remove, so resolve the shim to its real entry point
// instead: pnpm.exe directly, or the shim's JS entry run by this same Node.
let cachedPnpmInvocation = null;
function pnpmInvocation() {
  if (process.platform !== "win32") return { file: "pnpm", prefix: [] };
  if (cachedPnpmInvocation) return cachedPnpmInvocation;
  let matches = [];
  try {
    matches = execFileSync("where", ["pnpm"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    stop("pnpm not found on PATH");
  }
  const exe = matches.find((m) => /\.exe$/i.test(m));
  if (exe) {
    cachedPnpmInvocation = { file: exe, prefix: [] };
  } else {
    for (const shim of matches.filter((m) => /\.(cmd|bat)$/i.test(m))) {
      const shimDir = path.dirname(shim);
      const entry = [
        path.join(shimDir, "node_modules", "pnpm", "bin", "pnpm.cjs"), // npm -g layout
        path.resolve(shimDir, "..", "pnpm", "bin", "pnpm.cjs"), // node_modules/.bin layout (pnpm/action-setup)
        path.join(shimDir, "node_modules", "corepack", "dist", "pnpm.js"), // corepack shim beside node.exe
      ].find((candidate) => existsSync(candidate));
      if (entry) {
        cachedPnpmInvocation = { file: process.execPath, prefix: [entry] };
        break;
      }
    }
  }
  if (!cachedPnpmInvocation) {
    stop(
      `pnpm on PATH is only a shell shim and its JS entry point was not found next to it (checked: ${matches.join(", ")})`,
    );
  }
  log(`pnpm resolved to: ${[cachedPnpmInvocation.file, ...cachedPnpmInvocation.prefix].join(" ")}`);
  return cachedPnpmInvocation;
}

function run(cmd, cmdArgs, opts = {}) {
  log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const invocation = cmd === "pnpm" ? pnpmInvocation() : { file: cmd, prefix: [] };
  execFileSync(invocation.file, [...invocation.prefix, ...cmdArgs], {
    stdio: "inherit",
    cwd: REPO_ROOT,
    ...opts,
  });
}

function getProductVersion() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.version; // P4.11 single-sourced version
}

// ---------------------------------------------------------------------------
// Step 1: workspace build
// ---------------------------------------------------------------------------
function buildWorkspace() {
  log("Step 1/7: workspace build (server, worker, web)");
  run("pnpm", ["--filter", "@loombre/server...", "build"]);
  run("pnpm", ["--filter", "@loombre/worker...", "build"]);
  run("pnpm", ["--filter", "@loombre/web", "build"]);
}

// ---------------------------------------------------------------------------
// Step 2: stage payloads
// ---------------------------------------------------------------------------
function pnpmDeploy(pkgName, targetDir) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  // `pnpm deploy` (stock pnpm CLI, no new dep) copies the package + its
  // PRODUCTION dependency closure — resolved from the frozen lockfile —
  // into targetDir, pruned of devDependencies. Requires the package to
  // already be built (dist/ present), hence buildWorkspace() runs first.
  // `--legacy` matches lanes I1/I4: pnpm v10+ refuses to deploy from a
  // non-injected workspace without it (ERR_PNPM_DEPLOY_NONINJECTED_
  // WORKSPACE), and this workspace does not set inject-workspace-packages.
  //
  // Deploy to a raw dir, then MATERIALIZE into targetDir with a
  // dereferencing copy: pnpm's node_modules layout is junction/symlink-
  // heavy, macOS's rc.1 install proved relocated links are a crash
  // (ERR_MODULE_NOT_FOUND on every direct dep), and this lane adds a zip
  // hop where System.IO.Compression cannot recreate links at all. Real
  // files only in the payload — the posture lane I1's boot smoke proved.
  const rawDir = `${targetDir}-raw`;
  rmSync(rawDir, { recursive: true, force: true });
  mkdirSync(rawDir, { recursive: true });
  run("pnpm", ["--filter", pkgName, "deploy", "--prod", "--legacy", rawDir]);
  cpSync(rawDir, targetDir, { recursive: true, dereference: true });
  rmSync(rawDir, { recursive: true, force: true });

  // apps/server-only, ported from lane I4 (installers/macos/build-pkg.mjs +
  // LAYOUT.md §9): ajv is a *runtime* dependency (device-profile
  // validation) miscategorized as a devDependency, so `--prod` omits it
  // and the installed server would crash on first import. Vendor the
  // exact resolved version already installed under apps/server (pinned by
  // pnpm-lock.yaml — NOT a fresh fetch). ajv's own transitive deps live
  // as SIBLINGS in `.pnpm/ajv@<v>/node_modules/`, not nested under
  // `ajv/node_modules`, so copy the whole sibling level, flattened into
  // the deploy's top-level node_modules (I4 found this during its own
  // smoke-testing). realpathSync.native resolves pnpm's junction on
  // Windows where I4 shells out to `readlink -f`.
  if (pkgName === "@loombre/server") {
    const ajvSourceDir = path.join(REPO_ROOT, "apps", "server", "node_modules", "ajv");
    if (!existsSync(ajvSourceDir)) {
      stop(
        "pnpmDeploy(@loombre/server): apps/server/node_modules/ajv not found — run `pnpm install` " +
          "first, or apps/server no longer depends on ajv (update LAYOUT.md §9 + this script together).",
      );
    }
    const ajvSiblingLevel = path.dirname(realpathSync.native(ajvSourceDir)); // …/.pnpm/ajv@<v>/node_modules/
    const deployNodeModules = path.join(targetDir, "node_modules");
    for (const entry of readdirSync(ajvSiblingLevel)) {
      const dest = path.join(deployNodeModules, entry);
      rmSync(dest, { recursive: true, force: true });
      cpSync(path.join(ajvSiblingLevel, entry), dest, { recursive: true, dereference: true });
    }
    log(
      `vendored ajv + its ${readdirSync(ajvSiblingLevel).length - 1} resolved transitive deps into the server deploy`,
    );
  }
}

function stageWeb(targetDir) {
  // KNOWN GAP (flagged, not silently worked around — see the I3 report and
  // installers/windows/msi/Directories.wxs's WEBDIR comment): apps/web's
  // next.config.mjs does not set `output: "standalone"`, so there is no
  // self-contained, pruned Next.js server bundle to stage yet. This copies
  // the raw build output (.next/, public/, package.json, next.config.mjs)
  // WITHOUT node_modules — the resulting web/ payload is NOT independently
  // runnable via `next start` on the target machine as staged. It exists
  // so the MSI's file layout (Directories.wxs's WEBDIR) and Files.wxs's
  // glob harvesting are exercised end-to-end once dotnet/wix are
  // available, and so whoever lands `output: "standalone"` (or the
  // apps/server-serves-web wiring the frozen IpcStatusResponse.webUrl
  // field implies — see Directories.wxs) has a working directory-mapping
  // target to drop a real bundle into.
  warn(
    'stageWeb: apps/web/next.config.mjs has no `output: "standalone"` — staging .next/ + public/ ' +
      "WITHOUT a pruned node_modules. The resulting MSI installs web files it cannot yet serve " +
      "standalone. See the I3 report's 'web-serving architecture' finding.",
  );
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  const webSrc = path.join(REPO_ROOT, "apps", "web");
  for (const entry of [".next", "public", "package.json", "next.config.mjs"]) {
    const src = path.join(webSrc, entry);
    if (existsSync(src)) {
      cpSync(src, path.join(targetDir, entry), { recursive: true });
    }
  }
}

function placeholderDir(targetDir, note) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  // A non-empty placeholder so WiX v4's `<Files Include="…\**">` glob
  // (installers/windows/msi/Files.wxs) has at least one file to harvest —
  // an EMPTY source directory is a `wix build` error (nothing to match),
  // not a silently-empty ComponentGroup.
  // Written directly — no shell. The previous `cmd /c echo …> "path"`
  // form died on real Windows: Node quotes the composite arg when
  // spawning cmd.exe, which mangles the nested redirect quoting
  // ("The filename, directory name, or volume label syntax is
  // incorrect", diag run 30217821095).
  const marker = path.join(targetDir, "PLACEHOLDER.txt");
  writeFileSync(marker, `${note}\n`);
}

function fetchNodeRuntime(targetDir) {
  // PLACEHOLDER, same honesty pattern as ffmpeg/embedded-pg below: real
  // node-runtime bundling (single Node runtime per platform, no
  // user-installed Node — docs/PLAN.md §11) needs a pinned nodejs.org
  // win-x64 zip download + sha256 verification + extraction. Every
  // installer lane (I1 Linux, I3 this one, I4 macOS) needs the SAME
  // thing for its own platform — a strong candidate for ONE shared
  // script (e.g. scripts/fetch-node.mjs) rather than three independent
  // copies. This lane does not own root scripts/ (OWNERSHIP:
  // installers/windows/** only), so it stages a placeholder here and
  // flags the consolidation opportunity in the I3 report instead of
  // reaching outside its lane to create that shared script unilaterally.
  const nodeVersion = process.version; // documents "pin to the repo's own Node major" intent
  warn(
    `fetchNodeRuntime: staging a PLACEHOLDER node/ payload (no real win-x64 Node runtime downloaded). ` +
      `Repo Node engine: ${nodeVersion}. See the I3 report's "node runtime fetch" finding — a real ` +
      "implementation needs a pinned nodejs.org win-x64 zip + sha256 pin, ideally shared across I1/I3/I4.",
  );
  placeholderDir(targetDir, "Loombre placeholder: real win-x64 Node runtime not yet fetched by build-msi.mjs.");
}

// fetch-ffmpeg.mjs / fetch-embedded-pg.mjs LANDED mid-lane (lanes I1 and B
// respectively — not present when this script was first drafted; verified
// present and wired here for real before this lane's report was written,
// per the mission's "consume … if landed" instruction). Both are SHARED
// scripts (their own header comments say so explicitly: "Phase 4 lanes
// I1/I3/I4 all call this" / "installer lanes I1/I3/I4 call this too") with
// a real CLI, not a guessed one — this function calls the ACTUAL interface
// rather than the placeholder `--out`/`--arch` shape this file originally
// assumed. Both default to writing under <repo>/vendor/…. ffmpeg is
// consumed straight from there (wixBuild's -d FfmpegDir); embedded-pg is
// copied into STAGE_DIR/pg by createPayloadZip() so it rides inside
// payload.zip under its Directories.wxs name (the archived-payload model
// — see that function's comment).

function fetchFfmpegWindows() {
  const scriptPath = path.join(REPO_ROOT, "scripts", "fetch-ffmpeg.mjs");
  const resolvedDir = path.join(REPO_ROOT, "vendor", "ffmpeg", "windows-x64");
  if (!existsSync(scriptPath)) {
    warn("scripts/fetch-ffmpeg.mjs not present (lane I1 deliverable) — staging a PLACEHOLDER instead.");
    placeholderDir(resolvedDir, "Loombre placeholder: scripts/fetch-ffmpeg.mjs not present at build time.");
    return resolvedDir;
  }
  log("Found scripts/fetch-ffmpeg.mjs (lane I1) — fetching the pinned windows-x64 ffmpeg/ffprobe pair");
  run("node", [scriptPath, "--platform", "windows-x64"]);
  return resolvedDir;
}

function fetchEmbeddedPgWindows() {
  const scriptPath = path.join(REPO_ROOT, "scripts", "fetch-embedded-pg.mjs");
  const manifestPath = path.join(REPO_ROOT, "installers", "embedded-pg-manifest.json");
  if (!existsSync(scriptPath)) {
    const fallbackDir = path.join(REPO_ROOT, "vendor", "embedded-pg", "windows-x64");
    warn("scripts/fetch-embedded-pg.mjs not present (lane B deliverable) — staging a PLACEHOLDER instead.");
    placeholderDir(fallbackDir, "Loombre placeholder: scripts/fetch-embedded-pg.mjs not present at build time.");
    return fallbackDir;
  }
  // The script's vendor-dir layout is <vendorDir>/<platform>/<version>/…
  // (its own header comment) — the *version* segment is whatever
  // manifest.defaultVersion currently pins, read here rather than
  // hardcoded so a manifest bump doesn't silently break this path.
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const pgVersion = manifest.defaultVersion;
  log(`Found scripts/fetch-embedded-pg.mjs (lane B) — fetching windows-x64 PostgreSQL ${pgVersion}`);
  run("node", [scriptPath, "--platform", "windows-x64", "--pg-version", pgVersion]);
  return path.join(REPO_ROOT, "vendor", "embedded-pg", "windows-x64", pgVersion);
}

// ARCHIVED-PAYLOAD MODEL (owner decision after WIX7502, diag run
// 30219204709: 84,305 per-file Components vs MSI's hard 65,536 ceiling):
// the five big trees ship inside the MSI as ONE payload.zip whose
// top-level names match Directories.wxs's SERVERDIR/WORKERDIR/WEBDIR/
// NODEDIR/PGDIR. LoombreServiceHost extracts it on first service start
// (PayloadExtractor.cs). ffmpeg/svc/tray stay per-file MSI components —
// their counts are nowhere near the ceiling.
function createPayloadZip(embeddedPgDir) {
  log("Step 2/7 (cont.): create payload.zip (MSI component-count ceiling workaround)");
  // pg is fetched into vendor/, not STAGE_DIR — copy it in so one
  // tar -C root covers all five trees under their final names.
  const pgStage = path.join(STAGE_DIR, "pg");
  rmSync(pgStage, { recursive: true, force: true });
  cpSync(embeddedPgDir, pgStage, { recursive: true, dereference: true });

  const zipPath = path.join(OUT_DIR, "payload.zip");
  rmSync(zipPath, { force: true });
  // System32\tar.exe is bsdtar (ships with Windows 10+); -a picks ZIP
  // format from the .zip extension, which PayloadExtractor's
  // System.IO.Compression reader requires. The ABSOLUTE path matters:
  // a Git-for-Windows GNU tar earlier on PATH would not produce ZIP.
  const tarExe =
    process.platform === "win32"
      ? path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  run(tarExe, ["-a", "-cf", zipPath, "-C", STAGE_DIR, "server", "worker", "web", "node", "pg"]);
  log(`payload.zip created: ${(statSync(zipPath).size / (1024 * 1024)).toFixed(1)} MiB`);
  return zipPath;
}

function stagePayloads() {
  log("Step 2/7: stage payloads");
  mkdirSync(STAGE_DIR, { recursive: true });

  pnpmDeploy("@loombre/server", path.join(STAGE_DIR, "server"));
  pnpmDeploy("@loombre/worker", path.join(STAGE_DIR, "worker"));
  stageWeb(path.join(STAGE_DIR, "web"));
  fetchNodeRuntime(path.join(STAGE_DIR, "node"));
  const ffmpegDir = fetchFfmpegWindows();
  const embeddedPgDir = fetchEmbeddedPgWindows();
  const payloadZip = createPayloadZip(embeddedPgDir);
  return { ffmpegDir, payloadZip };
}

// ---------------------------------------------------------------------------
// Steps 3-5: dotnet publish (tray + service host) + dotnet test
// ---------------------------------------------------------------------------
function dotnetPublish(csprojRelPath, targetDir, version) {
  const csprojPath = path.join(WINDOWS_DIR, csprojRelPath);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  run("dotnet", [
    "publish",
    csprojPath,
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    `-p:Version=${version}`,
    "-o",
    targetDir,
  ]);
}

function dotnetTest(csprojRelPath) {
  run("dotnet", ["test", path.join(WINDOWS_DIR, csprojRelPath), "-c", "Release"]);
}

function buildDotnetProjects(version) {
  log("Step 3/7: dotnet publish tray (win-x64, self-contained, single-file)");
  dotnetPublish("tray/Loombre.Tray/Loombre.Tray.csproj", path.join(STAGE_DIR, "tray"), version);

  log("Step 4/7: dotnet publish service host (win-x64, self-contained, single-file)");
  dotnetPublish("service-host/LoombreServiceHost/LoombreServiceHost.csproj", path.join(STAGE_DIR, "svc"), version);

  if (SKIP_TESTS) {
    warn("Step 5/7 skipped (--skip-tests)");
    return;
  }
  log("Step 5/7: dotnet test (portable, Windows-independent test projects)");
  // Only the plain-net8.0 projects — LoombreServiceHost.Core-backed and
  // Loombre.Tray.Ipc-backed tests — run here. Loombre.Tray itself (WinForms
  // UI) and LoombreHostedService (Win32 console-signal P/Invoke) have no
  // automated coverage; they are Wave 3 Windows-VM territory (see the I3
  // report's validation-ceiling section).
  dotnetTest("tray/Loombre.Tray.Tests/Loombre.Tray.Tests.csproj");
  dotnetTest("service-host/LoombreServiceHost.Tests/LoombreServiceHost.Tests.csproj");
}

// ---------------------------------------------------------------------------
// Step 6: wix build
// ---------------------------------------------------------------------------
// OWNER DECISION (supported-latest sweep, 2026-07-25): WiX is PINNED at
// 5.0.2 — the last line before the Open Source Maintenance Fee EULA began
// gating v6+ binary releases. Evidence for the pin (STATE.md sweep ledger):
// every WiX CVE ever published (all Feb–Mar 2024, Burn/RemoveFolderEx
// classes) was fixed before v5.0.0 GA and none touches this plain
// MSI+Service+Firewall authoring; v4-namespace .wxs compiles unchanged on
// v5 per FireGiant's own compat doc. Known cost, accepted knowingly: v5
// left community support 2026-02-06, so this is a clean-but-frozen
// toolchain. REVISIT TRIGGER: any new WiX advisory affecting non-Burn MSI
// surfaces, or the first real 5.0.2 build breakage on a current .NET SDK.
// The pin lives in /.config/dotnet-tools.json (dotnet tool run resolves
// the manifest walking up from this cwd); the Firewall extension is pinned
// in lockstep below — mismatched extension/core versions are a known
// build-breaker (wixtoolset/issues#8945).
const PINNED_WIX_VERSION = "5.0.2";
const PINNED_FIREWALL_EXT = `WixToolset.Firewall.wixext/${PINNED_WIX_VERSION}`;
// Util supplies util:RemoveFolderEx (Package.wxs's uninstall cleanup of
// the extracted payload trees) — pinned in lockstep like Firewall.
const PINNED_UTIL_EXT = `WixToolset.Util.wixext/${PINNED_WIX_VERSION}`;
const PINNED_EXTENSIONS = [PINNED_FIREWALL_EXT, PINNED_UTIL_EXT];

function ensureWixInstalled() {
  // Restore first: with a tool manifest present, `dotnet tool run` errors
  // until `dotnet tool restore` has run once — make that automatic (it is
  // cheap and offline-idempotent after the first restore).
  try {
    execFileSync("dotnet", ["tool", "restore"], { stdio: "pipe", cwd: WINDOWS_DIR });
  } catch {
    // fall through — the version probe below produces the actionable stop()
  }
  try {
    const out = execFileSync("dotnet", ["tool", "run", "wix", "--version"], {
      stdio: "pipe",
      cwd: WINDOWS_DIR,
    });
    const detected = String(out).trim();
    log(`wix toolset version: ${detected}`);
    if (!detected.startsWith(PINNED_WIX_VERSION)) {
      stop(
        `wix resolved to ${detected}, but this repo pins ${PINNED_WIX_VERSION} ` +
          `(/.config/dotnet-tools.json — the OSMF decision, see this file's header comment). ` +
          `A different version here means the tool manifest was bypassed (global tool shadowing ` +
          `it, or restore ran against a different manifest) — fix the resolution rather than ` +
          `building with an unpinned toolset.`,
      );
    }
    // Pin the extensions in lockstep (adds to the project-local .wix/
    // extension cache on first use; idempotent after that). Best-effort:
    // if `extension add` fails (e.g. offline with a cold cache), the
    // build's own versioned -ext references below fail loudly with wix's
    // error rather than silently using a mismatched version.
    for (const pinnedExt of PINNED_EXTENSIONS) {
      try {
        execFileSync("dotnet", ["tool", "run", "wix", "extension", "add", pinnedExt], {
          stdio: "pipe",
          cwd: WINDOWS_DIR,
        });
      } catch (err) {
        log(
          `warning: \`wix extension add ${pinnedExt}\` did not succeed (${String(err.message).slice(0, 120)}) — ` +
            `continuing; the build's versioned -ext reference will fail loudly if the extension truly can't resolve.`,
        );
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Windows Installer's ProductVersion must be plain numeric
// major.minor.build (major/minor < 256, build < 65536) — prerelease
// labels are rejected (WIX1148, diag run 30286420347: "unpredictable and
// undefined", and MajorUpgrade comparisons key on this value). The full
// semver (incl. any -rc.N label) still names the .msi FILE; only the MSI
// metadata version is stripped. Identical for a final x.y.z release.
function msiNumericVersion(version) {
  const numeric = version.split("-")[0];
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(numeric);
  if (!match) {
    stop(`cannot derive an MSI ProductVersion from '${version}' — expected a semver x.y.z core.`);
  }
  const [, major, minor, build] = match.map(Number);
  if (major >= 256 || minor >= 256 || build >= 65536) {
    stop(
      `'${numeric}' exceeds MSI ProductVersion limits (major/minor < 256, build < 65536) — ` +
        "Windows Installer would compare it unpredictably.",
    );
  }
  return numeric;
}

function wixBuild(version, payloadDirs) {
  log("Step 6/7: wix build");
  if (!ensureWixInstalled()) {
    stop(
      `the \`wix\` dotnet tool is not available. The repo pins wix ${PINNED_WIX_VERSION} via ` +
        "/.config/dotnet-tools.json — with a .NET SDK installed, `dotnet tool restore` (from any " +
        "repo directory) is the whole setup; this script already attempts that restore itself, so " +
        "reaching this message usually means no .NET SDK is on PATH at all.\n" +
        "Not auto-installed by this script (I3 lane brief: no system-wide tooling installs without reporting first).\n" +
        `UNVERIFIED on this host (no dotnet — see the I3 report): the pinned-manifest flow (restore → ` +
        `version assert → \`wix extension add ${PINNED_FIREWALL_EXT}\` → versioned -ext build) needs its ` +
        "first real Windows build to prove; flagged in STATE.md's supported-latest sweep ledger.",
    );
  }

  const msiDir = path.join(WINDOWS_DIR, "msi");
  const outFile = path.join(OUT_DIR, `loombre-${version}-windows-x64.msi`);
  mkdirSync(OUT_DIR, { recursive: true });

  run("dotnet", [
    "tool",
    "run",
    "wix",
    "build",
    path.join(msiDir, "Package.wxs"),
    path.join(msiDir, "Directories.wxs"),
    path.join(msiDir, "Files.wxs"),
    path.join(msiDir, "Services.wxs"),
    path.join(msiDir, "Firewall.wxs"),
    path.join(msiDir, "Shortcuts.wxs"),
    "-arch",
    "x64",
    "-ext",
    PINNED_FIREWALL_EXT,
    "-ext",
    PINNED_UTIL_EXT,
    "-d",
    `MsiVersion=${msiNumericVersion(version)}`,
    "-d",
    `PayloadZip=${payloadDirs.payloadZip}`,
    "-d",
    `FfmpegDir=${payloadDirs.ffmpegDir}`,
    "-d",
    `SvcHostDir=${path.join(STAGE_DIR, "svc")}`,
    "-d",
    `TrayPublishDir=${path.join(STAGE_DIR, "tray")}`,
    "-out",
    outFile,
  ], {
    // MUST match ensureWixInstalled's cwd: `wix extension add` (no
    // --global) caches into .wix/ under the CURRENT directory, and
    // `wix build -ext` resolves from the same place — running the build
    // from REPO_ROOT while the add ran here yields WIX0144 "extension
    // could not be found" (diag run 30218552917). Every path argument
    // above is absolute, so the cwd carries no other meaning.
    cwd: WINDOWS_DIR,
  });

  const sizeBytes = existsSync(outFile) ? statSync(outFile).size : 0;
  log(`MSI built: ${outFile} (${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB)`);
  return outFile;
}

// ---------------------------------------------------------------------------
// Step 7: sign hook (no-op in v1 — P4.1)
// ---------------------------------------------------------------------------
function callSignHook(artifactPath) {
  log("Step 7/7: sign hook");
  const signHookPath = path.join(REPO_ROOT, "installers", "sign-hook.mjs");
  if (!existsSync(signHookPath)) {
    warn(
      "installers/sign-hook.mjs does not exist yet (lane I1 deliverable — expected to be a no-op " +
        `passthrough in v1 per P4.1's unsigned posture). Skipping. Once it lands, this script must call:\n` +
        `  node installers/sign-hook.mjs "${artifactPath}"`,
    );
    return;
  }
  // Real interface (verified against the landed file, not guessed): a
  // single positional <artifact> argument — see installers/sign-hook.mjs's
  // own header/usage comment.
  run("node", [signHookPath, artifactPath]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const version = flagValue("version", getProductVersion());
  log(`Loombre Windows MSI build — version ${version}`);

  buildWorkspace();
  const payloadDirs = stagePayloads();

  if (!which("dotnet")) {
    stop(
      "`dotnet` is not on PATH. Install the .NET 8 SDK (https://dotnet.microsoft.com/download/dotnet/8.0) " +
        "to build the tray controller, the service-host wrapper, and to run `wix build`. " +
        "NOT auto-installed by this script (I3 lane brief: no system-wide tooling installs without " +
        "reporting first). Steps 1-2 (workspace build + payload staging) completed above; steps 3-7 " +
        "require dotnet and did not run.",
    );
  }

  buildDotnetProjects(version);
  const msiPath = wixBuild(version, payloadDirs);
  callSignHook(msiPath);

  log("Done.");
}

main();
