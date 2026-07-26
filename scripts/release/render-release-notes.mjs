#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/render-release-notes.mjs
//
// Usage:
//   node scripts/release/render-release-notes.mjs \
//     --version 0.9.0 --repo Loombre/Loombre --tag v0.9.0 \
//     --out /tmp/release-notes.md

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReleaseNotes } from "./lib/render-release-notes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "release-notes-template.md");

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["version", "repo", "tag", "out"]) {
    if (!args[required]) {
      console.error(`render-release-notes: missing required --${required}`);
      process.exit(1);
    }
  }

  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const rendered = renderReleaseNotes(template, {
    LOOMBRE_VERSION: args.version,
    REPO: args.repo,
    TAG: args.tag,
  });

  writeFileSync(args.out, rendered);
  console.log(`render-release-notes: wrote ${args.out}`);
}

main();
