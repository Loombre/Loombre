#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/fetch-libxml2.mjs
//
// Fetches the pinned libxml2.so.2 shared library for one Linux platform
// from installers/libxml2-manifest.json — a Rocky Linux 9 .rpm whose sha256
// is verified BEFORE anything is extracted — and writes the library (named
// by its SONAME) plus its license text into a gitignored vendor directory,
// vendor/libxml2/<platform>/. installers/linux/build-tarball.mjs's assemblePg
// stages the result next to the embedded PostgreSQL's own libraries
// (pg/<platform>/<version>/lib/), where PostgreSQL's RUNPATH $ORIGIN/../lib
// finds it first. See the manifest's `provenance.note` for WHY (libxml2 2.14
// bumped its soname to .so.16; Ubuntu 25.10 / 26.04 LTS ship no
// libxml2.so.2 at all, and the PostgreSQL binaries link it).
//
// Usage:
//   node scripts/fetch-libxml2.mjs [--platform linux-x64|linux-arm64|all|host]
//                                   [--manifest <path>] [--vendor-dir <path>]
//                                   [--force] [--check-urls]
//
//   --check-urls  probe every pinned URL with a HEAD request (no download,
//                 no vendor writes) and exit non-zero if any does not answer
//                 200 — the vendor-liveness workflow's daily check.
//
// Skip-if-present: vendor-dir/<platform>/PROVENANCE.json records the sha256
// the manifest pinned when the library was last extracted; a match skips the
// download (--force overrides), the same contract scripts/fetch-ffmpeg.mjs
// and fetch-embedded-pg.mjs follow.
//
// Extraction: an .rpm's payload is a compressed cpio archive. `rpm2cpio |
// cpio` is used where both exist (release.yml's ubuntu-latest after
// `apt install rpm`; any rpm-based host), else `bsdtar -xf` (libarchive
// reads .rpm natively — macOS's /usr/bin/tar). No rpm database is touched
// and nothing is installed: exactly two files leave the archive.
//
// Pure helpers (manifest validation, arg parsing, platform resolution) are
// exported from the top of the file for scripts/fetch-libxml2.test.mjs;
// only the bottom, past the isDirectEntrypoint guard, performs I/O.

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const DEFAULT_MANIFEST_PATH = join(REPO_ROOT, "installers", "libxml2-manifest.json");
export const DEFAULT_VENDOR_DIR = join(REPO_ROOT, "vendor", "libxml2");
export const KNOWN_PLATFORMS = Object.freeze(["linux-x64", "linux-arm64"]);
export const LICENSE_FILENAME = "LICENSE.libxml2.txt";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

// ─────────────────────────────────────────────────────────────────────────
// Pure functions
// ─────────────────────────────────────────────────────────────────────────

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Never throws on a mismatch — returns { ok, actual, expected } so the
 *  caller decides how loudly to fail; a malformed pin IS a thrown error. */
