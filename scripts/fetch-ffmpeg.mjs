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
// Vendor-mirror fallback (Task #16): upstreams garbage-collect old
// releases (BtbN deleted our pinned autobuild mid-rc.7-draft — d3a6883d).
// If a primary download fails (non-200 or network error) AND the manifest
// carries a top-level `mirror` block, this script retries against this
// repo's own private `ffmpeg-mirror` GitHub release, resolving the asset
// by its derived name (see deriveMirrorAssetName) via the GitHub API —
// which requires a token (GITHUB_TOKEN, else GH_TOKEN; see
// resolveGithubToken) because the repo is private. No token means no
// fallback: the failure surfaces both attempts and names both env vars.
// See downloadArchiveWithFallback's own header for the full control flow.
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

// Loosely "owner/repo" — no slashes inside either half, both non-empty.
// Not a full GitHub-name-charset validator (that's the API's job); this
// just catches the obvious "forgot to set it" / "pasted a URL" mistakes.
const OWNER_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** Validates the manifest's OPTIONAL top-level `mirror` block (Task #16 —
 *  the vendor-mirror fallback GitHub release: repo/releaseTag/assetNaming/
 *  note). Mutates `errors` in place, mirroring validateComponentSchema's
 *  own style. Absence of the block entirely is NOT an error — older
 *  manifests (or a manifest fixture in a test) without a mirror simply get
 *  no fallback, handled by downloadArchiveWithFallback below. */
