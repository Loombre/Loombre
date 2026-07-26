#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/fetch-embedded-pg.mjs
//
// SHARED deliverable (Phase 4 lane B mission; installer lanes I1/I3/I4 call
// this too): downloads the pinned PostgreSQL server+client binary bundle for
// one platform+version from installers/embedded-pg-manifest.json, verifies
// its sha256 BEFORE extracting anything, extracts the whole tree (bin/ lib/
// share/ include/ — embedded PostgreSQL needs its shared libs and timezone/
// text-search share data alongside the executables, unlike fetch-ffmpeg.mjs
// which only needs two standalone binaries), and writes it into a gitignored
// vendor directory — never committed, never `pnpm add`-ed, no runtime
// dependency on this script or on the network once vendored (see
// installers/embedded-pg-manifest.json's `sourcing` block for the
// theseus-rs-vs-zonky-vs-EDB evaluation and the PostgreSQL-License
// provenance).
//
// Usage:
//   node scripts/fetch-embedded-pg.mjs [--platform <name>|all|host]
//                                       [--pg-version <version>]
//                                       [--manifest <path>] [--vendor-dir <path>]
//                                       [--force]
//
//   --platform    linux-x64 | linux-arm64 | windows-x64 | macos-x64 |
//                 macos-arm64 | all | host (default: host — auto-detected
//                 from process.platform/arch)
//   --pg-version  a version key present in the manifest's `versions` map
//                 (default: manifest.defaultVersion, e.g. "18.4.0" — the
//                 D1-pinned minor. The manifest also carries a 16.x entry,
//                 but ONLY for the upgrade-path integration test; never pass
//                 it for a real provision — PROVISIONING_REQUEST_MIN_PG_MAJOR
//                 in @loombre/provisioning rejects anything below major 17
//                 at the ProvisioningRequest schema level regardless.)
//   --manifest    path to the pin manifest (default: installers/embedded-pg-manifest.json)
//   --vendor-dir  output root (default: <repo>/vendor/embedded-pg)
//   --force       re-download + re-extract even if already present
//
// Skip-if-present: if
// vendor-dir/<platform>/<version>/PROVENANCE.json already records the exact
// sha256 the manifest currently pins for that platform+version, and the
// expected `postgres`/`postgres.exe` binary exists on disk, this script does
// nothing (prints a one-line skip notice) unless --force is passed.
//
// Layout contract (depended on by packages/provisioning-pg/src/vendor-
// layout.ts — kept in sync by hand, cross-referenced in both files' headers
// since production src/ code must not import a top-level script):
//   <vendorDir>/<platform>/<version>/{bin,lib,share,include,LICENSE,COPYRIGHT,PROVENANCE.json}
// regardless of the source archive's own internal top-level directory name
// (which this script strips on extraction).
//
// Design note (mirrors scripts/fetch-ffmpeg.mjs's own split): pure,
// network-free logic (checksum verification, manifest schema validation,
// host->platform resolution, CLI arg parsing, vendor-path layout) lives at
// the top of this file specifically so it can be unit-tested with zero
// network access — see packages/provisioning-pg/test/fetch-script-pure.spec.ts.
// Only the bottom of this file (past the `isDirectEntrypoint` guard,
// mirroring apps/server/src/main.ts's own convention) performs I/O.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  chmodSync,
  readdirSync,
  cpSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import * as https from "node:https";
import * as http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const DEFAULT_MANIFEST_PATH = join(REPO_ROOT, "installers", "embedded-pg-manifest.json");
export const DEFAULT_VENDOR_DIR = join(REPO_ROOT, "vendor", "embedded-pg");

// ─────────────────────────────────────────────────────────────────────────
// Pure functions — no filesystem, no network, no process.env reads beyond
// what's passed in as arguments.
// ─────────────────────────────────────────────────────────────────────────

export const KNOWN_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "windows-x64",
  "macos-x64",
  "macos-arm64",
];

export const KNOWN_ARCHIVE_FORMATS = ["tar.gz", "zip"];

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** sha256 hex digest of a Buffer. */
export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Verifies a downloaded buffer's sha256 against the manifest-pinned value.
 *  Pure: bytes in, result out, never touches disk/network. */
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

