#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/build-rpm.mjs
//
// Produces loombre-<version>-linux-<arch>.rpm from an already built release
// tarball (installers/linux/build-tarball.mjs's output) — for Fedora, RHEL
// 9+ and derivatives (Rocky, Alma), and openSUSE. The tarball is the ONLY
// input: its payload goes under /opt/loombre unchanged, the checkout's
// systemd/env templates are rendered around it, the package's shared-library
// requirements are derived from the payload's ELF files, and rpmbuild wraps
// the result. See installers/linux/lib/native-package.mjs for the shape and
// every deliberate difference from the tarball channel, and
// docs/install/linux.md for the operator-facing flow.
//
// Usage:
//   node installers/linux/build-rpm.mjs [--tarball <path>] [--out-dir <dir>]
//                                        [--packer auto|native|docker]
//                                        [--allow-template-drift] [--keep-build]
//
//   --tarball   defaults to the newest installers/linux/dist/loombre-*-linux-<host arch>.tar.gz
//   --out-dir   defaults to installers/linux/dist (release.yml passes dist/release)
//   --packer    auto (default): rpmbuild on PATH, else the pinned ubuntu:24.04
//               image via docker — the same rpm 4.18 CI's ubuntu-latest uses.
//   --allow-template-drift  local-dev escape hatch: package a tarball whose
//               bundled templates differ from this checkout's (the package's
//               units would then disagree with that tarball's install.sh).
//
// The build runs `rpmbuild -bb` with a pre-populated buildroot and a
// binary-only spec (no %prep/%build/%install); nothing in the payload is
// stripped, byte-compiled, or shebang-mangled (see the spec's macro block).
// Output naming follows the release convention every artifact shares
// (loombre-<semver>-linux-<x64|arm64>.<ext>, scripts/release/lib/
// build-manifest-lib.mjs) rather than rpm's own NEVRA file name — dnf/rpm
// install by header, not by file name.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rpmRequiresFromScan, scanPayloadDeps } from "./lib/elf-deps.mjs";
import {
  ARCHES,
  DEFAULT_PATHS,
  PACKAGE_META,
  assemblePackageRoot,
  bundledVersionsFromPayload,
  extractTarball,
  parseTarballName,
  payloadPgLibRelative,
  renderRpmSpec,
  resolvePacker,
  rpmLicenseExpression,
  runPacker,
  semverToRpm,
  sha256File,
  templateDrift,
} from "./lib/native-package.mjs";

const LINUX_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(LINUX_DIR, "../..");
const HOST_ARCH = process.arch === "arm64" ? "arm64" : "x64";

export function parseArgs(argv) {
  const out = { tarball: null, outDir: path.join(LINUX_DIR, "dist"), packer: "auto", allowTemplateDrift: false, keepBuild: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tarball") out.tarball = path.resolve(argv[++i]);
    else if (arg === "--out-dir") out.outDir = path.resolve(argv[++i]);
    else if (arg === "--packer") out.packer = argv[++i];
    else if (arg === "--allow-template-drift") out.allowTemplateDrift = true;
    else if (arg === "--keep-build") out.keepBuild = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`build-rpm: unrecognized argument ${arg}`);
  }
  if (!["auto", "native", "docker"].includes(out.packer)) throw new Error(`build-rpm: --packer must be auto, native, or docker (got ${out.packer})`);
  return out;
}

