// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/fetch-embedded-pg.test.mjs
//
// Unit tests for scripts/fetch-embedded-pg.mjs's pure logic — no network,
// no filesystem writes outside a single readFileSync of the checked-in
// manifest for the schema-validity assertion. Mirrors
// scripts/fetch-ffmpeg.test.mjs's own convention exactly (same lane-B
// resource-isolation note applies: this is NOT wired into `pnpm gate`'s
// turbo-scoped `test` step; run directly with Node's built-in test runner:
//
//   node --test scripts/fetch-embedded-pg.test.mjs

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
  resolvePlatformEntry,
  vendorPlatformVersionDir,
  postgresBinaryName,
  KNOWN_PLATFORMS,
  DEFAULT_MANIFEST_PATH,
} from "./fetch-embedded-pg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("sha256Hex matches a known vector", () => {
  const expected = createHash("sha256").update(Buffer.from("")).digest("hex");
  assert.equal(expected.length, 64);
  assert.equal(sha256Hex(Buffer.from("")), expected);
});

test("verifyChecksum: ok=true when bytes match the pinned sha256", () => {
  const buffer = Buffer.from("loombre-fixture-bytes");
  const expected = createHash("sha256").update(buffer).digest("hex");
  const result = verifyChecksum(buffer, expected);
  assert.equal(result.ok, true);
});

test("verifyChecksum: FAILS CLOSED on tamper", () => {
  const realBytes = Buffer.from("this is the real, checksum-pinned postgres archive");
  const pinnedSha256 = createHash("sha256").update(realBytes).digest("hex");
  const tamperedBytes = Buffer.concat([realBytes.subarray(0, realBytes.length - 1), Buffer.from("!")]);
  const result = verifyChecksum(tamperedBytes, pinnedSha256);
  assert.equal(result.ok, false);
  assert.notEqual(result.actual, pinnedSha256);
});

test("verifyChecksum: rejects a malformed pinned sha256 rather than silently passing", () => {
  assert.throws(() => verifyChecksum(Buffer.from("x"), "not-a-sha256"), TypeError);
  assert.throws(() => verifyChecksum(Buffer.from("x"), ""), TypeError);
});