function validateMirrorSchema(mirror, errors) {
  if (typeof mirror !== "object" || mirror === null) {
    errors.push("mirror: expected an object");
    return;
  }
  if (!isNonEmptyString(mirror.repo) || !OWNER_REPO_PATTERN.test(mirror.repo)) {
    errors.push(`mirror.repo: expected "<owner>/<repo>", got ${JSON.stringify(mirror.repo)}`);
  }
  if (!isNonEmptyString(mirror.releaseTag)) errors.push("mirror.releaseTag: expected a non-empty string");
  if (!isNonEmptyString(mirror.assetNaming)) errors.push("mirror.assetNaming: expected a non-empty string");
  if (!isNonEmptyString(mirror.note)) errors.push("mirror.note: expected a non-empty string");
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
  // OPTIONAL: only validated when present — see validateMirrorSchema's own
  // header for why a missing `mirror` block is not itself an error.
  if (manifest.mirror !== undefined) {
    validateMirrorSchema(manifest.mirror, errors);
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

/**
 * Derives a vendor-mirror asset name from a manifest component's pinned
 * sha256 + source url — `<first 12 hex of sha256>--<url basename>` (Task
 * #16's naming contract; see installers/ffmpeg-manifest.json's `mirror`
 * block and the ffmpeg-mirror release's own body text). Deliberately keyed
 * on the sha256 rather than the buildTag/version: a future re-pin of the
 * SAME url (BtbN reusing a filename across builds, or a version bump)
 * produces a DIFFERENT name because the sha256 changed, so append-only
 * mirror uploads never collide across repins — no lookup table, no
 * central registry, just this pure function run against whatever the
 * manifest pins today. installers/check-vendor-urls.mjs imports this
 * exact function rather than reimplementing it, so the two can never
 * silently disagree on what name to look for.
 */
export function deriveMirrorAssetName(sha256, url) {
  if (typeof sha256 !== "string" || !SHA256_HEX_PATTERN.test(sha256.toLowerCase())) {
    throw new TypeError(`deriveMirrorAssetName: sha256 must be 64 lowercase hex chars, got ${JSON.stringify(sha256)}`);
  }
  if (!isNonEmptyString(url)) {
    throw new TypeError(`deriveMirrorAssetName: url must be a non-empty string, got ${JSON.stringify(url)}`);
  }
  const shortSha = sha256.toLowerCase().slice(0, 12);
  const urlBasename = basename(new URL(url).pathname);
  return `${shortSha}--${urlBasename}`;
}

/** Resolves the GitHub token used for the vendor-mirror fallback and for
 *  installers/check-vendor-urls.mjs's mirror-asset check — GITHUB_TOKEN
 *  first (the name Actions injects automatically), GH_TOKEN second (the
 *  `gh` CLI's own convention, e.g. `GH_TOKEN=$(gh auth token)` for local/
 *  manual runs). `env` is injectable (defaults to the real process.env)
 *  so this stays testable without mutating global state. Returns
 *  `undefined` — never an empty string — when neither is set, so callers
 *  can use a plain `if (!token)` check. */
export function resolveGithubToken(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

/**
 * Orchestrates ONE archive download with vendor-mirror fallback: try the
 * primary URL first; on failure (non-200 or network error — whatever
 * `downloadPrimary` throws for), fall back to the manifest's `mirror`
 * release IF both a mirror block and a token are available. Every real
 * network call is INJECTED (downloadPrimary/resolveMirrorAsset/
 * downloadMirrorAsset) so fetch-ffmpeg.test.mjs can exercise every branch
 * of this control flow — primary success, primary fail + no mirror,
 * primary fail + no token, primary fail + mirror asset missing, primary
 * fail + mirror download fails, full fallback success — with zero network
 * access. fetchPlatform (below) is the only real caller, wiring the
 * injected functions to actual downloadToBuffer/fetchMirrorReleaseAssets/
 * downloadMirrorAssetBytes calls.
 *
 * Checksum verification is deliberately NOT done here: fetchPlatform
 * calls verifyChecksum(buffer, download.sha256) on whatever buffer this
 * function returns, from EITHER source, via the exact same code path —
 * the one pinned sha256 both derives the mirror asset's name (see
 * deriveMirrorAssetName) AND gates the bytes actually vendored, so a
 * mismatched or tampered mirror asset is rejected exactly like a
 * mismatched primary download would be.
 */
export async function downloadArchiveWithFallback({
  url,
  sha256,
  mirror,
  token,
  downloadPrimary,
  resolveMirrorAsset,
  downloadMirrorAsset,
  log = () => {},
}) {
  let primaryError;
  try {
    const buffer = await downloadPrimary(url);
    return { buffer, source: "primary" };
  } catch (err) {
    primaryError = err instanceof Error ? err : new Error(String(err));
  }

  const primaryReason = primaryError.statusCode ? `HTTP ${primaryError.statusCode}` : primaryError.message;

  if (!mirror) {
    throw new Error(
      `fetch-ffmpeg: primary download failed (${primaryReason}) and this manifest has no "mirror" ` +
        `block to fall back to — see installers/ffmpeg-manifest.json's top-level "mirror" field.`,
    );
  }
  if (!token) {
    throw new Error(
      `fetch-ffmpeg: both downloads failed.\n` +
        `  primary: ${primaryReason}\n` +
        `  mirror:  no GitHub token available — set GITHUB_TOKEN or GH_TOKEN to enable the ` +
        `${mirror.repo}#${mirror.releaseTag} fallback (the mirror repo is private).`,
    );
  }

  const assetName = deriveMirrorAssetName(sha256, url);
  log(`primary URL failed (${primaryReason}) — falling back to mirror asset ${assetName}`);

  const asset = await resolveMirrorAsset(mirror, assetName, token);
  if (!asset) {
    throw new Error(
      `fetch-ffmpeg: both downloads failed.\n` +
        `  primary: ${primaryReason}\n` +
        `  mirror:  asset ${JSON.stringify(assetName)} not found in ${mirror.repo}#${mirror.releaseTag}`,
    );
  }

  try {
    const buffer = await downloadMirrorAsset(asset, token);
    return { buffer, source: "mirror", assetName };
  } catch (mirrorErr) {
    const mirrorMessage = mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr);
    throw new Error(`fetch-ffmpeg: both downloads failed.\n  primary: ${primaryReason}\n  mirror:  ${mirrorMessage}`, {
      cause: mirrorErr,
    });
  }
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
        // statusCode attached to the Error (not just embedded in the
        // message) so downloadArchiveWithFallback's primary-failure log
        // line ("primary URL failed (HTTP 404) — falling back to...") can
        // report a clean "HTTP <code>" without string-parsing this
        // message — see its primaryReason computation.
        const err = new Error(`fetch-ffmpeg: GET ${url} -> HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        rejectPromise(err);
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

/** Fetches the vendor-mirror release's asset list (name/id/url per asset)
 *  from the GitHub API. The mirror repo is PRIVATE, so this always needs a
 *  token — a failed/unauthorized API call throws (that's a real problem,
 *  distinct from "the specific asset isn't there yet", which the caller
 *  checks separately). Exported so installers/check-vendor-urls.mjs's own
 *  mirror-asset liveness check reuses this exact call instead of
 *  reimplementing the GitHub API shape. Uses the platform's global fetch()
 *  (Node >=24, this repo's engines floor) rather than the https/http
 *  primitives downloadToBuffer uses — plain JSON GET, no archive-sized
 *  buffering or redirect-following concerns here. */
export async function fetchMirrorReleaseAssets(mirror, token) {
  const apiUrl = `https://api.github.com/repos/${mirror.repo}/releases/tags/${encodeURIComponent(mirror.releaseTag)}`;
  const res = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "loombre-fetch-ffmpeg",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch-ffmpeg: GitHub API GET ${apiUrl} -> HTTP ${res.status}`);
  }
  const body = await res.json();
  return (body.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, url: asset.url }));
}

/** Looks up ONE mirror asset by its derived name (see deriveMirrorAssetName)
 *  — the real (non-test-fake) implementation of downloadArchiveWithFallback's
 *  `resolveMirrorAsset` parameter. Returns null (not a throw) when the
 *  release itself is reachable but no asset with that name exists yet —
 *  that is a legitimate "not mirrored (yet)" outcome the caller reports,
 *  not an API failure. */
export async function resolveMirrorAssetByName(mirror, assetName, token) {
  const assets = await fetchMirrorReleaseAssets(mirror, token);
  return assets.find((asset) => asset.name === assetName) ?? null;
}

/**
 * Downloads one release asset's bytes via the GitHub API's asset endpoint
 * (`.../releases/assets/<id>`, `Accept: application/octet-stream`), which
 * 302s to the actual storage host (release-assets.githubusercontent.com at
 * the time this was written). Uses the platform fetch() specifically
 * because — unlike downloadToBuffer's hand-rolled https/http redirect
 * handling above, which this function does NOT reuse — fetch() correctly
 * drops the Authorization header when a redirect crosses origins, per the
 * WHATWG fetch spec (https://fetch.spec.whatwg.org/#http-redirect-fetch,
 * step 14: strip Authorization on a cross-origin redirect). That property
 * matters here and nowhere else in this file: this is the one request
 * carrying a bearer token toward a host whose redirect target must never
 * see it. Empirically verified for Task #16 — see the task report for the
 * network trace proving the token is absent on the follow-up request.
 */
export async function downloadMirrorAssetBytes(asset, token) {
  const res = await fetch(asset.url, {
    headers: {
      Accept: "application/octet-stream",
      Authorization: `Bearer ${token}`,
      "User-Agent": "loombre-fetch-ffmpeg",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch-ffmpeg: mirror asset download ${asset.url} -> HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
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
  const githubToken = resolveGithubToken();

  for (const download of downloads) {
    console.log(`fetch-ffmpeg[${platform}]: downloading ${download.url} (${download.sizeBytes} bytes expected)`);
    // Primary path stays byte-for-byte the same as before this fell back to
    // anything: downloadToBuffer(url) is still the first (and, on success,
    // ONLY) thing that runs. downloadArchiveWithFallback only reaches the
    // manifest.mirror branch when THAT throws — see its own header for the
    // full primary-vs-mirror control flow and why checksum verification
    // (right below, unchanged) covers both sources identically.
    const result = await downloadArchiveWithFallback({
      url: download.url,
      sha256: download.sha256,
      mirror: manifest.mirror,
      token: githubToken,
      downloadPrimary: (url) => downloadToBuffer(url),
      resolveMirrorAsset: (mirror, assetName, token) => resolveMirrorAssetByName(mirror, assetName, token),
      downloadMirrorAsset: (asset, token) => downloadMirrorAssetBytes(asset, token),
      log: (message) => console.log(`fetch-ffmpeg[${platform}]: ${message}`),
    });
    if (result.source === "mirror") {
      console.log(`fetch-ffmpeg[${platform}]: downloaded ${result.assetName} from the vendor mirror`);
    }
    const buffer = result.buffer;
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
