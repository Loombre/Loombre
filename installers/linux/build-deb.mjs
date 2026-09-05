#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/linux/build-deb.mjs
//
// Produces loombre-<version>-linux-<arch>.deb from an already built release
// tarball (installers/linux/build-tarball.mjs's output) — for Debian 12+
// and Ubuntu 22.04+ (the payload's embedded PostgreSQL needs glibc 2.34).
// Same one-payload design as build-rpm.mjs (see installers/linux/lib/
// native-package.mjs): the tarball's payload goes under /opt/loombre
// unchanged, the checkout's templates are rendered around it, Depends are
// derived from the payload's ELF files through a soname -> package map, and
// `dpkg-deb --build --root-owner-group` wraps the result.
//
// Usage:
//   node installers/linux/build-deb.mjs [--tarball <path>] [--out-dir <dir>]
//                                        [--packer auto|native|docker]
//                                        [--allow-template-drift] [--keep-build]
//
// Flags mean exactly what build-rpm.mjs's do. The docker fallback is the
// same pinned ubuntu:24.04 image (dpkg-deb is part of dpkg, always present).
//
// Layout of the built package: control.tar carries control, md5sums and
// the four maintainer scripts (Debian Policy chapter 6, POSIX sh); data.tar
// carries the staged tree. Ownership inside data.tar is root:root by
// construction (--root-owner-group), which is why postinst records the
// service user's ownership of /var/lib/loombre and the Next cache dir with
// dpkg-statoverride. No conffile: the env file is maintainer-script managed
// (see lib/native-package.mjs's header).

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

import { debDependsFromScan, scanPayloadDeps } from "./lib/elf-deps.mjs";
import {
  ARCHES,
  DEFAULT_PATHS,
  PACKAGE_META,
  assemblePackageRoot,
  bundledVersionsFromPayload,
  debChangelogText,
  debMd5sums,
  extractTarball,
  parseTarballName,
  payloadPgLibRelative,
  renderDebControl,
  renderDebMaintainerScripts,
  resolvePacker,
  runPacker,
  semverToDeb,
  sha256File,
  templateDrift,
  treeSizeKb,
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
    else throw new Error(`build-deb: unrecognized argument ${arg}`);
  }
  if (!["auto", "native", "docker"].includes(out.packer)) throw new Error(`build-deb: --packer must be auto, native, or docker (got ${out.packer})`);
  return out;
}

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
  console.log(`build-deb: ${msg}`);
}