function validatePlatformEntrySchema(entry, path, errors) {
  if (typeof entry !== "object" || entry === null) {
    errors.push(`${path}: expected an object`);
    return;
  }
  if (!isNonEmptyString(entry.target)) errors.push(`${path}.target: expected a non-empty string`);
  if (!isNonEmptyString(entry.url)) errors.push(`${path}.url: expected a non-empty string`);
  if (!KNOWN_ARCHIVE_FORMATS.includes(entry.archiveFormat)) {
    errors.push(`${path}.archiveFormat: expected one of ${KNOWN_ARCHIVE_FORMATS.join(", ")}, got ${JSON.stringify(entry.archiveFormat)}`);
  }
  if (!isNonEmptyString(entry.archiveTopDir)) errors.push(`${path}.archiveTopDir: expected a non-empty string`);
  if (typeof entry.sha256 !== "string" || !SHA256_HEX_PATTERN.test(entry.sha256)) {
    errors.push(`${path}.sha256: expected 64 lowercase hex chars, got ${JSON.stringify(entry.sha256)}`);
  }
  if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
    errors.push(`${path}.sizeBytes: expected a positive integer, got ${JSON.stringify(entry.sizeBytes)}`);
  }
}

/** Structural validation of installers/embedded-pg-manifest.json — hand-
 *  written (no ajv/schema-lib dependency: the lockfile is frozen for this
 *  lane). Returns { ok, errors }; never throws. */
