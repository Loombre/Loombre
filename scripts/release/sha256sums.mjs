#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/sha256sums.mjs
//
// Writes a standard `sha256sum -c`-compatible SHA256SUMS file covering
// every real file in --artifacts-dir (docker-image.json's sidecar and any
// previously-written manifest.json/SHA256SUMS/*.minisig are excluded —
// SHA256SUMS checksums the DOWNLOADABLE release artifacts, not its own
// metadata). Line format: `<64 hex sha256>  <filename>\n` (two spaces,
// GNU coreutils' own convention) so `sha256sum -c SHA256SUMS` works
// verbatim for anyone verifying a download (docs/ops/updating.md).
//
// Usage:
//   node scripts/release/sha256sums.mjs --artifacts-dir dist/release --out dist/release/SHA256SUMS

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const EXCLUDED_FILES = new Set(["docker-image.json", "manifest.json", "manifest.json.minisig", "SHA256SUMS", "SHA256SUMS.minisig"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["artifacts-dir"] || !args.out) {
    console.error("sha256sums: requires --artifacts-dir and --out");
    process.exit(1);
  }

  const artifactsDir = path.isAbsolute(args["artifacts-dir"]) ? args["artifacts-dir"] : path.join(REPO_ROOT, args["artifacts-dir"]);
  const entries = readdirSync(artifactsDir)
    .filter((entry) => !EXCLUDED_FILES.has(entry))
    .filter((entry) => statSync(path.join(artifactsDir, entry)).isFile())
    .sort();

  if (entries.length === 0) {
    console.error(`sha256sums: no files found in ${artifactsDir}`);
    process.exit(1);
  }

  const lines = entries.map((entry) => `${sha256File(path.join(artifactsDir, entry))}  ${entry}`);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(REPO_ROOT, args.out);
  writeFileSync(outPath, `${lines.join("\n")}\n`);
  console.log(`sha256sums: wrote ${path.relative(REPO_ROOT, outPath)} — ${entries.length} file(s)`);
}

main();
