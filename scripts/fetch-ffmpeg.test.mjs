// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/fetch-ffmpeg.test.mjs
//
// Unit tests for scripts/fetch-ffmpeg.mjs's pure logic — no network, no
// filesystem writes outside a single readFileSync of the checked-in
// manifest for the schema-validity assertion. Run directly with Node's
// built-in test runner (no new devDependency, lockfile stays frozen for
// this lane):
//
//   node --test scripts/fetch-ffmpeg.test.mjs
//
// This intentionally is NOT wired into `pnpm gate` (that pipeline's `test`
// step is turbo-scoped to apps/*+packages/* workspace packages; this lane
// owns exactly scripts/fetch-ffmpeg.mjs, not turbo.json/root package.json)
// — see the I1 handoff report for how this was run and confirmed green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sha256Hex,
  verifyChecksum,
  validateManifestSchema,
  resolveHostPlatform,
  parseArgs,
  planDownloads,
  KNOWN_PLATFORMS,
  DEFAULT_MANIFEST_PATH,
  deriveMirrorAssetName,
  resolveGithubToken,
  downloadArchiveWithFallback,
} from "./fetch-ffmpeg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("sha256Hex matches a known vector", () => {
  // sha256("") — the universally known empty-string vector, cross-checked
  // against node:crypto directly (not hand-transcribed) so a typo here
  // can't quietly mask a real bug.
  const expected = createHash("sha256").update(Buffer.from("")).digest("hex");
  assert.equal(expected.length, 64);
  assert.equal(sha256Hex(Buffer.from("")), expected);
});

test("verifyChecksum: ok=true when bytes match the pinned sha256", () => {
  const buffer = Buffer.from("loombre-fixture-bytes");
  const expected = createHash("sha256").update(buffer).digest("hex");
  const result = verifyChecksum(buffer, expected);
  assert.equal(result.ok, true);
  assert.equal(result.actual, expected);
  assert.equal(result.expected, expected);
});

test("verifyChecksum: FAILS CLOSED on tamper (the core feedback-loop-first case)", () => {
  // Simulates a tampered/corrupted download: the manifest pins the sha256
  // of the REAL archive, but the bytes we actually got differ by one byte.
  const realBytes = Buffer.from("this is the real, checksum-pinned ffmpeg archive");
  const pinnedSha256 = createHash("sha256").update(realBytes).digest("hex");

  const tamperedBytes = Buffer.concat([realBytes.subarray(0, realBytes.length - 1), Buffer.from("!")]);
  assert.notDeepEqual(tamperedBytes, realBytes, "sanity: tampered buffer must actually differ");

  const result = verifyChecksum(tamperedBytes, pinnedSha256);
  assert.equal(result.ok, false);
  assert.equal(result.expected, pinnedSha256);
  assert.notEqual(result.actual, pinnedSha256);
});

test("verifyChecksum: rejects a malformed pinned sha256 rather than silently passing", () => {
  assert.throws(() => verifyChecksum(Buffer.from("x"), "not-a-sha256"), TypeError);
  assert.throws(() => verifyChecksum(Buffer.from("x"), "abcd"), TypeError);
  assert.throws(() => verifyChecksum(Buffer.from("x"), ""), TypeError);
});

test("verifyChecksum: case-insensitive on the expected hex", () => {
  const buffer = Buffer.from("case-check");
  const expectedLower = createHash("sha256").update(buffer).digest("hex");
  const result = verifyChecksum(buffer, expectedLower.toUpperCase());
  assert.equal(result.ok, true);
});

