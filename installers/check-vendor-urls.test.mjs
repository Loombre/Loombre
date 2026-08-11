// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: installers/check-vendor-urls.test.mjs
//
// Unit tests for installers/check-vendor-urls.mjs's pure logic + its
// probeUrl network seam (fetchImpl is injected — no real network access in
// this file). Run directly with Node's built-in test runner:
//
//   node --test installers/check-vendor-urls.test.mjs
//
// Matches this repo's `pnpm installers:test` glob
// ("installers/**/*.test.mjs") — unlike scripts/fetch-ffmpeg.test.mjs
// (that script lives in scripts/, covered by `pnpm scripts:test` instead),
// this one lives in installers/ alongside the script it tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, collectUniqueComponents, probeUrl } from "./check-vendor-urls.mjs";
import { deriveMirrorAssetName, DEFAULT_MANIFEST_PATH } from "../scripts/fetch-ffmpeg.mjs";

test("parseArgs: defaults to the checked-in manifest path", () => {
  const args = parseArgs([]);
  assert.equal(args.manifestPath, DEFAULT_MANIFEST_PATH);
  assert.equal(args.help, false);
});

test("parseArgs: --manifest overrides the default", () => {
  const args = parseArgs(["--manifest", "/tmp/m.json"]);
  assert.equal(args.manifestPath, "/tmp/m.json");
});

test("parseArgs: --help / -h set help without requiring a manifest", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: rejects an unrecognized flag rather than silently ignoring it", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unrecognized argument/);
});

test("collectUniqueComponents: one entry per distinct archive, tagged with every platform that wants it", () => {
  const manifest = {
    platforms: {
      "linux-x64": {
        components: {
          ffmpeg: { url: "https://x/linux.tar.xz", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffmpeg" },
          ffprobe: { url: "https://x/linux.tar.xz", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffprobe" },
        },
      },
      "macos-x64": {
        components: {
          ffmpeg: { url: "https://x/mac-ffmpeg.zip", format: "zip", sha256: "b".repeat(64), sizeBytes: 1, binaryEntryName: "ffmpeg" },
          ffprobe: { url: "https://x/mac-ffprobe.zip", format: "zip", sha256: "c".repeat(64), sizeBytes: 1, binaryEntryName: "ffprobe" },
        },
      },
    },
  };
  const components = collectUniqueComponents(manifest);
  // linux-x64 collapses ffmpeg+ffprobe (shared archive) to ONE entry;
  // macos-x64 keeps two (distinct archives) — 3 total.
  assert.equal(components.length, 3);
  const linuxEntry = components.find((c) => c.url === "https://x/linux.tar.xz");
  assert.deepEqual(linuxEntry.platforms, ["linux-x64"]);
});

test("collectUniqueComponents: the SAME archive shared across two platforms is reported once, tagged with both", () => {
  const manifest = {
    platforms: {
      "platform-a": {
        components: {
          ffmpeg: { url: "https://x/shared.tar.xz", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffmpeg" },
          ffprobe: { url: "https://x/shared.tar.xz", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffprobe" },
        },
      },
      "platform-b": {
        components: {
          ffmpeg: { url: "https://x/shared.tar.xz", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffmpeg" },
          ffprobe: { url: "https://x/shared.tar.xz", format: "tar.xz", sha256: "a".repeat(64), sizeBytes: 1, binaryEntryName: "ffprobe" },
        },
      },
    },
  };
  const components = collectUniqueComponents(manifest);
  assert.equal(components.length, 1);
  assert.deepEqual(components[0].platforms, ["platform-a", "platform-b"]);
});

test("collectUniqueComponents: derived mirror asset names match scripts/fetch-ffmpeg.mjs's own function (shared, not duplicated)", () => {
  const manifest = {
    platforms: {
      "linux-x64": {
        components: {
          ffmpeg: {
            url: "https://x/ffmpeg-1.2.3.tar.xz",
            format: "tar.xz",
            sha256: "7b0c2ad593860d8bb157e346777ac7d741b5bf25b456382051138aaa8256f92d",
            sizeBytes: 1,
            binaryEntryName: "ffmpeg",
          },
          ffprobe: {
            url: "https://x/ffmpeg-1.2.3.tar.xz",
            format: "tar.xz",
            sha256: "7b0c2ad593860d8bb157e346777ac7d741b5bf25b456382051138aaa8256f92d",
            sizeBytes: 1,
            binaryEntryName: "ffprobe",
          },
        },
      },
    },
  };
  const [component] = collectUniqueComponents(manifest);
  const name = deriveMirrorAssetName(component.sha256, component.url);
  assert.equal(name, "7b0c2ad59386--ffmpeg-1.2.3.tar.xz");
});

// ─────────────────────────────────────────────────────────────────────────
// probeUrl — fetchImpl injected, zero real network access.
// ─────────────────────────────────────────────────────────────────────────

function fakeFetch(responder) {
  return async (url, init) => responder(url, init);
}

test("probeUrl: HEAD 200 -> ok, does not attempt GET+Range", async () => {
  let getCalled = false;
  const fetchImpl = fakeFetch(async (url, init) => {
    if (init.method === "GET") getCalled = true;
    assert.equal(init.method, "HEAD");
    return { ok: true, status: 200 };
  });
  const result = await probeUrl("https://example.invalid/x.tar.xz", { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.method, "HEAD");
  assert.equal(getCalled, false);
});

test("probeUrl: HEAD 404 -> miss, does not attempt GET+Range (a real 404 is a real answer)", async () => {
  let getCalled = false;
  const fetchImpl = fakeFetch(async (url, init) => {
    if (init.method === "GET") getCalled = true;
    return { ok: false, status: 404 };
  });
  const result = await probeUrl("https://example.invalid/gone.tar.xz", { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.method, "HEAD");
  assert.equal(getCalled, false);
});

test("probeUrl: HEAD 405 Method Not Allowed -> falls back to GET+Range", async () => {
  const fetchImpl = fakeFetch(async (url, init) => {
    if (init.method === "HEAD") return { ok: false, status: 405 };
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Range, "bytes=0-0");
    return { ok: true, status: 206, body: {}, arrayBuffer: async () => new ArrayBuffer(1) };
  });
  const result = await probeUrl("https://example.invalid/head-unsupported.tar.xz", { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 206);
  assert.equal(result.method, "GET+Range");
});

test("probeUrl: HEAD throws (network error) -> falls back to GET+Range", async () => {
  const fetchImpl = fakeFetch(async (url, init) => {
    if (init.method === "HEAD") throw new Error("ECONNRESET");
    return { ok: true, status: 206, body: {}, arrayBuffer: async () => new ArrayBuffer(1) };
  });
  const result = await probeUrl("https://example.invalid/flaky.tar.xz", { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.method, "GET+Range");
});

test("probeUrl: both HEAD and GET+Range fail -> reports a miss with the error message, never throws", async () => {
  const fetchImpl = fakeFetch(async (url, init) => {
    throw new Error(init.method === "HEAD" ? "head failed" : "get failed too");
  });
  const result = await probeUrl("https://example.invalid/totally-down.tar.xz", { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.method, "GET+Range");
  assert.match(result.error, /get failed too/);
});
