#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/build-manifest.mjs
//
// Builds + validates dist/release/manifest.json from the artifacts
// build-linux/build-windows/build-macos/build-docker staged into
// --artifacts-dir (.github/workflows/release.yml's shared contract — see
// the release-lane report's "what release.yml needs from lanes I1-I4"
// section for the exact filename convention every installer script must
// follow: `loombre-<version>-<platform>.<ext>`).
//
// Usage:
//   node scripts/release/build-manifest.mjs \
//     --version 0.9.0 \
//     --notes-url https://github.com/<owner>/<repo>/releases/tag/v0.9.0 \
//     --artifacts-dir dist/release \
//     --base-url https://github.com/<owner>/<repo>/releases/download/v0.9.0 \
//     --out dist/release/manifest.json
//
// The Docker image artifact (no local file to hash — it lives in a
// registry) is picked up from a `docker-image.json` sidecar file in
// --artifacts-dir if present: `{ "filename": "...", "sizeBytes": N,
// "sha256": "<64 hex, the image digest without the 'sha256:' prefix>",
// "url": "..." }` — build-docker's job in release.yml writes this after
// `cosign sign`.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, inferPlatformAndKind, validateManifestShape } from "./lib/build-manifest-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`build-manifest: missing value for --${key}`);
      }
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function collectFileArtifacts(artifactsDir, baseUrl) {
  const artifacts = [];
  for (const entry of readdirSync(artifactsDir)) {
    if (entry === "docker-image.json" || entry.endsWith(".minisig") || entry === "SHA256SUMS" || entry === "manifest.json") {
      continue;
    }
    const full = path.join(artifactsDir, entry);
    if (!statSync(full).isFile()) continue;

    const inferred = inferPlatformAndKind(entry);
    if (!inferred) {
      console.warn(`build-manifest: skipping ${entry} — does not match the loombre-<version>-<platform>.<ext> naming convention`);
      continue;
    }

    artifacts.push({
      platform: inferred.platform,
      kind: inferred.kind,
      filename: entry,
      sizeBytes: statSync(full).size,
      sha256: sha256File(full),
      url: `${baseUrl.replace(/\/+$/, "")}/${entry}`,
    });
  }
  return artifacts;
}

function collectDockerArtifact(artifactsDir) {
  const sidecarPath = path.join(artifactsDir, "docker-image.json");
  if (!existsSync(sidecarPath)) return null;
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  return {
    platform: "docker",
    kind: "docker-image",
    filename: sidecar.filename,
    sizeBytes: sidecar.sizeBytes,
    sha256: sidecar.sha256,
    url: sidecar.url,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["version", "notes-url", "artifacts-dir", "base-url", "out"]) {
    if (!args[required]) {
      console.error(`build-manifest: missing required --${required}`);
      process.exit(1);
    }
  }

  const artifactsDir = path.isAbsolute(args["artifacts-dir"])
    ? args["artifacts-dir"]
    : path.join(REPO_ROOT, args["artifacts-dir"]);

  const artifacts = collectFileArtifacts(artifactsDir, args["base-url"]);
  const dockerArtifact = collectDockerArtifact(artifactsDir);
  if (dockerArtifact) artifacts.push(dockerArtifact);

  if (artifacts.length === 0) {
    console.error(`build-manifest: no artifacts found in ${artifactsDir} — refusing to write an empty manifest`);
    process.exit(1);
  }

  const manifest = buildManifest({
    version: args.version,
    releasedAtMs: Date.now(),
    notesUrl: args["notes-url"],
    artifacts,
  });

  const errors = validateManifestShape(manifest);
  if (errors.length > 0) {
    console.error(`build-manifest: manifest failed schema validation (${errors.length} error(s)):`);
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(REPO_ROOT, args.out);
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`build-manifest: wrote ${path.relative(REPO_ROOT, outPath)} — ${artifacts.length} artifact(s), version ${args.version}`);
}

main();