test("validateManifestSchema: accepts a minimal well-formed manifest", () => {
  const manifest = {
    manifestSchemaVersion: 1,
    pinnedAtMs: 1700000000000,
    provenance: { note: "test" },
    platforms: {
      "linux-x64": {
        source: "test-source",
        license: "GPL-3.0-or-later",
        components: {
          ffmpeg: {
            url: "https://example.invalid/ffmpeg.tar.xz",
            format: "tar.xz",
            sha256: "a".repeat(64),
            sizeBytes: 100,
            binaryEntryName: "ffmpeg",
          },
          ffprobe: {
            url: "https://example.invalid/ffmpeg.tar.xz",
            format: "tar.xz",
            sha256: "a".repeat(64),
            sizeBytes: 100,
            binaryEntryName: "ffprobe",
          },
        },
      },
    },
  };
  const result = validateManifestSchema(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("validateManifestSchema: rejects a bad sha256 (wrong length / uppercase / missing)", () => {
  const base = {
    manifestSchemaVersion: 1,
    pinnedAtMs: 1,
    provenance: { note: "x" },
    platforms: {
      "linux-x64": {
        source: "s",
        license: "l",
        components: {
          ffmpeg: { url: "u", format: "tar.xz", sha256: "TOO-SHORT", sizeBytes: 1, binaryEntryName: "ffmpeg" },
          ffprobe: { url: "u", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffprobe" },
        },
      },
    },
  };
  const result = validateManifestSchema(base);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("sha256")));
});

test("validateManifestSchema: rejects an unknown platform key", () => {
  const manifest = {
    manifestSchemaVersion: 1,
    pinnedAtMs: 1,
    provenance: { note: "x" },
    platforms: {
      "freebsd-x64": {
        source: "s",
        license: "l",
        components: {
          ffmpeg: { url: "u", format: "zip", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffmpeg" },
          ffprobe: { url: "u", format: "zip", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffprobe" },
        },
      },
    },
  };
  const result = validateManifestSchema(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("freebsd-x64")));
});

test("validateManifestSchema: rejects a bad archive format", () => {
  const manifest = {
    manifestSchemaVersion: 1,
    pinnedAtMs: 1,
    provenance: { note: "x" },
    platforms: {
      "macos-x64": {
        source: "s",
        license: "l",
        components: {
          ffmpeg: { url: "u", format: "rar", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffmpeg" },
          ffprobe: { url: "u", format: "zip", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffprobe" },
        },
      },
    },
  };
  const result = validateManifestSchema(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("format")));
});

test("validateManifestSchema: rejects manifestSchemaVersion != 1", () => {
  const manifest = { manifestSchemaVersion: 2, pinnedAtMs: 1, provenance: { note: "x" }, platforms: {} };
  const result = validateManifestSchema(manifest);
  assert.equal(result.ok, false);
});

test("THE CHECKED-IN MANIFEST (installers/ffmpeg-manifest.json) passes schema validation", () => {
  const manifestPath = join(__dirname, "..", "installers", "ffmpeg-manifest.json");
  assert.equal(manifestPath, DEFAULT_MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = validateManifestSchema(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  for (const platform of KNOWN_PLATFORMS) {
    assert.ok(manifest.platforms[platform], `expected a manifest entry for ${platform}`);
  }
});

test("THE CHECKED-IN MANIFEST (installers/ffmpeg-manifest.json) carries a valid mirror block (Task #16)", () => {
  const manifestPath = join(__dirname, "..", "installers", "ffmpeg-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.mirror, "expected a top-level mirror block");
  assert.equal(manifest.mirror.repo, "Loombre/Loombre");
  assert.equal(manifest.mirror.releaseTag, "ffmpeg-mirror");
  assert.ok(manifest.mirror.assetNaming.length > 0);
  assert.ok(manifest.mirror.note.length > 0);
});

test("validateManifestSchema: a manifest with no mirror block is still valid (mirror is optional)", () => {
  const manifest = {
    manifestSchemaVersion: 1,
    pinnedAtMs: 1,
    provenance: { note: "x" },
    platforms: {},
  };
  const result = validateManifestSchema(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("validateManifestSchema: accepts a well-formed mirror block", () => {
  const manifest = {
    manifestSchemaVersion: 1,
    pinnedAtMs: 1,
    provenance: { note: "x" },
    mirror: {
      repo: "Loombre/Loombre",
      releaseTag: "ffmpeg-mirror",
      assetNaming: "<sha256[0:12]>--<url basename>",
      note: "deletion-proofing, append-only",
    },
    platforms: {},
  };
  const result = validateManifestSchema(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("validateManifestSchema: rejects a malformed mirror block (bad repo shape, missing fields)", () => {
  const base = {
    manifestSchemaVersion: 1,
    pinnedAtMs: 1,
    provenance: { note: "x" },
    platforms: {},
  };

  const noSlash = validateManifestSchema({ ...base, mirror: { repo: "not-owner-slash-repo", releaseTag: "t", assetNaming: "a", note: "n" } });
  assert.equal(noSlash.ok, false);
  assert.ok(noSlash.errors.some((e) => e.includes("mirror.repo")));

  const missingFields = validateManifestSchema({ ...base, mirror: { repo: "Loombre/Loombre" } });
  assert.equal(missingFields.ok, false);
  assert.ok(missingFields.errors.some((e) => e.includes("mirror.releaseTag")));
  assert.ok(missingFields.errors.some((e) => e.includes("mirror.assetNaming")));
  assert.ok(missingFields.errors.some((e) => e.includes("mirror.note")));

  const notAnObject = validateManifestSchema({ ...base, mirror: "ffmpeg-mirror" });
  assert.equal(notAnObject.ok, false);
  assert.ok(notAnObject.errors.some((e) => e.includes("mirror: expected an object")));
});

test("THE CHECKED-IN MANIFEST: every platform's components.*.sha256 is unique per distinct archive, consistent within one archive", () => {
  const manifestPath = join(__dirname, "..", "installers", "ffmpeg-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const { ffmpeg, ffprobe } = entry.components;
    if (ffmpeg.url === ffprobe.url) {
      assert.equal(ffmpeg.sha256, ffprobe.sha256, `${platform}: same archive URL must carry the same sha256 for both components`);
    } else {
      assert.notEqual(ffmpeg.sha256, ffprobe.sha256, `${platform}: distinct archives should not coincidentally share a sha256 in this fixture`);
    }
  }
});

test("resolveHostPlatform: auto-detects from injected platform/arch", () => {
  assert.equal(resolveHostPlatform(undefined, { platform: "linux", arch: "x64" }), "linux-x64");
  assert.equal(resolveHostPlatform(undefined, { platform: "linux", arch: "arm64" }), "linux-arm64");
  assert.equal(resolveHostPlatform("host", { platform: "darwin", arch: "arm64" }), "macos-arm64");
  assert.equal(resolveHostPlatform("host", { platform: "darwin", arch: "x64" }), "macos-x64");
  assert.equal(resolveHostPlatform("host", { platform: "win32", arch: "x64" }), "windows-x64");
});

test("resolveHostPlatform: explicit --platform overrides auto-detection", () => {
  assert.equal(resolveHostPlatform("linux-arm64", { platform: "darwin", arch: "arm64" }), "linux-arm64");
});

test("resolveHostPlatform: throws on an unsupported host rather than guessing", () => {
  assert.throws(() => resolveHostPlatform(undefined, { platform: "sunos", arch: "x64" }), /cannot auto-detect/);
});

test("parseArgs: defaults", () => {
  const args = parseArgs([]);
  assert.equal(args.platform, "host");
  assert.equal(args.force, false);
  assert.equal(args.help, false);
});

test("parseArgs: parses --platform/--force/--manifest/--vendor-dir", () => {
  const args = parseArgs(["--platform", "linux-arm64", "--force", "--manifest", "/tmp/m.json", "--vendor-dir", "/tmp/v"]);
  assert.equal(args.platform, "linux-arm64");
  assert.equal(args.force, true);
  assert.equal(args.manifestPath, "/tmp/m.json");
  assert.equal(args.vendorDir, "/tmp/v");
});

test("parseArgs: rejects an unrecognized flag rather than silently ignoring it", () => {
  assert.throws(() => parseArgs(["--nonsense"]), /unrecognized argument/);
});

test("planDownloads: collapses a shared archive (same url+sha256) into one download", () => {
  const entry = {
    components: {
      ffmpeg: { url: "https://x/one.tar.xz", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 10, binaryEntryName: "ffmpeg" },
      ffprobe: { url: "https://x/one.tar.xz", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 10, binaryEntryName: "ffprobe" },
    },
  };
  const plan = planDownloads(entry);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].wantedBy.length, 2);
});

test("planDownloads: keeps two separate downloads for two distinct archives", () => {
  const entry = {
    components: {
      ffmpeg: { url: "https://x/ffmpeg.zip", format: "zip", sha256: "a".repeat(64), sizeBytes: 10, binaryEntryName: "ffmpeg" },
      ffprobe: { url: "https://x/ffprobe.zip", format: "zip", sha256: "b".repeat(64), sizeBytes: 10, binaryEntryName: "ffprobe" },
    },
  };
  const plan = planDownloads(entry);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].wantedBy.length, 1);
  assert.equal(plan[1].wantedBy.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// deriveMirrorAssetName — Task #16's naming contract:
// <first 12 hex of sha256>--<upstream url basename>.
// ─────────────────────────────────────────────────────────────────────────

test("deriveMirrorAssetName: matches the real ffmpeg-mirror release's naming (linux-x64 fixture)", () => {
  const name = deriveMirrorAssetName(
    "7b0c2ad593860d8bb157e346777ac7d741b5bf25b456382051138aaa8256f92d",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-10-13-17/ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1.tar.xz",
  );
  assert.equal(name, "7b0c2ad59386--ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1.tar.xz");
});

test("deriveMirrorAssetName: matches the real ffmpeg-mirror release's naming (macos-x64 ffprobe fixture, no build-tag path segment)", () => {
  const name = deriveMirrorAssetName(
    "399b93f0b9862f69767afa343e90c2f48d7e7958cadbb6deb76a012d0e3b7ce3",
    "https://evermeet.cx/ffmpeg/ffprobe-8.1.2.zip",
  );
  assert.equal(name, "399b93f0b986--ffprobe-8.1.2.zip");
});

test("deriveMirrorAssetName: lowercases an uppercase sha256 before truncating", () => {
  const name = deriveMirrorAssetName("A".repeat(64), "https://example.invalid/x.zip");
  assert.equal(name, "aaaaaaaaaaaa--x.zip");
});

test("deriveMirrorAssetName: a different sha256 for the SAME url produces a DIFFERENT name (repin collision-proofing)", () => {
  const nameA = deriveMirrorAssetName("a".repeat(64), "https://example.invalid/x.zip");
  const nameB = deriveMirrorAssetName("b".repeat(64), "https://example.invalid/x.zip");
  assert.notEqual(nameA, nameB);
});

test("deriveMirrorAssetName: throws on a malformed sha256", () => {
  assert.throws(() => deriveMirrorAssetName("not-a-sha256", "https://example.invalid/x.zip"), TypeError);
});

test("deriveMirrorAssetName: throws on an empty/missing url", () => {
  assert.throws(() => deriveMirrorAssetName("a".repeat(64), ""), TypeError);
  assert.throws(() => deriveMirrorAssetName("a".repeat(64), undefined), TypeError);
});

// ─────────────────────────────────────────────────────────────────────────
// resolveGithubToken — env-injected so no real env var is ever touched.
// ─────────────────────────────────────────────────────────────────────────

test("resolveGithubToken: prefers GITHUB_TOKEN over GH_TOKEN", () => {
  assert.equal(resolveGithubToken({ GITHUB_TOKEN: "gh-token-1", GH_TOKEN: "gh-token-2" }), "gh-token-1");
});

test("resolveGithubToken: falls back to GH_TOKEN when GITHUB_TOKEN is unset", () => {
  assert.equal(resolveGithubToken({ GH_TOKEN: "gh-token-2" }), "gh-token-2");
});

test("resolveGithubToken: returns undefined (not empty string) when neither is set", () => {
  assert.equal(resolveGithubToken({}), undefined);
  assert.equal(resolveGithubToken({ GITHUB_TOKEN: "", GH_TOKEN: "" }), undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// downloadArchiveWithFallback — the fallback control-flow orchestrator,
// exercised with fully injected fake downloaders/resolvers (zero network).
// ─────────────────────────────────────────────────────────────────────────

const FIXTURE_MIRROR = { repo: "Loombre/Loombre", releaseTag: "ffmpeg-mirror", assetNaming: "x", note: "x" };
const FIXTURE_SHA256 = "7b0c2ad593860d8bb157e346777ac7d741b5bf25b456382051138aaa8256f92d";
const FIXTURE_URL = "https://example.invalid/upstream/ffmpeg.tar.xz";
const FIXTURE_ASSET_NAME = deriveMirrorAssetName(FIXTURE_SHA256, FIXTURE_URL);

function neverCalled(label) {
  return async (...args) => {
    throw new Error(`${label} should not have been called, but was called with ${JSON.stringify(args)}`);
  };
}

test("downloadArchiveWithFallback: primary success returns immediately, never touches the mirror", async () => {
  const primaryBuffer = Buffer.from("primary-bytes");
  const result = await downloadArchiveWithFallback({
    url: FIXTURE_URL,
    sha256: FIXTURE_SHA256,
    mirror: FIXTURE_MIRROR,
    token: "some-token",
    downloadPrimary: async (url) => {
      assert.equal(url, FIXTURE_URL);
      return primaryBuffer;
    },
    resolveMirrorAsset: neverCalled("resolveMirrorAsset"),
    downloadMirrorAsset: neverCalled("downloadMirrorAsset"),
  });
  assert.equal(result.buffer, primaryBuffer);
  assert.equal(result.source, "primary");
});

test("downloadArchiveWithFallback: primary failure + no mirror block -> throws naming the primary failure, never calls a mirror fn", async () => {
  await assert.rejects(
    downloadArchiveWithFallback({
      url: FIXTURE_URL,
      sha256: FIXTURE_SHA256,
      mirror: undefined,
      token: "some-token",
      downloadPrimary: async () => {
        throw new Error("network unreachable");
      },
      resolveMirrorAsset: neverCalled("resolveMirrorAsset"),
      downloadMirrorAsset: neverCalled("downloadMirrorAsset"),
    }),
    /primary download failed \(network unreachable\).*no "mirror" block/s,
  );
});

test("downloadArchiveWithFallback: primary failure + mirror present + NO token -> throws naming BOTH attempts and both env vars", async () => {
  await assert.rejects(
    downloadArchiveWithFallback({
      url: FIXTURE_URL,
      sha256: FIXTURE_SHA256,
      mirror: FIXTURE_MIRROR,
      token: undefined,
      downloadPrimary: async () => {
        const err = new Error(`fetch-ffmpeg: GET ${FIXTURE_URL} -> HTTP 404`);
        err.statusCode = 404;
        throw err;
      },
      resolveMirrorAsset: neverCalled("resolveMirrorAsset"),
      downloadMirrorAsset: neverCalled("downloadMirrorAsset"),
    }),
    (err) => {
      assert.match(err.message, /primary: HTTP 404/);
      assert.match(err.message, /GITHUB_TOKEN/);
      assert.match(err.message, /GH_TOKEN/);
      return true;
    },
  );
});

test("downloadArchiveWithFallback: primary failure + token, but mirror has no matching asset -> throws naming both attempts", async () => {
  await assert.rejects(
    downloadArchiveWithFallback({
      url: FIXTURE_URL,
      sha256: FIXTURE_SHA256,
      mirror: FIXTURE_MIRROR,
      token: "some-token",
      downloadPrimary: async () => {
        throw new Error("network unreachable");
      },
      resolveMirrorAsset: async (mirror, assetName) => {
        assert.equal(mirror, FIXTURE_MIRROR);
        assert.equal(assetName, FIXTURE_ASSET_NAME);
        return null;
      },
      downloadMirrorAsset: neverCalled("downloadMirrorAsset"),
    }),
    (err) => {
      assert.match(err.message, /primary: network unreachable/);
      assert.match(err.message, new RegExp(`not found in ${FIXTURE_MIRROR.repo}#${FIXTURE_MIRROR.releaseTag}`));
      return true;
    },
  );
});

test("downloadArchiveWithFallback: primary failure + token, mirror asset resolves and downloads -> returns the mirror buffer, logs the fallback", async () => {
  const mirrorBuffer = Buffer.from("mirror-bytes");
  const fakeAsset = { id: 1, name: FIXTURE_ASSET_NAME, url: "https://api.github.com/repos/Loombre/Loombre/releases/assets/1" };
  const logLines = [];
  const result = await downloadArchiveWithFallback({
    url: FIXTURE_URL,
    sha256: FIXTURE_SHA256,
    mirror: FIXTURE_MIRROR,
    token: "some-token",
    downloadPrimary: async () => {
      const err = new Error(`fetch-ffmpeg: GET ${FIXTURE_URL} -> HTTP 404`);
      err.statusCode = 404;
      throw err;
    },
    resolveMirrorAsset: async () => fakeAsset,
    downloadMirrorAsset: async (asset, token) => {
      assert.equal(asset, fakeAsset);
      assert.equal(token, "some-token");
      return mirrorBuffer;
    },
    log: (message) => logLines.push(message),
  });
  assert.equal(result.buffer, mirrorBuffer);
  assert.equal(result.source, "mirror");
  assert.equal(result.assetName, FIXTURE_ASSET_NAME);
  assert.equal(logLines.length, 1);
  assert.match(logLines[0], /^primary URL failed \(HTTP 404\) — falling back to mirror asset /);
  assert.match(logLines[0], new RegExp(FIXTURE_ASSET_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("downloadArchiveWithFallback: mirror asset found but its OWN download fails -> throws naming both attempts", async () => {
  const fakeAsset = { id: 1, name: FIXTURE_ASSET_NAME, url: "https://api.github.com/repos/Loombre/Loombre/releases/assets/1" };
  await assert.rejects(
    downloadArchiveWithFallback({
      url: FIXTURE_URL,
      sha256: FIXTURE_SHA256,
      mirror: FIXTURE_MIRROR,
      token: "some-token",
      downloadPrimary: async () => {
        throw new Error("network unreachable");
      },
      resolveMirrorAsset: async () => fakeAsset,
      downloadMirrorAsset: async () => {
        throw new Error("mirror asset download -> HTTP 500");
      },
    }),
    (err) => {
      assert.match(err.message, /primary: network unreachable/);
      assert.match(err.message, /mirror:.*HTTP 500/);
      return true;
    },
  );
});