/** The newest dist tarball for the host arch (the same rule smoke.mjs uses). */
export function findDefaultTarball(distDir = path.join(LINUX_DIR, "dist"), arch = HOST_ARCH) {
  if (!existsSync(distDir)) return null;
  const suffix = `-linux-${arch}.tar.gz`;
  const candidates = readdirSync(distDir)
    .filter((f) => f.startsWith("loombre-") && f.endsWith(suffix))
    .map((f) => path.join(distDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function log(msg) {
  console.log(`build-rpm: ${msg}`);
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 * @returns {Promise<{ outputPath: string, sha256: string, sizeBytes: number, version: string, arch: string, requires: string[] }>}
 */
export async function buildRpm(args) {
  const tarballPath = args.tarball ?? findDefaultTarball();
  if (!tarballPath) throw new Error("build-rpm: no --tarball given and no loombre-*-linux-<arch>.tar.gz in installers/linux/dist — run build-tarball.mjs first");
  if (!existsSync(tarballPath)) throw new Error(`build-rpm: ${tarballPath} does not exist`);
  const { name, version, arch } = parseTarballName(tarballPath);
  const archInfo = ARCHES[arch];
  const { version: rpmVersion, release } = semverToRpm(version);
  log(`${name} -> loombre-${version}-linux-${arch}.rpm (Version ${rpmVersion}, Release ${release}, arch ${archInfo.rpm})`);

  const workDir = path.join(LINUX_DIR, ".build", "pkg", `rpm-${name}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  log("extracting the tarball");
  const payloadDir = extractTarball(tarballPath, path.join(workDir, "extract"));

  const drift = templateDrift(payloadDir, LINUX_DIR);
  if (drift.length > 0) {
    const detail = drift.map((d) => `${d.file} (${d.reason})`).join(", ");
    if (!args.allowTemplateDrift) {
      throw new Error(
        `build-rpm: the tarball's bundled templates differ from this checkout's: ${detail}. ` +
          "Rebuild the tarball (node installers/linux/build-tarball.mjs) so the package's units and env file match its install.sh, or pass --allow-template-drift for a local experiment.",
      );
    }
    log(`WARNING: template drift ignored (--allow-template-drift): ${detail}`);
  }

  const bundled = bundledVersionsFromPayload(payloadDir, REPO_ROOT);
  log(`bundled: node ${bundled.node}, ffmpeg ${bundled.ffmpeg}, postgresql ${bundled.postgresql}`);

  log("staging the buildroot");
  const rootDir = path.join(workDir, "root");
  const { inventory } = assemblePackageRoot({
    payloadDir,
    rootDir,
    paths: DEFAULT_PATHS,
    templatesDir: LINUX_DIR,
    version,
    bundled,
    licensePath: path.join(REPO_ROOT, "LICENSE"),
  });

  log("deriving Requires from the payload's ELF files");
  const prefixInRoot = path.join(rootDir, ...DEFAULT_PATHS.prefix.split("/").filter(Boolean));
  const scan = scanPayloadDeps(prefixInRoot, { excludeDirs: [payloadPgLibRelative(payloadDir)] });
  if (scan.machines.size !== 1 || !scan.machines.has(archInfo.elf)) {
    throw new Error(`build-rpm: the payload's ELF machine types are ${[...scan.machines].join(", ") || "none"} but the tarball claims ${arch} (${archInfo.elf}) — refusing to package a mismatched arch`);
  }
  const requires = rpmRequiresFromScan(scan);
  log(`${scan.files.length} ELF files scanned; ${scan.externalSonames.length} external libraries -> ${requires.length} Requires; self-provided: ${scan.provided.join(", ")}`);
  for (const r of requires) console.log(`  Requires: ${r}`);

  const licenseExpression = rpmLicenseExpression(inventory);
  log(`License: ${licenseExpression}`);
  const spec = renderRpmSpec({ meta: PACKAGE_META, paths: DEFAULT_PATHS, version, rpmVersion, release, requires, bundled, licenseExpression });
  const specsDir = path.join(workDir, "SPECS");
  mkdirSync(specsDir, { recursive: true });
  const specPath = path.join(specsDir, "loombre.spec");
  writeFileSync(specPath, spec);
  const topDir = path.join(workDir, "topdir");
  mkdirSync(topDir, { recursive: true });

  const packer = resolvePacker("rpmbuild", { mode: args.packer });
  log(`rpmbuild via ${packer.kind === "native" ? packer.path : `docker (${packer.image})`}`);
  // In docker mode workDir is mounted at /work; every path handed to
  // rpmbuild must be expressed under that mount.
  const pathFor = (p) => (packer.kind === "native" ? p : `/work/${path.relative(workDir, p).split(path.sep).join("/")}`);
  runPacker(packer, {
    tool: "rpmbuild",
    workDir,
    prepare: packer.kind === "docker" ? "apt-get update -qq >/dev/null && apt-get install -y -qq rpm >/dev/null" : undefined,
    args: [
      "-bb",
      "--target", `${archInfo.rpm}-linux`,
      "--buildroot", pathFor(rootDir),
      "--define", `_topdir ${pathFor(topDir)}`,
      pathFor(specPath),
    ],
  });

  const rpmsDir = path.join(topDir, "RPMS", archInfo.rpm);
  const built = existsSync(rpmsDir) ? readdirSync(rpmsDir).filter((f) => f.endsWith(".rpm")) : [];
  if (built.length !== 1) throw new Error(`build-rpm: expected exactly one .rpm under ${rpmsDir}, found ${built.length}`);

  mkdirSync(args.outDir, { recursive: true });
  const outputPath = path.join(args.outDir, `loombre-${version}-linux-${arch}.rpm`);
  rmSync(outputPath, { force: true });
  copyFileSync(path.join(rpmsDir, built[0]), outputPath);

  const { spawnSync } = await import("node:child_process");
  const hook = spawnSync(process.execPath, [path.join(REPO_ROOT, "installers", "sign-hook.mjs"), outputPath], { stdio: "inherit" });
  if (hook.status !== 0) throw new Error("build-rpm: sign-hook failed");

  if (!args.keepBuild) rmSync(workDir, { recursive: true, force: true });

  const sha256 = sha256File(outputPath);
  const sizeBytes = statSync(outputPath).size;
  console.log("\n=== build-rpm: DONE ===");
  console.log(`artifact: ${outputPath}`);
  console.log(`sizeBytes: ${sizeBytes}`);
  console.log(`sha256: ${sha256}`);
  return { outputPath, sha256, sizeBytes, version, arch, requires };
}

const isDirectEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntrypoint) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  if (args.help) {
    console.log(
      "Usage: node installers/linux/build-rpm.mjs [--tarball <path>] [--out-dir <dir>] [--packer auto|native|docker] [--allow-template-drift] [--keep-build]",
    );
    process.exit(0);
  }
  buildRpm(args).catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
