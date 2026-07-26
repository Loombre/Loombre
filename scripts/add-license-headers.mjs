#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/add-license-headers.mjs
//
// P4.8 (AGPL readiness) deliverable: prepends the SPDX AGPL-3.0-only
// license identifier to every hand-written source file in the repo.
//
// SAFE BY DEFAULT: dry-run unless invoked with --write. Dry-run is what
// `pnpm gate`-adjacent CI and this report both use; --write is reserved
// for the relicense event itself (an owner-triggered, one-commit action —
// LICENSE-INTENT.md "Declared intent"), or for the drafted-not-merged
// swap branch that rehearses it. Running this script never touches
// node_modules, never runs pnpm, and never writes outside tracked files.
//
// SCOPE (why these extensions and not others):
//   .ts .tsx .js .jsx .mjs .cjs .cs .swift .sh .sql .css
// These are Loombre's own hand-written, compiled/executed source. Left
// OUT of scope deliberately:
//   - .json: no comment syntax exists in JSON at all.
//   - .yaml/.yml, .md, .wxs/.xml, Dockerfile: config/docs/build-markup,
//     not source in the licensing sense; each has its own header
//     placement rules (e.g. an XML declaration MUST be a document's
//     first token, .md conventionally carries no header at all). A
//     follow-up can extend this script format-by-format if the owner
//     wants full REUSE-spec (reuse.software) coverage; flagged in
//     reports/agpl-readiness.md rather than silently done here.
//
// FILE DISCOVERY: `git ls-files`, not a directory walk. This means the
// script only ever sees tracked, non-gitignored files — vendor/, dist/,
// .next/, .build*/, node_modules/, installers/*/out, all the generated
// build trees are excluded FOR FREE by the same mechanism that keeps
// them out of git, with zero duplicated exclusion-list maintenance
// against .gitignore (see scripts/grep-gates.mjs for the alternative,
// hand-maintained-list approach this script deliberately avoids).
//
// GENERATED-FILE DETECTION: every generated file actually committed in
// this repo (packages/sdk/src/generated/*.ts, packages/shared/src/
// version.ts, packages/shared/src/update-public-key.ts,
// packages/db/schema.sql) carries a first-line `GENERATED` marker
// (case-sensitive, established convention — see those files). Any
// tracked file whose first two lines contain that token as a whole word
// is skipped: a generated file's *source template* (the .mjs that
// writes it) gets a header; its own output should not carry one that a
// regeneration would blow away and re-litigate every gate run.
//
// IDEMPOTENCY: a file already containing the exact SPDX line (anywhere
// in its first 5 lines) is left untouched and counted separately —
// running this script twice, or against a file relicensed by hand, is a
// no-op the second time.
//
// INSERTION POINT: normally the new first line. Two exceptions, both
// because *their* first line is load-bearing for a toolchain and must
// stay literally first:
//   - a shebang line (`#!...`)
//   - a Swift `// swift-tools-version:` pragma (Package.swift)
// In both cases the header is inserted as the new second line instead.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SPDX_LINE_TEXT = "SPDX-License-Identifier: AGPL-3.0-only";

/** @type {Record<string, "slash" | "hash" | "sql" | "block">} */
const COMMENT_STYLE_BY_EXT = {
  ".ts": "slash",
  ".tsx": "slash",
  ".js": "slash",
  ".jsx": "slash",
  ".mjs": "slash",
  ".cjs": "slash",
  ".cs": "slash",
  ".swift": "slash",
  ".sh": "hash",
  ".sql": "sql",
  ".css": "block",
};

const HEADER_LINE_BY_STYLE = {
  slash: `// ${SPDX_LINE_TEXT}`,
  hash: `# ${SPDX_LINE_TEXT}`,
  sql: `-- ${SPDX_LINE_TEXT}`,
  block: `/* ${SPDX_LINE_TEXT} */`,
};

const GENERATED_MARKER = /\bGENERATED\b/;
const SHEBANG = /^#!/;
const SWIFT_TOOLS_VERSION = /^\/\/\s*swift-tools-version:/;

