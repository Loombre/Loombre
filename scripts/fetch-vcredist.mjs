#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/fetch-vcredist.mjs
//
// Downloads the pinned Microsoft Visual C++ 2015-2022 Redistributable
// (x64) installer for installers/windows/msi/Bundle.wxs to embed as its
// prerequisite package. Same shape as scripts/fetch-node.mjs: a pinned
// manifest (installers/windows/vcredist-manifest.json) supplies an
// immutable versioned URL + sha256, this script downloads through an
// on-disk cache, verifies, and places the file at --dest.
//
// WHY Loombre ships a Microsoft installer at all: two bundled binaries —
// the embedded PostgreSQL server and @napi-rs/keyring's native addon —
// import VCRUNTIME140.dll, which is not part of Windows. v0.9.0-rc.1
// installed "successfully" on a clean Windows 11 machine and then could
// not start anything. vcredist-manifest.json carries the full evidence
// (PE import tables, and the proof that node.exe and sharp do NOT need it)
// and the redistribution-licensing note.
//
// NOT extracted, unlike the node/pg/ffmpeg fetchers: Burn chains the
// vendor's own installer verbatim. Cracking it open to lift raw DLLs would
// mean hand-managing servicing for a security-critical system runtime and
// bypassing the installer's own reference counting — precisely the job
// this executable exists to do correctly.
//
// Usage: node scripts/fetch-vcredist.mjs --dest <file-or-dir>
// Exit 0 = the verified installer is at --dest.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MANIFEST_PATH = join(REPO_ROOT, "installers", "windows", "vcredist-manifest.json");
const CACHE_DIR = join(REPO_ROOT, "vendor", "vcredist-cache");

function fail(message) {
  console.error(`[fetch-vcredist] ${message}`);
  process.exit(1);
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function main() {
  const destArg = argValue("dest");
  if (!destArg) fail("usage: fetch-vcredist.mjs --dest <file-or-dir>");

  if (!existsSync(MANIFEST_PATH)) fail(`missing manifest at ${MANIFEST_PATH}`);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const { url, sha256, sizeBytes, fileName, version } = manifest;
  if (!url || !sha256 || !fileName) {
    fail("manifest is missing one of: url, sha256, fileName");
  }

  // --dest may name the file directly or a directory to drop it into.
  const dest = destArg.toLowerCase().endsWith(".exe") ? resolve(destArg) : join(resolve(destArg), fileName);

  mkdirSync(CACHE_DIR, { recursive: true });
  const cached = join(CACHE_DIR, `${version}-${fileName}`);

  if (existsSync(cached)) {
    // A cached file still gets hashed. The cache lives under vendor/ where
    // any tool or human could have touched it, and this executable is
    // going to be run elevated on a user's machine — "we downloaded it
    // once and trusted it forever" is not a defensible posture for that.
    const cachedHash = sha256File(cached);
    if (cachedHash !== sha256) {
      console.warn(`[fetch-vcredist] cached copy failed verification (${cachedHash}) — refetching`);
      rmSync(cached, { force: true });
    }
  }

  if (!existsSync(cached)) {
    console.log(`[fetch-vcredist] downloading ${fileName} ${version}`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      fail(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const partial = `${cached}.partial`;
    writeFileSync(partial, bytes);
    const actual = sha256File(partial);
    if (actual !== sha256) {
      rmSync(partial, { force: true });
      fail(
        `sha256 mismatch for ${fileName}: expected ${sha256}, got ${actual} — refusing to stage. ` +
          `The manifest pins an IMMUTABLE versioned Microsoft URL, so a mismatch means the bytes are ` +
          `not what was pinned, never routine drift; do not "fix" it by updating the hash without ` +
          `establishing why.`,
      );
    }
    renameSync(partial, cached);
  }

  if (typeof sizeBytes === "number" && statSync(cached).size !== sizeBytes) {
    fail(`size mismatch for ${fileName}: manifest says ${sizeBytes}, file is ${statSync(cached).size}`);
  }

  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  writeFileSync(dest, readFileSync(cached));
  console.log(`[fetch-vcredist] staged VC++ redistributable ${version} -> ${dest}`);
}

await main();