export function verifyChecksum(buffer, expectedSha256Hex) {
  if (typeof expectedSha256Hex !== "string" || !SHA256_HEX_PATTERN.test(expectedSha256Hex.toLowerCase())) {
    throw new TypeError(`verifyChecksum: expectedSha256Hex must be 64 hex chars, got ${JSON.stringify(expectedSha256Hex)}`);
  }
  const actual = sha256Hex(buffer);
  return { ok: actual === expectedSha256Hex.toLowerCase(), actual, expected: expectedSha256Hex.toLowerCase() };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/** Structural validation of installers/libxml2-manifest.json — hand-written
 *  (no schema library), returns { ok, errors }, never throws. */
export function validateManifestSchema(manifest) {
  const errors = [];
  if (typeof manifest !== "object" || manifest === null) return { ok: false, errors: ["manifest: expected an object"] };
  if (manifest.manifestSchemaVersion !== 1) errors.push(`manifestSchemaVersion: expected 1, got ${JSON.stringify(manifest.manifestSchemaVersion)}`);
  if (!Number.isInteger(manifest.pinnedAtMs) || manifest.pinnedAtMs < 0) errors.push("pinnedAtMs: expected a non-negative integer");
  if (typeof manifest.provenance !== "object" || manifest.provenance === null) errors.push("provenance: expected an object");
  else {
    for (const key of ["note", "license", "extraction"]) {
      if (!isNonEmptyString(manifest.provenance[key])) errors.push(`provenance.${key}: expected a non-empty string`);
    }
  }
  if (typeof manifest.platforms !== "object" || manifest.platforms === null) {
    errors.push("platforms: expected an object");
    return { ok: errors.length === 0, errors };
  }
  for (const platform of Object.keys(manifest.platforms)) {
    if (!KNOWN_PLATFORMS.includes(platform)) {
      errors.push(`platforms.${platform}: not a known platform (${KNOWN_PLATFORMS.join(", ")})`);
      continue;
    }
    const entry = manifest.platforms[platform];
    const path = `platforms.${platform}`;
    for (const key of ["source", "package", "url", "libraryEntry", "licenseEntry", "soname", "libxml2Version", "verification"]) {
      if (!isNonEmptyString(entry[key])) errors.push(`${path}.${key}: expected a non-empty string`);
    }
    if (isNonEmptyString(entry.url) && !/^https:\/\//.test(entry.url)) errors.push(`${path}.url: must be https`);
    if (isNonEmptyString(entry.package) && isNonEmptyString(entry.url) && !entry.url.endsWith(`/${entry.package}`)) {
      errors.push(`${path}.url: must end with /${entry.package}`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_HEX_PATTERN.test(entry.sha256)) errors.push(`${path}.sha256: expected 64 lowercase hex chars`);
    if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0) errors.push(`${path}.sizeBytes: expected a positive integer`);
    if (isNonEmptyString(entry.soname) && !/^libxml2\.so\.\d+$/.test(entry.soname)) errors.push(`${path}.soname: expected libxml2.so.<N>`);
    if (isNonEmptyString(entry.libraryEntry) && !entry.libraryEntry.startsWith("./")) errors.push(`${path}.libraryEntry: cpio member paths start with ./`);
    if (isNonEmptyString(entry.licenseEntry) && !entry.licenseEntry.startsWith("./")) errors.push(`${path}.licenseEntry: cpio member paths start with ./`);
  }
  return { ok: errors.length === 0, errors };
}

export function resolveHostPlatform(platformArg, { platform = process.platform, arch = process.arch } = {}) {
  if (platformArg && platformArg !== "host") return platformArg;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  throw new Error(`fetch-libxml2: cannot auto-detect a pinned platform for ${platform}/${arch} — pass --platform explicitly`);
}

export function parseArgs(argv) {
  const out = { platform: "host", manifestPath: DEFAULT_MANIFEST_PATH, vendorDir: DEFAULT_VENDOR_DIR, force: false, checkUrls: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--platform") out.platform = argv[++i];
    else if (arg === "--manifest") out.manifestPath = resolve(argv[++i]);
    else if (arg === "--vendor-dir") out.vendorDir = resolve(argv[++i]);
    else if (arg === "--force") out.force = true;
    else if (arg === "--check-urls") out.checkUrls = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`fetch-libxml2: unrecognized argument ${arg}`);
  }
  return out;
}

export function loadManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const { ok, errors } = validateManifestSchema(manifest);
  if (!ok) throw new Error(`fetch-libxml2: ${manifestPath} failed schema validation:\n  - ${errors.join("\n  - ")}`);
  return manifest;
}

// ─────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────

async function downloadToBuffer(url) {
  const res = await fetch(url, { headers: { "user-agent": "loombre-fetch-libxml2" }, redirect: "follow" });
  if (res.status !== 200) throw new Error(`fetch-libxml2: GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function which(tool) {
  return spawnSync("which", [tool], { encoding: "utf8" }).status === 0;
}

/** Extract two members of an .rpm into destDir, returning their paths. */
export function extractRpmMembers(rpmPath, destDir, members) {
  mkdirSync(destDir, { recursive: true });
  let res;
  if (which("rpm2cpio") && which("cpio")) {
    res = spawnSync("sh", ["-c", `rpm2cpio ${JSON.stringify(rpmPath)} | cpio -idm --quiet ${members.map((m) => JSON.stringify(m)).join(" ")}`], { cwd: destDir, encoding: "utf8" });
  } else if (which("bsdtar") || which("tar")) {
    const tar = which("bsdtar") ? "bsdtar" : "tar";
    res = spawnSync(tar, ["-xf", rpmPath, "-C", destDir, ...members], { encoding: "utf8" });
    if (res.status !== 0 && tar === "tar") {
      throw new Error(`fetch-libxml2: this tar cannot read .rpm archives (${res.stderr.trim()}) — install rpm2cpio+cpio (apt install rpm cpio) or libarchive's bsdtar`);
    }
  } else {
    throw new Error("fetch-libxml2: need rpm2cpio+cpio or bsdtar to extract an .rpm");
  }
  if (res.status !== 0) throw new Error(`fetch-libxml2: extraction failed: ${res.stderr}`);
  return members.map((m) => {
    const p = join(destDir, m);
    if (!existsSync(p)) throw new Error(`fetch-libxml2: ${m} not found in ${rpmPath} after extraction`);
    return p;
  });
}

