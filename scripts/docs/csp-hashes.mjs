// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs/csp-hashes.mjs
//
// Emits the CSP script-src sha256 hashes for every inline <script> block
// in the built VitePress site (docs/.vitepress/dist) — one line per
// unique hash, ready to paste into a script-src directive.
//
// WHY THIS MUST RUN PER DEPLOY, not once: three of the inline blocks are
// build-dependent. VitePress stamps window.__VP_HASH_MAP__ with the
// content-hashed chunk names of THAT build (changes every build); the
// API-reference page inlines redoc.standalone.js (changes on a redoc
// version bump) and a __redoc_state blob serialized from openapi.yaml
// (changes with any contract edit). Only the two theme bootstrap
// snippets are stable across builds of the same VitePress version.
// A CSP pinned to yesterday's hashes bricks today's deploy silently —
// wire this into the same step that uploads dist/.
//
// Usage: node scripts/docs/csp-hashes.mjs [dist-dir]
//   -> prints e.g.  'sha256-DQUgNM…='  lines, then a ready-made
//      "script-src 'self' …" suggestion on the last line.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const distDir = process.argv[2] ?? join(process.cwd(), "docs/.vitepress/dist");

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (name.endsWith(".html")) yield p;
  }
}

// Inline scripts = <script> tags with no src attribute. The regex is safe
// here because we only consume our own VitePress build output, not
// arbitrary HTML.
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

const hashes = new Map(); // csp token -> { files: Set, preview }
let fileCount = 0;
for (const file of htmlFiles(distDir)) {
  fileCount++;
  const html = readFileSync(file, "utf8");
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const body = match[1];
    if (body.length === 0) continue;
    const token = `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`;
    if (!hashes.has(token)) {
      hashes.set(token, {
        files: new Set(),
        preview: body.slice(0, 48).replace(/\s+/g, " ").trim(),
      });
    }
    hashes.get(token).files.add(relative(distDir, file));
  }
}

if (fileCount === 0) {
  console.error(`csp-hashes: no .html files under ${distDir} — build the site first (pnpm docs:build)`);
  process.exit(1);
}

for (const [token, info] of hashes) {
  const where = info.files.size === fileCount ? "every page" : [...info.files].slice(0, 2).join(", ") + (info.files.size > 2 ? ", …" : "");
  console.log(`'${token}'  # ${where} — ${info.preview}`);
}
console.log("");
console.log(`script-src 'self' ${[...hashes.keys()].map((t) => `'${t}'`).join(" ")};`);
