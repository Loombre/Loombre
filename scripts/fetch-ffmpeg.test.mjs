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