function provenancePath(vendorPlatformDir) {
  return join(vendorPlatformDir, "PROVENANCE.json");
}

function isAlreadyFetched(vendorPlatformDir, entry) {
  const prov = provenancePath(vendorPlatformDir);
  if (!existsSync(prov)) return false;
  try {
    const recorded = JSON.parse(readFileSync(prov, "utf8"));
    return recorded.sha256 === entry.sha256 && existsSync(join(vendorPlatformDir, entry.soname)) && existsSync(join(vendorPlatformDir, LICENSE_FILENAME));
  } catch {
    return false;
  }
}

async function fetchPlatform(platform, manifest, vendorDir, force) {
  const entry = manifest.platforms[platform];
  if (!entry) throw new Error(`fetch-libxml2: ${platform} is not pinned in the manifest (${Object.keys(manifest.platforms).join(", ")})`);
  const vendorPlatformDir = join(vendorDir, platform);
  if (!force && isAlreadyFetched(vendorPlatformDir, entry)) {
    console.log(`fetch-libxml2[${platform}]: already present with matching sha256 — skipping (--force to re-fetch)`);
    return;
  }
  console.log(`fetch-libxml2[${platform}]: downloading ${entry.url}`);
  const bytes = await downloadToBuffer(entry.url);
  if (bytes.length !== entry.sizeBytes) {
    throw new Error(`fetch-libxml2[${platform}]: size mismatch — got ${bytes.length} bytes, manifest pins ${entry.sizeBytes}`);
  }
  const check = verifyChecksum(bytes, entry.sha256);
  if (!check.ok) {
    throw new Error(`fetch-libxml2[${platform}]: sha256 MISMATCH for ${entry.package} — got ${check.actual}, manifest pins ${check.expected}. Refusing to extract.`);
  }
  console.log(`fetch-libxml2[${platform}]: sha256 verified (${check.actual})`);

  const tmp = mkdtempSync(join(tmpdir(), "loombre-libxml2-"));
  try {
    const rpmPath = join(tmp, entry.package);
    writeFileSync(rpmPath, bytes);
    const [libPath, licensePath] = extractRpmMembers(rpmPath, join(tmp, "x"), [entry.libraryEntry, entry.licenseEntry]);
    rmSync(vendorPlatformDir, { recursive: true, force: true });
    mkdirSync(vendorPlatformDir, { recursive: true });
    copyFileSync(libPath, join(vendorPlatformDir, entry.soname));
    chmodSync(join(vendorPlatformDir, entry.soname), 0o755);
    copyFileSync(licensePath, join(vendorPlatformDir, LICENSE_FILENAME));
    chmodSync(join(vendorPlatformDir, LICENSE_FILENAME), 0o644);
    writeFileSync(
      provenancePath(vendorPlatformDir),
      `${JSON.stringify(
        {
          platform,
          package: entry.package,
          sourceUrl: entry.url,
          sha256: entry.sha256,
          soname: entry.soname,
          libxml2Version: entry.libxml2Version,
          vendoredAs: entry.soname,
          license: LICENSE_FILENAME,
          fetchedAtMs: Date.now(),
          manifestPinnedAtMs: manifest.pinnedAtMs,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`fetch-libxml2[${platform}]: vendored ${entry.soname} (libxml2 ${entry.libxml2Version}) + ${LICENSE_FILENAME} into ${vendorPlatformDir}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function checkUrls(manifest) {
  let failed = 0;
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    let status;
    try {
      const res = await fetch(entry.url, { method: "HEAD", headers: { "user-agent": "loombre-fetch-libxml2" }, redirect: "follow" });
      status = res.status;
      if (status !== 200) failed += 1;
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
      failed += 1;
    }
    console.log(`  ${status === 200 ? "OK  " : "MISS"} [${platform}] ${entry.url} -> ${status}`);
  }
  if (failed > 0) throw new Error(`fetch-libxml2: ${failed} pinned URL(s) did not answer 200`);
  console.log("fetch-libxml2: every pinned URL answers 200");
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: node scripts/fetch-libxml2.mjs [--platform linux-x64|linux-arm64|all|host] [--manifest <path>] [--vendor-dir <path>] [--force] [--check-urls]");
    return;
  }
  const manifest = loadManifest(args.manifestPath);
  if (args.checkUrls) {
    await checkUrls(manifest);
    return;
  }
  const platforms = args.platform === "all" ? Object.keys(manifest.platforms) : [resolveHostPlatform(args.platform)];
  for (const platform of platforms) await fetchPlatform(platform, manifest, args.vendorDir, args.force);
}

const isDirectEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectEntrypoint) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
