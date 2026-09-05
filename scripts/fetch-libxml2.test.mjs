// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/fetch-libxml2.test.mjs
//
// Unit tests for scripts/fetch-libxml2.mjs's pure half (no network, no
// vendor writes) plus the checked-in manifest's own shape — the same
// posture as scripts/fetch-ffmpeg.test.mjs: a tampered download must fail
// closed, and the manifest the release build reads must validate.
//
// Run: node --test scripts/fetch-libxml2.test.mjs (or `pnpm scripts:test`).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_MANIFEST_PATH,
  KNOWN_PLATFORMS,
  loadManifest,
  parseArgs,
  resolveHostPlatform,
  sha256Hex,
  validateManifestSchema,
  verifyChecksum,
} from "./fetch-libxml2.mjs";

function goodManifest() {
  return {
    manifestSchemaVersion: 1,
    pinnedAtMs: 1,
    provenance: { note: "n", license: "MIT", extraction: "e" },
    platforms: {
      "linux-x64": {
        source: "s",
        package: "libxml2-2.9.13-12.el9_6.x86_64.rpm",
        url: "https://example.invalid/l/libxml2-2.9.13-12.el9_6.x86_64.rpm",
        sha256: "a".repeat(64),
        sizeBytes: 10,
        libraryEntry: "./usr/lib64/libxml2.so.2.9.13",
        licenseEntry: "./usr/share/licenses/libxml2/Copyright",
        soname: "libxml2.so.2",
        libxml2Version: "2.9.13",
        verification: "v",
      },
    },
  };
}

test("sha256Hex matches a known vector", () => {
  assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("verifyChecksum: fails closed on tamper, accepts a match, rejects a malformed pin", () => {
  const bytes = Buffer.from("payload");
  const pin = sha256Hex(bytes);
  assert.equal(verifyChecksum(bytes, pin).ok, true);
  assert.equal(verifyChecksum(Buffer.from("payloae"), pin).ok, false);
  assert.throws(() => verifyChecksum(bytes, "nope"), TypeError);
});

test("validateManifestSchema: accepts a well-formed manifest and rejects the obvious mistakes", () => {
  assert.deepEqual(validateManifestSchema(goodManifest()), { ok: true, errors: [] });
  const badPlatform = goodManifest();
  badPlatform.platforms["windows-x64"] = badPlatform.platforms["linux-x64"];
  assert.match(validateManifestSchema(badPlatform).errors.join("\n"), /windows-x64: not a known platform/);
  const badSha = goodManifest();
  badSha.platforms["linux-x64"].sha256 = "ABC";
  assert.match(validateManifestSchema(badSha).errors.join("\n"), /sha256/);
  const badUrl = goodManifest();
  badUrl.platforms["linux-x64"].url = "http://example.invalid/libxml2-2.9.13-12.el9_6.x86_64.rpm";
  assert.match(validateManifestSchema(badUrl).errors.join("\n"), /must be https/);
  const mismatched = goodManifest();
  mismatched.platforms["linux-x64"].package = "other.rpm";
  assert.match(validateManifestSchema(mismatched).errors.join("\n"), /must end with \/other\.rpm/);
  const badSoname = goodManifest();
  badSoname.platforms["linux-x64"].soname = "libxml2.so";
  assert.match(validateManifestSchema(badSoname).errors.join("\n"), /soname/);
});

test("THE CHECKED-IN MANIFEST (installers/libxml2-manifest.json) validates, pins both Linux platforms, and pins distinct rpms", () => {
  const manifest = loadManifest(DEFAULT_MANIFEST_PATH);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [...KNOWN_PLATFORMS].sort());
  const shas = Object.values(manifest.platforms).map((e) => e.sha256);
  assert.equal(new Set(shas).size, shas.length, "each platform pins its own archive");
  for (const entry of Object.values(manifest.platforms)) {
    assert.equal(entry.soname, "libxml2.so.2", "the whole point is providing the .so.2 soname PostgreSQL links");
    assert.match(entry.url, /^https:\/\/dl\.rockylinux\.org\/vault\/rocky\/9\.\d+\//, "a versioned vault snapshot, not the moving current mirror");
  }
  const raw = readFileSync(DEFAULT_MANIFEST_PATH, "utf8");
  assert.ok(raw.includes("GLIBC_2.34"), "the manifest records the verified glibc floor");
});

test("resolveHostPlatform / parseArgs", () => {
  assert.equal(resolveHostPlatform("host", { platform: "linux", arch: "x64" }), "linux-x64");
  assert.equal(resolveHostPlatform("host", { platform: "linux", arch: "arm64" }), "linux-arm64");
  assert.equal(resolveHostPlatform("linux-arm64", { platform: "darwin", arch: "arm64" }), "linux-arm64");
  assert.throws(() => resolveHostPlatform("host", { platform: "darwin", arch: "arm64" }), /pass --platform/);
  const args = parseArgs(["--platform", "all", "--force", "--check-urls"]);
  assert.equal(args.platform, "all");
  assert.equal(args.force, true);
  assert.equal(args.checkUrls, true);
  assert.throws(() => parseArgs(["--bogus"]), /unrecognized/);
});