export function validateManifestSchema(manifest) {
  const errors = [];
  if (typeof manifest !== "object" || manifest === null) {
    return { ok: false, errors: ["manifest: expected an object"] };
  }
  if (manifest.manifestSchemaVersion !== 1) {
    errors.push(`manifestSchemaVersion: expected 1, got ${JSON.stringify(manifest.manifestSchemaVersion)}`);
  }
  if (!isNonEmptyString(manifest.defaultVersion)) {
    errors.push("defaultVersion: expected a non-empty string");
  }
  if (typeof manifest.versions !== "object" || manifest.versions === null) {
    errors.push("versions: expected an object");
    return { ok: errors.length === 0, errors };
  }
  for (const version of Object.keys(manifest.versions)) {
    const versionEntry = manifest.versions[version];
    const vpath = `versions.${version}`;
    if (typeof versionEntry.platforms !== "object" || versionEntry.platforms === null) {
      errors.push(`${vpath}.platforms: expected an object`);
      continue;
    }
    for (const platform of Object.keys(versionEntry.platforms)) {
      if (!KNOWN_PLATFORMS.includes(platform)) {
        errors.push(`${vpath}.platforms.${platform}: not a known platform (${KNOWN_PLATFORMS.join(", ")})`);
        continue;
      }
      validatePlatformEntrySchema(versionEntry.platforms[platform], `${vpath}.platforms.${platform}`, errors);
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
  throw new Error(`fetch-embedded-pg: cannot auto-detect a pinned platform for ${platform}/${arch} — pass --platform explicitly`);
}

/** Pure CLI arg parser — no process.exit, no I/O. */
export function parseArgs(argv) {
  const out = {
    platform: "host",
    pgVersion: undefined,
    manifestPath: DEFAULT_MANIFEST_PATH,
    vendorDir: DEFAULT_VENDOR_DIR,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform") out.platform = argv[++i];
    else if (arg === "--pg-version") out.pgVersion = argv[++i];
    else if (arg === "--manifest") out.manifestPath = argv[++i];
    else if (arg === "--vendor-dir") out.vendorDir = argv[++i];
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`fetch-embedded-pg: unrecognized argument ${JSON.stringify(arg)}`);
  }
  return out;
}

/** Resolves the platform entry for a given version, defaulting the version
 *  to manifest.defaultVersion. Pure. Throws a clear error for an unknown
 *  version/platform rather than returning undefined. */
export function resolvePlatformEntry(manifest, pgVersion, platform) {
  const version = pgVersion ?? manifest.defaultVersion;
  const versionEntry = manifest.versions[version];
  if (!versionEntry) {
    throw new Error(
      `fetch-embedded-pg: no manifest entry for pg-version ${JSON.stringify(version)} (known: ${Object.keys(manifest.versions).join(", ")})`,
    );
  }
  const platformEntry = versionEntry.platforms[platform];
  if (!platformEntry) {
    throw new Error(
      `fetch-embedded-pg: no manifest entry for platform ${JSON.stringify(platform)} under version ${version} (known: ${Object.keys(versionEntry.platforms).join(", ")})`,
    );
  }
  return { version, platformEntry };
}

/** The on-disk layout contract — MUST stay in sync with
 *  packages/provisioning-pg/src/vendor-layout.ts's resolveVendorBinDir. */
export function vendorPlatformVersionDir(vendorDir, platform, version) {
  return join(vendorDir, platform, version);
}

export function postgresBinaryName(platform) {
  return platform === "windows-x64" ? "postgres.exe" : "postgres";
}

// ─────────────────────────────────────────────────────────────────────────
// I/O — filesystem, network, child process.
// ─────────────────────────────────────────────────────────────────────────

export function loadManifest(manifestPath) {
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const { ok, errors } = validateManifestSchema(manifest);
  if (!ok) {
    throw new Error(`fetch-embedded-pg: ${manifestPath} failed schema validation:\n  ${errors.join("\n  ")}`);
  }
  return manifest;
}

function downloadToBuffer(url, { maxRedirects = 5 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { headers: { "user-agent": "loombre-fetch-embedded-pg" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) {
          rejectPromise(new Error(`fetch-embedded-pg: too many redirects fetching ${url}`));
          return;
        }
        downloadToBuffer(res.headers.location, { maxRedirects: maxRedirects - 1 }).then(resolvePromise, rejectPromise);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        rejectPromise(new Error(`fetch-embedded-pg: GET ${url} -> HTTP ${res.statusCode}`));
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
 *  lockfile is frozen for this lane). tar.gz needs `tar` (standard on
 *  Linux/macOS; Windows 10 1803+ ships a compatible bsdtar). zip needs
 *  `unzip` on POSIX or PowerShell's Expand-Archive on Windows. */
function extractArchive(archivePath, destDir, format) {
  mkdirSync(destDir, { recursive: true });
  let result;
  if (format === "tar.gz") {
    if (!commandExists("tar")) throw new Error("fetch-embedded-pg: `tar` not found on PATH — required to extract .tar.gz archives");
    result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
  } else if (format === "zip") {
    if (WIN) {
      result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`],
        { stdio: "inherit" },
      );
    } else {
      if (!commandExists("unzip")) throw new Error("fetch-embedded-pg: `unzip` not found on PATH — required to extract .zip archives");
      result = spawnSync("unzip", ["-o", "-q", archivePath, "-d", destDir], { stdio: "inherit" });
    }
  } else {
    throw new Error(`fetch-embedded-pg: unknown archive format ${JSON.stringify(format)}`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`fetch-embedded-pg: extraction failed (exit ${result.status}) for ${archivePath}`);
}

/** Walks `root` and replaces every symlink found (at any depth) with a
 *  real copy of the file it resolves to, preserving the resolved target's
 *  mode bits. See the call site above for why this exists instead of
 *  trusting cpSync's `dereference` option. */
function dereferenceSymlinksInPlace(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const real = realpathSync(full);
        const mode = statSync(real).mode;
        const contents = readFileSync(real);
        // Overwrite the symlink itself with a real file at the same path.
        rmSync(full, { force: true });
        writeFileSync(full, contents, { mode });
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

function provenancePath(destDir) {
  return join(destDir, "PROVENANCE.json");
}

/** Returns true iff destDir/PROVENANCE.json exists, its recorded sha256
 *  matches what the manifest pins RIGHT NOW, and the postgres binary is
 *  actually present (skip-if-present check). */
function isAlreadyFetched(destDir, platform, expectedSha256) {
  const provPath = provenancePath(destDir);
  if (!existsSync(provPath)) return false;
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(provPath, "utf8"));
  } catch {
    return false;
  }
  if (recorded.sha256 !== expectedSha256) return false;
  return existsSync(join(destDir, "bin", postgresBinaryName(platform)));
}

async function fetchOne({ platform, pgVersion, manifest, vendorDir, force }) {
  const { version, platformEntry } = resolvePlatformEntry(manifest, pgVersion, platform);
  const destDir = vendorPlatformVersionDir(vendorDir, platform, version);

  if (!force && isAlreadyFetched(destDir, platform, platformEntry.sha256)) {
    console.log(`fetch-embedded-pg[${platform}@${version}]: already present with matching sha256 — skipping (--force to re-fetch)`);
    return destDir;
  }

  console.log(`fetch-embedded-pg[${platform}@${version}]: downloading ${platformEntry.url} (${platformEntry.sizeBytes} bytes expected)`);
  const buffer = await downloadToBuffer(platformEntry.url);
  const check = verifyChecksum(buffer, platformEntry.sha256);
  if (!check.ok) {
    throw new Error(
      `fetch-embedded-pg[${platform}@${version}]: CHECKSUM MISMATCH for ${platformEntry.url}\n` +
        `  expected sha256: ${check.expected}\n` +
        `  actual   sha256: ${check.actual}\n` +
        `  Refusing to extract or install a tampered/corrupted archive.`,
    );
  }
  console.log(`fetch-embedded-pg[${platform}@${version}]: sha256 verified (${check.actual})`);

  const tmpDir = mkdtempSync(join(tmpdir(), "loombre-fetch-embedded-pg-"));
  try {
    const archiveName = basename(new URL(platformEntry.url).pathname);
    const archivePath = join(tmpDir, archiveName);
    writeFileSync(archivePath, buffer);
    const extractDir = join(tmpDir, "extracted");
    extractArchive(archivePath, extractDir, platformEntry.archiveFormat);

    const topDir = join(extractDir, platformEntry.archiveTopDir);
    if (!existsSync(topDir)) {
      const actualEntries = readdirSync(extractDir);
      throw new Error(
        `fetch-embedded-pg[${platform}@${version}]: expected top-level directory ${JSON.stringify(platformEntry.archiveTopDir)} inside the archive, found: ${actualEntries.join(", ")}`,
      );
    }

    // ATOMIC install (race found by the addendum-A §1 clean-clone gate):
    // copying straight into destDir let a CONCURRENT process (parallel
    // vitest workers each calling fetchEmbeddedPg) observe bin/initdb
    // before lib/ existed — dyld "Library not loaded: libpq.5.dylib".
    // Stage the complete tree NEXT TO destDir (same filesystem, so
    // renameSync is atomic), post-process it there, then swap it in; a
    // tree only ever becomes visible complete.
    mkdirSync(dirname(destDir), { recursive: true });
    const stagingDir = mkdtempSync(join(dirname(destDir), `.staging-${version}-`));
    cpSync(topDir, stagingDir, { recursive: true, dereference: true });
    // REAL bug found and fixed while vendoring for this lane's own
    // integration tests: PostgreSQL's lib/ dir ships unversioned
    // convenience symlinks (e.g. `libecpg.dylib -> libecpg.6.dylib`).
    // cpSync's `dereference: true` above only dereferences a symlink
    // passed as the TOP-LEVEL `src` argument — empirically verified NOT
    // to dereference symlinks discovered while recursing into a directory
    // (Node v24.15.0) — so every fresh vendor install kept dangling
    // symlinks pointing at THIS FUNCTION's own about-to-be-deleted tmpDir
    // below. dereferenceSymlinksInPlace() is this script's own fix:
    // replace every remaining symlink under destDir with a real,
    // self-contained copy of whatever it resolves to.
    dereferenceSymlinksInPlace(stagingDir);

    if (!WIN) {
      const binDir = join(stagingDir, "bin");
      if (existsSync(binDir)) {
        for (const entry of readdirSync(binDir)) {
          try {
            chmodSync(join(binDir, entry), 0o755);
          } catch {
            // non-executable support files (rare) — ignore
          }
        }
      }
    }

    const provenance = {
      platform,
      version,
      target: platformEntry.target,
      sourceUrl: platformEntry.url,
      sha256: platformEntry.sha256,
      fetchedAtMs: Date.now(),
      manifestPinnedAtMs: manifest.pinnedAtMs,
    };
    writeFileSync(provenancePath(stagingDir), JSON.stringify(provenance, null, 2) + "\n");

    if (!force && isAlreadyFetched(destDir, platform, platformEntry.sha256)) {
      // Lost a concurrent race to an identical, sha256-verified install —
      // keep the winner's tree (never rm a complete tree a sibling process
      // may already be executing binaries from).
      rmSync(stagingDir, { recursive: true, force: true });
    } else {
      rmSync(destDir, { recursive: true, force: true });
      try {
        renameSync(stagingDir, destDir);
      } catch (err) {
        if (isAlreadyFetched(destDir, platform, platformEntry.sha256)) {
          rmSync(stagingDir, { recursive: true, force: true });
        } else {
          rmSync(stagingDir, { recursive: true, force: true });
          throw err;
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`fetch-embedded-pg[${platform}@${version}]: done — vendored to ${destDir}`);
  return destDir;
}

/**
 * Programmatic entry point (used by packages/provisioning-pg's integration
 * tests so they exercise this exact real download+verify+extract code path
 * without spawning a child process per test run). Returns the resolved
 * `<vendorDir>/<platform>/<version>` directory containing bin/lib/share.
 */
export async function fetchEmbeddedPg({
  platform: platformArg = "host",
  pgVersion,
  manifestPath = DEFAULT_MANIFEST_PATH,
  vendorDir = DEFAULT_VENDOR_DIR,
  force = false,
} = {}) {
  const manifest = loadManifest(manifestPath);
  const platform = resolveHostPlatform(platformArg);
  return fetchOne({ platform, pgVersion, manifest, vendorDir, force });
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/fetch-embedded-pg.mjs [--platform <name>|all|host] [--pg-version <version>] [--manifest <path>] [--vendor-dir <path>] [--force]\n" +
        `Known platforms: ${KNOWN_PLATFORMS.join(", ")}`,
    );
    return;
  }
  const manifest = loadManifest(args.manifestPath);
  const platforms = args.platform === "all" ? KNOWN_PLATFORMS : [resolveHostPlatform(args.platform)];
  for (const platform of platforms) {
    await fetchOne({ platform, pgVersion: args.pgVersion, manifest, vendorDir: args.vendorDir, force: args.force });
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