/** RFC 2822 date for the changelog stamp (dpkg-parsechangelog's format). */
function rfc2822(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 * @returns {Promise<{ outputPath: string, sha256: string, sizeBytes: number, version: string, arch: string, depends: string[] }>}
 */
export async function buildDeb(args) {
  const tarballPath = args.tarball ?? findDefaultTarball();
  if (!tarballPath) throw new Error("build-deb: no --tarball given and no loombre-*-linux-<arch>.tar.gz in installers/linux/dist — run build-tarball.mjs first");
  if (!existsSync(tarballPath)) throw new Error(`build-deb: ${tarballPath} does not exist`);
  const { name, version, arch } = parseTarballName(tarballPath);
  const archInfo = ARCHES[arch];
  const debVersion = semverToDeb(version);
  log(`${name} -> loombre-${version}-linux-${arch}.deb (Version ${debVersion}, Architecture ${archInfo.deb})`);

  const workDir = path.join(LINUX_DIR, ".build", "pkg", `deb-${name}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  log("extracting the tarball");
  const payloadDir = extractTarball(tarballPath, path.join(workDir, "extract"));

  const drift = templateDrift(payloadDir, LINUX_DIR);
  if (drift.length > 0) {
    const detail = drift.map((d) => `${d.file} (${d.reason})`).join(", ");
    if (!args.allowTemplateDrift) {
      throw new Error(
        `build-deb: the tarball's bundled templates differ from this checkout's: ${detail}. ` +
          "Rebuild the tarball (node installers/linux/build-tarball.mjs) so the package's units and env file match its install.sh, or pass --allow-template-drift for a local experiment.",
      );
    }
    log(`WARNING: template drift ignored (--allow-template-drift): ${detail}`);
  }

  const bundled = bundledVersionsFromPayload(payloadDir, REPO_ROOT);
  log(`bundled: node ${bundled.node}, ffmpeg ${bundled.ffmpeg}, postgresql ${bundled.postgresql}`);

  log("staging the package tree");
  // dpkg-deb builds from a directory whose DEBIAN/ subdir holds the control
  // files and whose other contents become data.tar — so the staged root IS
  // the package dir.
  const pkgDir = path.join(workDir, "pkg");
  assemblePackageRoot({
    payloadDir,
    rootDir: pkgDir,
    paths: DEFAULT_PATHS,
    templatesDir: LINUX_DIR,
    version,
    bundled,
    licensePath: path.join(REPO_ROOT, "LICENSE"),
  });
  // Debian-specific doc: a one-entry changelog.gz (lintian hygiene; a
  // version without a Debian revision is "native", hence not changelog.Debian.gz).
  const docDir = path.join(pkgDir, ...DEFAULT_PATHS.docDir.split("/").filter(Boolean));
  writeFileSync(path.join(docDir, "changelog.gz"), gzipSync(Buffer.from(debChangelogText({ debVersion, date: rfc2822(new Date()) })), { level: 9 }));
  chmodSync(path.join(docDir, "changelog.gz"), 0o644);

  log("deriving Depends from the payload's ELF files");
  const prefixInRoot = path.join(pkgDir, ...DEFAULT_PATHS.prefix.split("/").filter(Boolean));
  const scan = scanPayloadDeps(prefixInRoot, { excludeDirs: [payloadPgLibRelative(payloadDir)] });
  if (scan.machines.size !== 1 || !scan.machines.has(archInfo.elf)) {
    throw new Error(`build-deb: the payload's ELF machine types are ${[...scan.machines].join(", ") || "none"} but the tarball claims ${arch} (${archInfo.elf}) — refusing to package a mismatched arch`);
  }
  const depends = debDependsFromScan(scan);
  log(`${scan.files.length} ELF files scanned; ${scan.externalSonames.length} external libraries -> Depends: ${depends.join(", ")}`);

  const installedSizeKb = treeSizeKb(pkgDir);
  const control = renderDebControl({ meta: PACKAGE_META, debVersion, debArch: archInfo.deb, depends, installedSizeKb });
  const scripts = renderDebMaintainerScripts({ paths: DEFAULT_PATHS });
  const debianDir = path.join(pkgDir, "DEBIAN");
  mkdirSync(debianDir, { recursive: true });
  chmodSync(debianDir, 0o755);
  writeFileSync(path.join(debianDir, "control"), control);
  // md5sums: what `dpkg -V` / debsums verify against (dpkg-deb itself never
  // writes it). Written before the maintainer scripts so it lists only the
  // data tree.
  writeFileSync(path.join(debianDir, "md5sums"), debMd5sums(pkgDir));
  for (const script of ["preinst", "postinst", "prerm", "postrm"]) {
    writeFileSync(path.join(debianDir, script), scripts[script]);
    chmodSync(path.join(debianDir, script), 0o755);
  }
  chmodSync(path.join(debianDir, "control"), 0o644);
  chmodSync(path.join(debianDir, "md5sums"), 0o644);

  const packer = resolvePacker("dpkg-deb", { mode: args.packer });
  log(`dpkg-deb via ${packer.kind === "native" ? packer.path : `docker (${packer.image})`}`);
  const outDirInWork = path.join(workDir, "out");
  mkdirSync(outDirInWork, { recursive: true });
  const pathFor = (p) => (packer.kind === "native" ? p : `/work/${path.relative(workDir, p).split(path.sep).join("/")}`);
  const builtName = `loombre_${debVersion}_${archInfo.deb}.deb`;
  runPacker(packer, {
    tool: "dpkg-deb",
    workDir,
    args: ["--build", "--root-owner-group", "-Zxz", pathFor(pkgDir), pathFor(path.join(outDirInWork, builtName))],
  });
  const builtPath = path.join(outDirInWork, builtName);
  if (!existsSync(builtPath)) throw new Error(`build-deb: dpkg-deb did not produce ${builtPath}`);

  mkdirSync(args.outDir, { recursive: true });
  const outputPath = path.join(args.outDir, `loombre-${version}-linux-${arch}.deb`);
  rmSync(outputPath, { force: true });
  copyFileSync(builtPath, outputPath);

  const { spawnSync } = await import("node:child_process");
  const hook = spawnSync(process.execPath, [path.join(REPO_ROOT, "installers", "sign-hook.mjs"), outputPath], { stdio: "inherit" });
  if (hook.status !== 0) throw new Error("build-deb: sign-hook failed");

  if (!args.keepBuild) rmSync(workDir, { recursive: true, force: true });

  const sha256 = sha256File(outputPath);
  const sizeBytes = statSync(outputPath).size;
  console.log("\n=== build-deb: DONE ===");
  console.log(`artifact: ${outputPath}`);
  console.log(`sizeBytes: ${sizeBytes}`);
  console.log(`sha256: ${sha256}`);
  return { outputPath, sha256, sizeBytes, version, arch, depends };
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
      "Usage: node installers/linux/build-deb.mjs [--tarball <path>] [--out-dir <dir>] [--packer auto|native|docker] [--allow-template-drift] [--keep-build]",
    );
    process.exit(0);
  }
  buildDeb(args).catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
