#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/fetch-node.mjs
//
// SHARED bundled-Node fetcher (docs/PLAN.md §11: single Node runtime per
// platform, no user-installed Node) — the consolidation lanes I1/I3/I4
// kept asking for. Manifest-pinned like ffmpeg/embedded-pg: every entry
// in installers/node-manifest.json is an official nodejs.org dist URL
// with a locally-re-verified sha256. No live version resolution here —
// bumping Node is a manifest edit reviewed like any other pin (N2).
//
// Usage: node scripts/fetch-node.mjs --platform win-x64 --dest <dir>
//   Downloads (with on-disk cache), sha256-verifies, extracts, strips the
//   archive's root dir so <dir> holds the runtime directly (win-x64:
//   <dir>/node.exe — the zip has no bin/; tar platforms: <dir>/bin/node).
//
// Current callers: installers/windows/build-msi.mjs (lane I3). Lanes I1
// (installers/linux/build-tarball.mjs) and I4 (installers/macos/pkg/
// fetch-node.mjs) still carry their own pre-consolidation fetch code —
// fold them in on their next touch.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(REPO_ROOT, "installers", "node-manifest.json");
const CACHE_DIR = join(REPO_ROOT, "vendor", "node-cache");

function fail(message) {
  console.error(`[fetch-node] ${message}`);
  process.exit(1);
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function extractArchive(archivePath, format, intoDir) {
  // bsdtar everywhere: System32\tar.exe on Windows (absolute path so a
  // GNU tar on PATH can't take over — it cannot read zip), /usr/bin/tar
  // (bsdtar) on macOS; both handle zip AND tar.xz.
  const tarExe =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const args = format === "zip" ? ["-x", "-f", archivePath, "-C", intoDir] : ["-xJf", archivePath, "-C", intoDir];
  execFileSync(tarExe, args, { stdio: "inherit" });
}

async function main() {
  const platform = argValue("platform");
  const dest = argValue("dest");
  if (!platform || !dest) fail("usage: fetch-node.mjs --platform <manifest key> --dest <dir>");

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const entry = manifest.platforms[platform];
  if (!entry) fail(`no installers/node-manifest.json entry for '${platform}' (have: ${Object.keys(manifest.platforms).join(", ")})`);

  mkdirSync(CACHE_DIR, { recursive: true });
  const archiveName = entry.url.split("/").at(-1);
  const cachedArchive = join(CACHE_DIR, archiveName);

  if (existsSync(cachedArchive) && sha256File(cachedArchive) === entry.sha256) {
    console.log(`[fetch-node] cache hit: ${archiveName}`);
  } else {
    console.log(`[fetch-node] downloading ${entry.url}`);
    const response = await fetch(entry.url);
    if (!response.ok) fail(`download failed: HTTP ${response.status} for ${entry.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(cachedArchive, bytes);
  }

  const actual = sha256File(cachedArchive);
  if (actual !== entry.sha256) {
    rmSync(cachedArchive, { force: true });
    fail(`sha256 mismatch for ${archiveName}: expected ${entry.sha256}, got ${actual} — refusing to stage; cached file removed`);
  }

  const scratch = `${dest}-extract`;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  extractArchive(cachedArchive, entry.format, scratch);

  const rootDir = join(scratch, entry.archiveRootDir);
  if (!existsSync(rootDir)) {
    const seen = readdirSync(scratch).join(", ");
    fail(`expected archive root '${entry.archiveRootDir}' not found after extraction (saw: ${seen})`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(rootDir, dest);
  rmSync(scratch, { recursive: true, force: true });

  const probe = platform.startsWith("win") ? join(dest, "node.exe") : join(dest, "bin", "node");
  if (!existsSync(probe)) fail(`staged runtime is missing its node binary at ${probe}`);
  console.log(`[fetch-node] staged Node ${manifest.nodeVersion} (${platform}) -> ${dest}`);
}

await main();
