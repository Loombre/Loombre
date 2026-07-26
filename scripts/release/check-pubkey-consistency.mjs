#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/check-pubkey-consistency.mjs
//
// STATE.md P4.9: the minisign public key must be published, byte-
// identical, in THREE independently-maintained locations —
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
// — "so key-substitution attacks require compromising all of them."
//
// This script is the CI-runnable proof they agree. Run:
//   node scripts/release/check-pubkey-consistency.mjs
// Wired into .github/workflows/release.yml's `release` job (this lane owns
// that workflow). It is NOT wired into .github/workflows/ci.yml — that
// file belongs to the orchestrator/another lane; see the release-lane
// report for that hand-off note. Also verifies the GENERATED
// packages/shared/src/update-public-key.ts is in sync with keys/
// minisign.pub (catches "forgot to run `pnpm embed-public-key`" as a
// fourth, build-artifact-freshness check, not a fourth independent P4.9
// location).
//
// Exits non-zero with a clear diff-style report on any mismatch; exits 0
// silently... well, with one confirming line, on success.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const BEGIN_MARKER = "LOOMBRE_MINISIGN_PUBLIC_KEY_BEGIN";
const END_MARKER = "LOOMBRE_MINISIGN_PUBLIC_KEY_END";

function readRepoFile(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

/** Extracts the fenced-code-block content between the two marker comments. */
function extractMarkedBlock(source, sourceLabel) {
  const beginIdx = source.indexOf(BEGIN_MARKER);
  const endIdx = source.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`${sourceLabel}: missing or misordered ${BEGIN_MARKER}/${END_MARKER} markers`);
  }
  const between = source.slice(beginIdx + BEGIN_MARKER.length, endIdx);
  const fenceMatches = [...between.matchAll(/```(?:\n|\r\n)([\s\S]*?)```/g)];
  if (fenceMatches.length !== 1) {
    throw new Error(
      `${sourceLabel}: expected exactly one \`\`\`-fenced block between the markers, found ${fenceMatches.length}`,
    );
  }
  const content = fenceMatches[0][1];
  if (content === undefined) {
    throw new Error(`${sourceLabel}: fenced block matched but captured no content`);
  }
  return content.trimEnd();
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

function main() {
  const keysFile = normalize(readRepoFile("keys/minisign.pub"));

  const docsSource = readRepoFile("docs/ops/updating.md");
  const docsBlock = normalize(extractMarkedBlock(docsSource, "docs/ops/updating.md"));

  const templateSource = readRepoFile("scripts/release/release-notes-template.md");
  const templateBlock = normalize(extractMarkedBlock(templateSource, "scripts/release/release-notes-template.md"));

  const generatedSource = readRepoFile("packages/shared/src/update-public-key.ts");
  const generatedMatch = generatedSource.match(/LOOMBRE_UPDATE_PUBLIC_KEY_TEXT = "([\s\S]*?)";\n?$/);
  if (!generatedMatch || generatedMatch[1] === undefined) {
    throw new Error("packages/shared/src/update-public-key.ts: could not find the LOOMBRE_UPDATE_PUBLIC_KEY_TEXT export");
  }
  const generatedKey = normalize(JSON.parse(`"${generatedMatch[1]}"`));

  const locations = [
    { label: "keys/minisign.pub", value: keysFile },
    { label: "docs/ops/updating.md", value: docsBlock },
    { label: "scripts/release/release-notes-template.md", value: templateBlock },
    { label: "packages/shared/src/update-public-key.ts (generated — run `pnpm embed-public-key`)", value: generatedKey },
  ];

  const reference = locations[0];
  const mismatches = locations.slice(1).filter((loc) => loc.value !== reference.value);

  if (mismatches.length > 0) {
    console.error(`check-pubkey-consistency: FAIL — ${mismatches.length} location(s) disagree with keys/minisign.pub\n`);
    for (const loc of mismatches) {
      console.error(`--- ${loc.label} ---`);
      console.error(loc.value);
      console.error("");
    }
    console.error(`--- keys/minisign.pub (reference) ---`);
    console.error(reference.value);
    process.exit(1);
  }

  console.log(`check-pubkey-consistency: PASS — all ${locations.length} locations agree`);
}

main();
