#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/macos/pkg/fetch-node.mjs
//
// Downloads the official Node.js darwin tarball for a given arch, verifies
// it against nodejs.org's published SHASUMS256.txt, and extracts it into
// destDir. Cached under installers/macos/.build-cache/node/ so repeat
// `build-pkg.mjs` runs (and CI, later) don't re-download.
//
// NOT the P4.11 version-stamping seam — this fetches the *runtime* Node
// binary bundled into the payload, pinned to the repo's .nvmrc major, not
// the Loombre product version.
//
// Deliberately dependency-free (node:https/node:crypto/node:fs only) —
// LOCKFILE FROZEN for this lane, no pnpm deps.

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CACHE_DIR = path.join(__dirname, "..", ".build-cache", "node");

/** Reads the repo's pinned Node major version straight from .nvmrc — one
 *  source of truth, same file `pnpm dev`/CI already treat as authoritative. */
function pinnedMajor() {
  const raw = readFileSync(path.join(REPO_ROOT, ".nvmrc"), "utf8").trim();
  const major = Number.parseInt(raw, 10);
  if (!Number.isInteger(major) || major < 1) {
    throw new Error(`.nvmrc did not contain a usable major version: ${JSON.stringify(raw)}`);
  }
  return major;
}

function nodeArchName(arch) {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  throw new Error(`fetch-node: unsupported arch ${arch}`);
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    https
      .get(url, { headers: { "user-agent": "loombre-installer-build/0.1" } }, (res) => {
        if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          rmSync(destPath, { force: true });
          download(res.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} -> ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(undefined)));
      })
      .on("error", reject);
  });
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

/**
 * Resolves the latest published patch for `major` by reading nodejs.org's
 * index.json (small JSON, one request) rather than hardcoding a patch
 * version that goes stale the day it's written.
 */
async function resolveFullVersion(major) {
  const indexPath = path.join(CACHE_DIR, "index.json");
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(indexPath)) {
    await download("https://nodejs.org/dist/index.json", indexPath);
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const match = index.find((entry) => entry.version.startsWith(`v${major}.`));
  if (!match) throw new Error(`fetch-node: no published Node release found for major ${major}`);
  return match.version; // e.g. "v24.18.0"
}

/**
 * fetchNode({ arch, destDir }) -> { nodePath, version }
 * Downloads + verifies + extracts the darwin Node tarball for `arch` into
 * destDir/bin/node (plus lib/ etc. alongside, exactly node's own tarball
 * layout under destDir/). Idempotent: a destDir that already contains a
 * `bin/node` for the resolved version is left alone.
 */
export async function fetchNode({ arch, destDir }) {
  const major = pinnedMajor();
  const version = await resolveFullVersion(major);
  const archName = nodeArchName(arch);
  const tarballName = `node-${version}-darwin-${archName}.tar.gz`;
  const url = `https://nodejs.org/dist/${version}/${tarballName}`;
  const shasumsUrl = `https://nodejs.org/dist/${version}/SHASUMS256.txt`;

  mkdirSync(CACHE_DIR, { recursive: true });
  const tarballPath = path.join(CACHE_DIR, tarballName);
  const shasumsPath = path.join(CACHE_DIR, `SHASUMS256-${version}.txt`);

  const markerPath = path.join(destDir, ".fetched-version");
  if (existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === `${version}-${archName}`) {
    return { nodePath: path.join(destDir, "bin", "node"), version };
  }

  if (!existsSync(tarballPath)) {
    console.log(`[fetch-node] downloading ${url}`);
    await download(url, tarballPath);
  } else {
    console.log(`[fetch-node] using cached ${tarballPath}`);
  }
  if (!existsSync(shasumsPath)) {
    await download(shasumsUrl, shasumsPath);
  }

  const shasums = readFileSync(shasumsPath, "utf8");
  const line = shasums.split("\n").find((l) => l.trim().endsWith(tarballName));
  if (!line) throw new Error(`fetch-node: SHASUMS256.txt has no entry for ${tarballName}`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = sha256File(tarballPath);
  if (expected !== actual) {
    throw new Error(
      `fetch-node: checksum mismatch for ${tarballName}\n  expected ${expected}\n  actual   ${actual}`,
    );
  }
  console.log(`[fetch-node] sha256 verified against nodejs.org SHASUMS256.txt`);

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", tarballPath, "-C", destDir, "--strip-components=1"], {
    stdio: "inherit",
  });
  if (tar.status !== 0) throw new Error(`fetch-node: tar extract failed (status ${tar.status})`);

  const { writeFileSync } = await import("node:fs");
  writeFileSync(markerPath, `${version}-${archName}\n`);

  return { nodePath: path.join(destDir, "bin", "node"), version };
}
