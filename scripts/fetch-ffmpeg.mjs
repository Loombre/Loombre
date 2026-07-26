#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/fetch-ffmpeg.mjs
//
// SHARED deliverable (Phase 4 lanes I1/I3/I4 all call this): downloads the
// pinned static ffmpeg+ffprobe pair for one platform from
// installers/ffmpeg-manifest.json, verifies each archive's sha256 against
// the manifest BEFORE extracting anything, extracts, locates the ffmpeg/
// ffprobe executables inside, and writes them (plus their bundled license
// text, where the archive ships one) into a gitignored vendor directory —
// never committed, never `pnpm add`-ed, no runtime dependency on this
// script or on the network (see installers/ffmpeg-manifest.json's
// `provenance` block for the GPL/AGPL aggregation rationale).
//
// Usage:
//   node scripts/fetch-ffmpeg.mjs [--platform <name>] [--manifest <path>]
//                                  [--vendor-dir <path>] [--force]
//
//   --platform  linux-x64 | linux-arm64 | windows-x64 | macos-x64 |
//               macos-arm64 | all | host (default: host — auto-detected
//               from process.platform/arch)
//   --manifest  path to the pin manifest (default: installers/ffmpeg-manifest.json)
//   --vendor-dir  output root (default: <repo>/vendor/ffmpeg)
//   --force     re-download + re-extract even if already present
//
// Skip-if-present: if vendor-dir/<platform>/PROVENANCE.json already records
// the exact sha256s the manifest currently pins for both ffmpeg and
// ffprobe, this script does nothing (prints a one-line skip notice) unless
// --force is passed.
//
// Design note (why this file is one script, not a script + lib pair): the
// pure, network-free logic (checksum verification, manifest schema
// validation, host->platform resolution, CLI arg parsing) is exported from
// the top of this file specifically so scripts/fetch-ffmpeg.test.mjs can
// unit-test it via `node --test` with zero network access and zero new
// dependencies — see that file's header for how the checksum-tamper case
// is proven. Only the bottom of this file (past the `isDirectEntrypoint`
// guard, mirroring apps/server/src/main.ts's own convention) performs I/O.

import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import * as https from "node:https";
import * as http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const DEFAULT_MANIFEST_PATH = join(REPO_ROOT, "installers", "ffmpeg-manifest.json");
export const DEFAULT_VENDOR_DIR = join(REPO_ROOT, "vendor", "ffmpeg");

// ─────────────────────────────────────────────────────────────────────────
// Pure functions — no filesystem, no network, no process.env reads beyond
// what's passed in as arguments. Unit-tested in fetch-ffmpeg.test.mjs.
// ─────────────────────────────────────────────────────────────────────────

export const KNOWN_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "windows-x64",
  "macos-x64",
  "macos-arm64",
];

export const KNOWN_ARCHIVE_FORMATS = ["tar.xz", "zip"];

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** sha256 hex digest of a Buffer. The one primitive everything else here builds on. */
export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Verifies a downloaded buffer's sha256 against the manifest-pinned value.
 * Pure: takes bytes in, returns a result, never touches disk/network. This
 * is the exact function the tamper test in fetch-ffmpeg.test.mjs exercises
 * without ever downloading anything.
 */
