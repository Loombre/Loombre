#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/embed-public-key.mjs
//
// Reads keys/minisign.pub (P4.9 location #1) and writes
// packages/shared/src/update-public-key.ts — see
// scripts/release/lib/embed-public-key.mjs's header for why this is a
// compiled constant rather than a runtime file read.
//
// Usage: node scripts/release/embed-public-key.mjs
//        pnpm embed-public-key

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPublicKeyFileSource } from "./lib/embed-public-key.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PUBLIC_KEY_IN = path.join(REPO_ROOT, "keys/minisign.pub");
const OUT = path.join(REPO_ROOT, "packages/shared/src/update-public-key.ts");

function main() {
  const raw = readFileSync(PUBLIC_KEY_IN, "utf8");
  const source = renderPublicKeyFileSource(raw);
  writeFileSync(OUT, source);
  console.log(`embed-public-key: wrote ${path.relative(REPO_ROOT, OUT)} from ${path.relative(REPO_ROOT, PUBLIC_KEY_IN)}`);
}

main();
