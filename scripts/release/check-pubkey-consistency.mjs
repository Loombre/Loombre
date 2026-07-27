#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/check-pubkey-consistency.mjs
//
// STATE.md P4.9: the minisign public key must be published, byte-
// identical, in THREE canonical, independently-controlled trust
// locations — "so key-substitution attacks require compromising all of
// them":
//   1. keys/minisign.pub (the repo file; also what
//      scripts/release/embed-public-key.mjs bakes into
//      packages/shared/src/update-public-key.ts, the server's own copy)
//   2. docs/ops/updating.md's "Verifying releases" section
//      (LOOMBRE_MINISIGN_PUBLIC_KEY_BEGIN/_END markers)
//   3. scripts/release/release-notes-template.md (the same markers — the
//      GitHub Release notes template .github/workflows/release.yml
//      renders via scripts/release/render-release-notes.mjs; kept as a
//      standalone Markdown file rather than inlined in the workflow YAML
//      so its ``` fences stay literal — see render-release-notes.mjs's
//      header for why an inline bash heredoc doesn't work for this)
//
// This script checks those three PLUS two more things, byte-identical
// against them (five FIXED_LOCATIONS total — see
// scripts/release/lib/pubkey-consistency.mjs's header for the full
// reasoning):
//   4. packages/shared/src/update-public-key.ts (GENERATED — the
//      compiled-in copy the server's update-check verifier actually
//      imports; freshness relative to keys/minisign.pub, i.e. "did
//      someone forget to run `pnpm embed-public-key`", not a fourth
//      independent P4.9 trust root)
//   5. docs/install/linux.md's "Verify what you downloaded" section (same
//      markers — added after an audit found this page still shipping the
//      all-zero placeholder key after the real key had landed everywhere
//      else; H5 residue fix. Not a P4.9 trust root either, but a wrong key
//      here is exactly as misleading to a downloader as a wrong key
//      anywhere else.)
//
// On TOP of that five-way equality check, this script separately treats
// the all-zero PLACEHOLDER key as its own, prior failure condition (H5):
// a placeholder pasted into every location agrees with itself perfectly,
// and an equality-only check would PASS against it. See
// scripts/release/lib/pubkey-consistency.mjs's header + detectPlaceholder
// for the two independent signals checked (the literal all-zero base64
// line, and the `untrusted comment: PLACEHOLDER` self-identification).
//
// It ALSO sweeps every other tracked .md page under docs/ (git ls-files,
// so build output under docs/.vitepress/dist is never in scope — that
// directory isn't tracked anyway) for a stray LOOMBRE_MINISIGN_PUBLIC_KEY
// marker block nobody wired into the five FIXED_LOCATIONS above; any such
// block must extract cleanly and must not hold the placeholder.
//
// Pure comparison/extraction logic lives in
// scripts/release/lib/pubkey-consistency.mjs (node:test-covered by
// scripts/release/test/pubkey-consistency.test.mjs with in-memory
// fixtures); this file is the thin fs-reading CLI wrapper. Run:
//   node scripts/release/check-pubkey-consistency.mjs
// Wired into BOTH .github/workflows/release.yml's `prepare` job (fail a
// bad tag in seconds, before any build spend) AND its `release` job
// (pre-sign, belt-and-braces — this lane owns that workflow) AND
// .github/workflows/ci.yml's "pubkey three-location consistency" step
// (every PR that touches any checked location, not just at tag time —
// that file belongs to the orchestrator/another lane; see the release-
// lane report for that hand-off note).
//
// Exits non-zero with a clear, per-problem report on any placeholder,
// structural, or mismatch finding; exits 0 with one confirming line on
// success.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPubkeyConsistency, FIXED_LOCATIONS } from "./lib/pubkey-consistency.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function readRepoFile(relPath) {
  try {
    return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Every tracked .md file under docs/ (source tree only — docs/.vitepress/
 * dist and docs/.vitepress/cache are build output/cache and are gitignored,
 * so `git ls-files` already never returns them; the path-substring guard
 * below is belt-and-braces in case that ever changes).
 */
function listDocsMarkdownFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--", "docs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((p) => p.length > 0)
    .filter((p) => p.endsWith(".md"))
    .filter((p) => !p.includes(".vitepress/dist/") && !p.includes(".vitepress/cache/"));
}

function main() {
  const files = {};
  for (const loc of FIXED_LOCATIONS) {
    const content = readRepoFile(loc.label);
    if (content !== undefined) files[loc.label] = content;
  }

  const docsSweep = listDocsMarkdownFiles().map((relPath) => ({
    path: relPath,
    content: readRepoFile(relPath) ?? "",
  }));

  const verdict = checkPubkeyConsistency({ files, docsSweep });

  if (!verdict.ok) {
    console.error(`check-pubkey-consistency: FAIL — ${verdict.problems.length} problem(s) found\n`);
    for (const problem of verdict.problems) {
      console.error(`[${problem.type}] ${problem.message}`);
    }
    const mismatches = verdict.problems.filter((p) => p.type === "mismatch");
    if (mismatches.length > 0) {
      console.error("");
      for (const loc of verdict.locations) {
        console.error(`--- ${loc.label} ---`);
        console.error(loc.value);
        console.error("");
      }
    }
    process.exit(1);
  }

  console.log(
    `check-pubkey-consistency: PASS — all ${FIXED_LOCATIONS.length} locations agree and no placeholder found (docs sweep: ${docsSweep.length} file(s) scanned)`,
  );
}

main();