export function verifyChecksum(buffer, expectedSha256Hex) {
  if (typeof expectedSha256Hex !== "string" || !SHA256_HEX_PATTERN.test(expectedSha256Hex.toLowerCase())) {
    throw new TypeError(`verifyChecksum: expectedSha256Hex must be 64 lowercase hex chars, got ${JSON.stringify(expectedSha256Hex)}`);
  }
  const expected = expectedSha256Hex.toLowerCase();
  const actual = sha256Hex(buffer);
  return { ok: actual === expected, actual, expected };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function validateComponentSchema(component, path, errors) {
  if (typeof component !== "object" || component === null) {
    errors.push(`${path}: expected an object`);
    return;
  }
  if (!isNonEmptyString(component.url)) errors.push(`${path}.url: expected a non-empty string`);
  if (!KNOWN_ARCHIVE_FORMATS.includes(component.format)) {
    errors.push(`${path}.format: expected one of ${KNOWN_ARCHIVE_FORMATS.join(", ")}, got ${JSON.stringify(component.format)}`);
  }
  if (typeof component.sha256 !== "string" || !SHA256_HEX_PATTERN.test(component.sha256)) {
    errors.push(`${path}.sha256: expected 64 lowercase hex chars, got ${JSON.stringify(component.sha256)}`);
  }
  if (!Number.isInteger(component.sizeBytes) || component.sizeBytes <= 0) {
    errors.push(`${path}.sizeBytes: expected a positive integer, got ${JSON.stringify(component.sizeBytes)}`);
  }
  if (!isNonEmptyString(component.binaryEntryName)) {
    errors.push(`${path}.binaryEntryName: expected a non-empty string`);
  }
}

/**
 * Structural validation of installers/ffmpeg-manifest.json — deliberately
 * hand-written (no ajv/schema-lib dependency: the lockfile is frozen for
 * this lane, and this manifest's shape is small/stable enough that plain
 * checks stay readable). Returns { ok, errors }; never throws.
 */
export function validateManifestSchema(manifest) {
  const errors = [];
  if (typeof manifest !== "object" || manifest === null) {
    return { ok: false, errors: ["manifest: expected an object"] };
  }
  if (manifest.manifestSchemaVersion !== 1) {
    errors.push(`manifestSchemaVersion: expected 1, got ${JSON.stringify(manifest.manifestSchemaVersion)}`);
  }
  if (!Number.isInteger(manifest.pinnedAtMs) || manifest.pinnedAtMs < 0) {
    errors.push(`pinnedAtMs: expected a non-negative integer, got ${JSON.stringify(manifest.pinnedAtMs)}`);
  }
  if (typeof manifest.provenance !== "object" || manifest.provenance === null) {
    errors.push("provenance: expected an object");
  } else if (!isNonEmptyString(manifest.provenance.note)) {
    errors.push("provenance.note: expected a non-empty string");
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
    if (!isNonEmptyString(entry.source)) errors.push(`${path}.source: expected a non-empty string`);
    if (!isNonEmptyString(entry.license)) errors.push(`${path}.license: expected a non-empty string`);
    if (typeof entry.components !== "object" || entry.components === null) {
      errors.push(`${path}.components: expected an object`);
      continue;
    }
    for (const bin of ["ffmpeg", "ffprobe"]) {
      if (!entry.components[bin]) {
        errors.push(`${path}.components.${bin}: missing`);
        continue;
      }
      validateComponentSchema(entry.components[bin], `${path}.components.${bin}`, errors);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Resolves the effective platform key. "host" (or omitted) auto-detects
 *  from process.platform/arch (injectable for tests). Throws on an
 *  unsupported host combo rather than guessing. */
export function resolveHostPlatform(platformArg, { platform = process.platform, arch = process.arch } = {}) {
  const requested = platformArg ?? "host";
  if (requested !== "host") return requested;
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  if (platform === "darwin") return arch === "arm64" ? "macos-arm64" : "macos-x64";
  if (platform === "win32") return "windows-x64";
  throw new Error(`fetch-ffmpeg: cannot auto-detect a pinned platform for ${platform}/${arch} — pass --platform explicitly`);
}

/** Pure CLI arg parser — no process.exit, no I/O. */
export function parseArgs(argv) {
  const out = { platform: "host", manifestPath: DEFAULT_MANIFEST_PATH, vendorDir: DEFAULT_VENDOR_DIR, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform") out.platform = argv[++i];
    else if (arg === "--manifest") out.manifestPath = argv[++i];
    else if (arg === "--vendor-dir") out.vendorDir = argv[++i];
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`fetch-ffmpeg: unrecognized argument ${JSON.stringify(arg)}`);
  }
  return out;
}

/** Given a platform's manifest entry, returns the deduplicated list of
 *  distinct archives that must be downloaded (BtbN-style platforms ship
 *  ffmpeg+ffprobe in ONE archive — same url+sha256 for both components —
 *  so this collapses to one entry; evermeet/osxexperts-style platforms
 *  ship two separate archives, so this stays two). Pure — operates on the
 *  already-parsed manifest entry only. */
export function planDownloads(platformEntry) {
  const seen = new Map();
  for (const [binName, component] of Object.entries(platformEntry.components)) {
    const key = `${component.url}::${component.sha256}`;
    if (!seen.has(key)) {
      seen.set(key, { url: component.url, format: component.format, sha256: component.sha256, sizeBytes: component.sizeBytes, wantedBy: [] });
    }
    seen.get(key).wantedBy.push({ binName, binaryEntryName: component.binaryEntryName });
  }
  return [...seen.values()];
}

// ─────────────────────────────────────────────────────────────────────────
// I/O — everything below touches the filesystem, network, or a child
// process. None of it is imported by the test file.
// ─────────────────────────────────────────────────────────────────────────

export function loadManifest(manifestPath) {
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const { ok, errors } = validateManifestSchema(manifest);
  if (!ok) {
    throw new Error(`fetch-ffmpeg: ${manifestPath} failed schema validation:\n  ${errors.join("\n  ")}`);
  }
  return manifest;
}

function downloadToBuffer(url, { maxRedirects = 5 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { headers: { "user-agent": "loombre-fetch-ffmpeg" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) {
          rejectPromise(new Error(`fetch-ffmpeg: too many redirects fetching ${url}`));
          return;
        }
        downloadToBuffer(res.headers.location, { maxRedirects: maxRedirects - 1 }).then(resolvePromise, rejectPromise);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        rejectPromise(new Error(`fetch-ffmpeg: GET ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolvePromise(Buffer.concat(chunks)));
      res.on("error", rejectPromise);
    });
    req.on("error", rejectPromise);
  });
}

const WIN = process.platform === "win32";

function commandExists(cmd) {
  const result = spawnSync(cmd, ["--help"], { stdio: "ignore", shell: WIN });
  return !result.error;
}

/** Extracts an archive (already checksum-verified) into destDir using the
 *  host's native archive tool — no npm zip/tar dependency added (the
 *  lockfile is frozen for this lane). tar.xz needs `tar` with liblzma
 *  support (standard on Linux/macOS; Windows 10 1803+ ships a compatible
 *  bsdtar). zip needs `unzip` on POSIX or PowerShell's Expand-Archive on
 *  Windows. */
function extractArchive(archivePath, destDir, format) {
  mkdirSync(destDir, { recursive: true });
  let result;
  if (format === "tar.xz") {
    if (!commandExists("tar")) throw new Error("fetch-ffmpeg: `tar` not found on PATH — required to extract .tar.xz archives");
    result = spawnSync("tar", ["-xJf", archivePath, "-C", destDir], { stdio: "inherit" });
  } else if (format === "zip") {
    if (WIN) {
      result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`],
        { stdio: "inherit" },
      );
    } else {
      if (!commandExists("unzip")) throw new Error("fetch-ffmpeg: `unzip` not found on PATH — required to extract .zip archives");
      result = spawnSync("unzip", ["-o", "-q", archivePath, "-d", destDir], { stdio: "inherit" });
    }
  } else {
    throw new Error(`fetch-ffmpeg: unknown archive format ${JSON.stringify(format)}`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`fetch-ffmpeg: extraction failed (exit ${result.status}) for ${archivePath}`);
}

/** Recursively finds the first file under root whose basename exactly
 *  matches `name`, at or below maxDepth. We deliberately do NOT hardcode
 *  each archive's internal folder-naming convention (BtbN embeds a git
 *  short-hash in the folder name that changes on every re-pin) — this
 *  makes the manifest resilient to that churn. AppleDouble resource-fork
 *  entries some zip tools produce (`__MACOSX/._ffmpeg`) have a DIFFERENT
 *  basename (`._ffmpeg`, not `ffmpeg`) so they never match. */
function findFileByName(root, name, maxDepth = 6) {
  const stack = [{ dir: root, depth: 0 }];
  const matches = [];
  while (stack.length > 0) {
    const { dir, depth } = stack.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && entry.name === name) {
        matches.push({ path: full, depth });
      }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.depth - b.depth);
  return matches[0].path;
}

function findLicenseFile(root, maxDepth = 3) {
  const candidates = ["LICENSE.txt", "LICENSE", "COPYING", "COPYING.txt"];
  for (const name of candidates) {
    const found = findFileByName(root, name, maxDepth);
    if (found) return found;
  }
  return null;
}

function provenancePath(vendorPlatformDir) {
  return join(vendorPlatformDir, "PROVENANCE.json");
}

/** Returns true iff vendor-dir/<platform>/PROVENANCE.json exists and its
 *  recorded sha256s match what the manifest pins RIGHT NOW for both
 *  ffmpeg and ffprobe (skip-if-present check). */
function isAlreadyFetched(vendorPlatformDir, platformEntry) {
  const provPath = provenancePath(vendorPlatformDir);
  if (!existsSync(provPath)) return false;
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(provPath, "utf8"));
  } catch {
    return false;
  }
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const expectedSha = platformEntry.components[bin].sha256;
    if (recorded.components?.[bin]?.sha256 !== expectedSha) return false;
    const binPath = join(vendorPlatformDir, recorded.components[bin].vendoredAs);
    if (!existsSync(binPath)) return false;
  }
  return true;
}