function extOf(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

function listTrackedFiles() {
  // -z: NUL-separated, so paths with spaces (this repo's own root!) or
  // any other odd byte survive intact with no shell/quoting involvement.
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter((p) => p.length > 0);
}

function classify(path) {
  const ext = extOf(path);
  const style = COMMENT_STYLE_BY_EXT[ext];
  if (!style) return { eligible: false, reason: "extension-out-of-scope" };

  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    return { eligible: false, reason: `unreadable: ${/** @type {Error} */ (err).message}` };
  }

  const lines = content.split(/\r?\n/);
  const firstTwo = lines.slice(0, 2).join("\n");
  if (GENERATED_MARKER.test(firstTwo)) {
    return { eligible: false, reason: "generated-marker" };
  }

  const headerLine = HEADER_LINE_BY_STYLE[style];
  const firstFive = lines.slice(0, 5).join("\n");
  if (firstFive.includes(SPDX_LINE_TEXT)) {
    return { eligible: false, reason: "already-headered" };
  }

  let insertAt = 0;
  const first = lines[0] ?? "";
  if (SHEBANG.test(first)) insertAt = 1;
  else if (style === "slash" && SWIFT_TOOLS_VERSION.test(first)) insertAt = 1;

  return { eligible: true, content, lines, insertAt, headerLine, ext };
}

function apply(path, info) {
  const next = [...info.lines];
  // CSS: stylelint's comment-empty-line-before wants a blank line between the
  // inserted header comment and the file's own leading comment — insert the
  // header AND a blank line so the output is lint-clean (the file's original
  // first line is almost always a /** ... */ banner). Other styles need no
  // separator (the next line is code/comment either is fine to lint).
  const rows = info.ext === ".css" ? [info.headerLine, ""] : [info.headerLine];
  next.splice(info.insertAt, 0, ...rows);
  // Preserve whatever trailing-newline convention the file already had:
  // content.split on \n then join with \n reproduces the exact original
  // for every line except the header we inserted (a plain LF line).
  const eol = info.content.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(path, next.join(eol));
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const verbose = args.includes("--verbose");

  const files = listTrackedFiles();

  /** @type {Record<string, number>} */
  const skippedByReason = {};
  const touched = [];
  const eligibleByExt = {};

  for (const path of files) {
    const info = classify(path);
    if (!info.eligible) {
      if (info.reason !== "extension-out-of-scope") {
        skippedByReason[info.reason] = (skippedByReason[info.reason] ?? 0) + 1;
      }
      continue;
    }
    touched.push(path);
    eligibleByExt[info.ext] = (eligibleByExt[info.ext] ?? 0) + 1;
    if (write) apply(path, info);
  }

  const scannedInScopeExt = files.filter((p) => COMMENT_STYLE_BY_EXT[extOf(p)]).length;

  console.log(`add-license-headers: ${write ? "WRITE" : "DRY-RUN"}`);
  console.log(`  tracked files (git ls-files): ${files.length}`);
  console.log(`  in-scope by extension: ${scannedInScopeExt}`);
  for (const [reason, count] of Object.entries(skippedByReason).sort()) {
    console.log(`  skipped (${reason}): ${count}`);
  }
  console.log(`  ${write ? "headers written" : "would touch"}: ${touched.length}`);
  console.log(`  by extension:`);
  for (const [ext, count] of Object.entries(eligibleByExt).sort()) {
    console.log(`    ${ext}: ${count}`);
  }

  const sample = verbose ? touched : touched.slice(0, 15);
  console.log(`  ${verbose ? "all files" : "sample (first 15)"}:`);
  for (const path of sample) {
    console.log(`    ${path}`);
  }
  if (!verbose && touched.length > sample.length) {
    console.log(`    ...and ${touched.length - sample.length} more (--verbose to list all)`);
  }

  if (!write && touched.length > 0) {
    console.log(`\n  Re-run with --write to apply (relicense event / swap branch only — never on main outside that event).`);
  }
}

main();
