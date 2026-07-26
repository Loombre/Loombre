// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs/lib/walk-md.mjs
//
// Shared helper for the docs-build tooling (register-lint.mjs,
// collect-screenshots.mjs): lists every Markdown source file under docs/
// that VitePress actually renders — i.e. respects the same exclusions as
// docs/.vitepress/config.mts's `srcExclude` (docs/PLAN.md, docs/PLAYBACK.md
// stay internal specs, never published) plus the generator/build dirs.

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const EXCLUDED_DIR_NAMES = new Set([".vitepress", "node_modules"]);

// Mirrors docs/.vitepress/config.mts srcExclude — kept in sync by hand
// (both are short, human-reviewed lists; see that file's header comment).
const EXCLUDED_FILES = new Set(["PLAN.md", "PLAYBACK.md"]);

/**
 * @param {string} docsRoot absolute path to the docs/ directory
 * @returns {{ full: string, rel: string }[]} every published .md file,
 *   `rel` relative to docsRoot using forward slashes on every platform
 */
export function walkDocs(docsRoot) {
  const out = [];
  walk(docsRoot, docsRoot, out);
  return out;
}

function walk(root, dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      walk(root, full, out);
      continue;
    }
    if (!st.isFile()) continue;
    if (!entry.endsWith(".md")) continue;
    const rel = relative(root, full).split(sep).join("/");
    if (EXCLUDED_FILES.has(rel)) continue;
    out.push({ full, rel });
  }
}