async function fetchPlatform(platform, manifest, vendorDir, force) {
  const platformEntry = manifest.platforms[platform];
  if (!platformEntry) {
    throw new Error(`fetch-ffmpeg: no manifest entry for platform ${JSON.stringify(platform)} (known: ${Object.keys(manifest.platforms).join(", ")})`);
  }
  const vendorPlatformDir = join(vendorDir, platform);

  if (!force && isAlreadyFetched(vendorPlatformDir, platformEntry)) {
    console.log(`fetch-ffmpeg[${platform}]: already present with matching sha256 — skipping (--force to re-fetch)`);
    return;
  }

  mkdirSync(vendorPlatformDir, { recursive: true });
  const downloads = planDownloads(platformEntry);
  const provenanceComponents = {};
  let licenseCopied = false;

  for (const download of downloads) {
    console.log(`fetch-ffmpeg[${platform}]: downloading ${download.url} (${download.sizeBytes} bytes expected)`);
    const buffer = await downloadToBuffer(download.url);
    const check = verifyChecksum(buffer, download.sha256);
    if (!check.ok) {
      throw new Error(
        `fetch-ffmpeg[${platform}]: CHECKSUM MISMATCH for ${download.url}\n` +
          `  expected sha256: ${check.expected}\n` +
          `  actual   sha256: ${check.actual}\n` +
          `  Refusing to extract or install a tampered/corrupted archive.`,
      );
    }
    console.log(`fetch-ffmpeg[${platform}]: sha256 verified (${check.actual})`);

    const tmpDir = mkdtempSync(join(tmpdir(), "loombre-fetch-ffmpeg-"));
    try {
      const archiveName = basename(new URL(download.url).pathname);
      const archivePath = join(tmpDir, archiveName);
      writeFileSync(archivePath, buffer);
      const extractDir = join(tmpDir, "extracted");
      extractArchive(archivePath, extractDir, download.format);

      if (!licenseCopied) {
        const licenseSourcePath = findLicenseFile(extractDir);
        if (licenseSourcePath) {
          // Copied NOW, while extractDir (inside tmpDir) still exists —
          // this iteration's `finally` below deletes tmpDir before the
          // downloads loop as a whole finishes, so deferring this copy
          // to after the loop (as an earlier version of this function
          // did) reads a path that no longer exists.
          copyFileSync(licenseSourcePath, join(vendorPlatformDir, "LICENSE.txt"));
          licenseCopied = true;
        }
      }

      for (const { binName, binaryEntryName } of download.wantedBy) {
        const foundPath = findFileByName(extractDir, binaryEntryName);
        if (!foundPath) {
          throw new Error(`fetch-ffmpeg[${platform}]: could not find ${JSON.stringify(binaryEntryName)} anywhere under the extracted archive`);
        }
        const destName = binaryEntryName;
        const destPath = join(vendorPlatformDir, destName);
        copyFileSync(foundPath, destPath);
        if (!WIN) chmodSync(destPath, 0o755);
        provenanceComponents[binName] = {
          sha256: download.sha256,
          sourceUrl: download.url,
          vendoredAs: destName,
        };
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const provenance = {
    platform,
    source: platformEntry.source,
    license: platformEntry.license,
    ffmpegVersion: platformEntry.ffmpegVersion,
    fetchedAtMs: Date.now(),
    manifestPinnedAtMs: manifest.pinnedAtMs,
    components: provenanceComponents,
  };
  writeFileSync(provenancePath(vendorPlatformDir), JSON.stringify(provenance, null, 2) + "\n");
  console.log(`fetch-ffmpeg[${platform}]: done — vendored to ${vendorPlatformDir}`);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/fetch-ffmpeg.mjs [--platform <name>|all|host] [--manifest <path>] [--vendor-dir <path>] [--force]\n" +
        `Known platforms: ${KNOWN_PLATFORMS.join(", ")}`,
    );
    return;
  }
  const manifest = loadManifest(args.manifestPath);
  const platforms = args.platform === "all" ? KNOWN_PLATFORMS : [resolveHostPlatform(args.platform)];
  for (const platform of platforms) {
    await fetchPlatform(platform, manifest, args.vendorDir, args.force);
  }
}

const isDirectEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntrypoint) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