test("validateManifestSchema: accepts a minimal well-formed manifest", () => {
  const manifest = {
    manifestSchemaVersion: 1,
    defaultVersion: "17.10.0",
    versions: {
      "17.10.0": {
        platforms: {
          "linux-x64": {
            target: "x86_64-unknown-linux-gnu",
            url: "https://example.invalid/pg.tar.gz",
            archiveFormat: "tar.gz",
            archiveTopDir: "postgresql-17.10.0-x86_64-unknown-linux-gnu",
            sha256: "a".repeat(64),
            sizeBytes: 100,
          },
        },
      },
    },
  };
  const result = validateManifestSchema(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("validateManifestSchema: rejects a bad sha256", () => {
  const manifest = {
    manifestSchemaVersion: 1,
    defaultVersion: "17.10.0",
    versions: {
      "17.10.0": {
        platforms: {
          "linux-x64": {
            target: "t",
            url: "u",
            archiveFormat: "tar.gz",
            archiveTopDir: "d",
            sha256: "TOO-SHORT",
            sizeBytes: 1,
          },
        },
      },
    },
  };
  const result = validateManifestSchema(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("sha256")));
});

test("validateManifestSchema: rejects an unknown platform key", () => {
  const manifest = {
    manifestSchemaVersion: 1,
    defaultVersion: "17.10.0",
    versions: {
      "17.10.0": {
        platforms: {
          "freebsd-x64": { target: "t", url: "u", archiveFormat: "zip", archiveTopDir: "d", sha256: "a".repeat(64), sizeBytes: 1 },
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
    defaultVersion: "17.10.0",
    versions: {
      "17.10.0": {
        platforms: {
          "macos-x64": { target: "t", url: "u", archiveFormat: "rar", archiveTopDir: "d", sha256: "a".repeat(64), sizeBytes: 1 },
        },
      },
    },
  };
  const result = validateManifestSchema(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("archiveFormat")));
});

test("validateManifestSchema: rejects manifestSchemaVersion != 1", () => {
  const manifest = { manifestSchemaVersion: 2, defaultVersion: "17.10.0", versions: {} };
  const result = validateManifestSchema(manifest);
  assert.equal(result.ok, false);
});

test("THE CHECKED-IN MANIFEST (installers/embedded-pg-manifest.json) passes schema validation", () => {
  const manifestPath = join(__dirname, "..", "installers", "embedded-pg-manifest.json");
  assert.equal(manifestPath, DEFAULT_MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = validateManifestSchema(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("THE CHECKED-IN MANIFEST: covers all five installer-lane platforms for BOTH the default version and the upgrade-test version", () => {
  const manifestPath = join(__dirname, "..", "installers", "embedded-pg-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const versions = Object.keys(manifest.versions);
  assert.ok(versions.length >= 2, "expected at least the default version + a 16.x upgrade-test version");
  for (const version of versions) {
    for (const platform of KNOWN_PLATFORMS) {
      assert.ok(manifest.versions[version].platforms[platform], `expected ${version}/${platform} in the manifest`);
    }
  }
});

test("THE CHECKED-IN MANIFEST: defaultVersion's major is 18 (N4 adoption), the extra version's major is 17 (upgrade-test only)", () => {
  const manifestPath = join(__dirname, "..", "installers", "embedded-pg-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.defaultVersion.startsWith("18."));
  assert.equal(manifest.pgMajorFloor, 17);
  const otherVersions = Object.keys(manifest.versions).filter((v) => v !== manifest.defaultVersion);
  assert.ok(otherVersions.every((v) => v.startsWith("17.")));
});

test("resolveHostPlatform: auto-detects from injected platform/arch", () => {
  assert.equal(resolveHostPlatform(undefined, { platform: "linux", arch: "x64" }), "linux-x64");
  assert.equal(resolveHostPlatform(undefined, { platform: "linux", arch: "arm64" }), "linux-arm64");
  assert.equal(resolveHostPlatform("host", { platform: "darwin", arch: "arm64" }), "macos-arm64");
  assert.equal(resolveHostPlatform("host", { platform: "darwin", arch: "x64" }), "macos-x64");
  assert.equal(resolveHostPlatform("host", { platform: "win32", arch: "x64" }), "windows-x64");
});

test("resolveHostPlatform: throws on an unsupported host rather than guessing", () => {
  assert.throws(() => resolveHostPlatform(undefined, { platform: "sunos", arch: "x64" }), /cannot auto-detect/);
});

test("parseArgs: defaults (pgVersion undefined -> caller falls back to manifest.defaultVersion)", () => {
  const args = parseArgs([]);
  assert.equal(args.platform, "host");
  assert.equal(args.pgVersion, undefined);
  assert.equal(args.force, false);
});

test("parseArgs: parses --platform/--pg-version/--force/--manifest/--vendor-dir", () => {
  const args = parseArgs(["--platform", "linux-arm64", "--pg-version", "16.14.0", "--force", "--manifest", "/tmp/m.json", "--vendor-dir", "/tmp/v"]);
  assert.equal(args.platform, "linux-arm64");
  assert.equal(args.pgVersion, "16.14.0");
  assert.equal(args.force, true);
  assert.equal(args.manifestPath, "/tmp/m.json");
  assert.equal(args.vendorDir, "/tmp/v");
});

test("parseArgs: rejects an unrecognized flag", () => {
  assert.throws(() => parseArgs(["--nonsense"]), /unrecognized argument/);
});

test("resolvePlatformEntry: defaults to manifest.defaultVersion when pgVersion is omitted", () => {
  const manifest = {
    defaultVersion: "17.10.0",
    versions: { "17.10.0": { platforms: { "linux-x64": { target: "t", url: "u", archiveFormat: "tar.gz", archiveTopDir: "d", sha256: "a".repeat(64), sizeBytes: 1 } } } },
  };
  const { version, platformEntry } = resolvePlatformEntry(manifest, undefined, "linux-x64");
  assert.equal(version, "17.10.0");
  assert.equal(platformEntry.target, "t");
});

test("resolvePlatformEntry: throws a clear error for an unknown version", () => {
  const manifest = { defaultVersion: "17.10.0", versions: { "17.10.0": { platforms: {} } } };
  assert.throws(() => resolvePlatformEntry(manifest, "99.0.0", "linux-x64"), /no manifest entry for pg-version/);
});

test("resolvePlatformEntry: throws a clear error for an unknown platform", () => {
  const manifest = { defaultVersion: "17.10.0", versions: { "17.10.0": { platforms: {} } } };
  assert.throws(() => resolvePlatformEntry(manifest, "17.10.0", "linux-x64"), /no manifest entry for platform/);
});

test("vendorPlatformVersionDir: matches packages/provisioning-pg/src/vendor-layout.ts's layout contract", () => {
  assert.equal(vendorPlatformVersionDir("/vendor", "macos-arm64", "17.10.0"), join("/vendor", "macos-arm64", "17.10.0"));
});

test("postgresBinaryName: .exe only for windows-x64", () => {
  assert.equal(postgresBinaryName("windows-x64"), "postgres.exe");
  assert.equal(postgresBinaryName("linux-x64"), "postgres");
  assert.equal(postgresBinaryName("macos-arm64"), "postgres");
});
