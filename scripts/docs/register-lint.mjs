#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs/register-lint.mjs
//
// Addendum A, lane D1 (STATE.md "## Addendum A", deliverable 9) —
// "AUDIENCE-REGISTER RULES" enforcement: each guide is written FOR its
// reader (docs/user-guide for someone with zero technical background,
// docs/admin-guide for someone who runs the household server but doesn't
// code, docs/ops + docs/install for a technical self-hoster, docs/developer-
// guide for a developer). This script is a best-effort, deliberately
// heuristic linter over those rules — not a formal grammar. It PRINTS
// WARNINGS and always exits 0: register slips are a review/editing concern,
// not something that should block a docs build the way a broken link or a
// build error does. Run as part of `pnpm docs:build` (scripts/docs/build.mjs).
//
// Scope note: docs/developer-guide carries the full technical register by
// design (AUDIENCE-REGISTER RULES) and docs/install + docs/ops are folded
// in as-is (P4.9-grade, register-audited already) — both are excluded from
// the per-guide banned-term checks below, but docs/ops still gets the
// source-code-reference check (operator guide rule: "no source-code
// references").

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { walkDocs } from "./lib/walk-md.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const DOCS_ROOT = join(REPO_ROOT, "docs");

/**
 * Strip HTML comments (the sourcing-citation convention — see the mission's
 * "SOURCING RULE") from a whole file's content BEFORE splitting into lines,
 * not line-by-line: this repo's sourcing comments are routinely multi-line
 * (`<!-- Sourcing: ...\n ... -->`), and a naive per-line regex only matches
 * a comment that opens and closes on the SAME line, leaving every interior
 * line of a multi-line comment unstripped — which produced real false
 * positives during development (e.g. a citation reading `docs/PLAYBACK.md
 * §7 "Bitrate ladder"` inside a comment tripping the user-guide banned-word
 * check, even though the word never appears in rendered output). Newlines
 * inside the stripped comment are preserved (replaced with blank lines) so
 * line numbers in warnings still point at the right place in the source file.
 */
function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, (match) => "\n".repeat((match.match(/\n/g) || []).length));
}

/** @typedef {{ rule: string, rel: string, lineNo: number, detail: string }} Warning */

/** @type {Warning[]} */
const warnings = [];

function warn(rule, rel, lineNo, detail) {
  warnings.push({ rule, rel, lineNo, detail });
}

// ---------------------------------------------------------------------------
// User guide (docs/user-guide/**): plain language, zero unexplained
// technical terms. Banned words verbatim per the mission brief; outcome
// language instead. No file paths, no terminal commands, no ports, no
// unexplained acronyms.
// ---------------------------------------------------------------------------

const USER_GUIDE_BANNED_WORDS = [
  "transcode",
  "transcoding",
  "transcoded",
  "codec",
  "bitrate",
  "hls",
  "container",
  "containerized",
];

// Common plain-language or brand tokens that happen to be all-caps/mixed-caps
// — not "unexplained acronyms" in the sense the rule means.
const USER_GUIDE_ACRONYM_ALLOWLIST = new Set([
  "PIN",
  "TV",
  "4K",
  "HD",
  "UHD",
  "ID",
  "OK",
  "DVD",
  "USB",
  "AM",
  "PM",
]);

function lintUserGuide(rel, lines) {
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    for (const word of USER_GUIDE_BANNED_WORDS) {
      const re = new RegExp(`\\b${word}\\b`, "i");
      if (re.test(line)) {
        warn("user-guide-banned-term", rel, lineNo, `banned technical word "${word}" — use outcome language instead`);
      }
    }

    if (/^\s*```/.test(line)) {
      warn("user-guide-code-fence", rel, lineNo, "code fence — user guide must carry no terminal commands");
    }

    if (/\b[\w-]+\/[\w./-]+\b/.test(line) && !/^https?:\/\//.test(line.trim())) {
      // Skip markdown links [text](path) targets and image refs — those are
      // navigation, not "a file path the reader is told to go look at".
      const withoutLinks = line.replace(/\]\([^)]*\)/g, "]");
      if (/\b[\w-]+\/[\w./-]+\b/.test(withoutLinks)) {
        warn("user-guide-path-like-token", rel, lineNo, "possible file path or repo-shaped token — user guide must carry none");
      }
    }

    if (/\bport\s*\d{2,5}\b/i.test(line) || /:\d{4,5}\b/.test(line)) {
      warn("user-guide-port", rel, lineNo, "possible port number — user guide must carry none");
    }

    for (const match of line.matchAll(/\b[A-Z]{2,6}\b/g)) {
      const token = match[0];
      if (USER_GUIDE_ACRONYM_ALLOWLIST.has(token)) continue;
      warn("user-guide-acronym", rel, lineNo, `possible unexplained acronym "${token}" — confirm a plain-word substitute exists`);
    }
  });
}

// ---------------------------------------------------------------------------
// Admin guide (docs/admin-guide/**): technical terms allowed only when the
// UI shows them (each explained in one plain sentence on first use — human
// judgment call, flagged as a reminder here, not auto-verified). No terminal
// commands, no code, no repo references — those are cross-links to the
// Operator Guide instead.
// ---------------------------------------------------------------------------

const ADMIN_GUIDE_TERMS_NEEDING_EXPLANATION = [
  "transcode",
  "codec",
  "bitrate",
  "container",
  "HLS",
  "JWT",
  "argon2id",
  "PIN",
  "capability",
];

const ADMIN_GUIDE_SHELL_WORDS = ["terminal", "command line", "shell", "ssh ", "sudo ", "docker exec", "npm install", "pnpm ", "git clone"];

function lintAdminGuide(rel, lines) {
  const seenTerm = new Set();
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    if (/^\s*```(bash|sh|shell|zsh|powershell|cmd|console)?\s*$/i.test(line) && /```(bash|sh|shell|zsh|powershell|cmd|console)/i.test(line)) {
      warn("admin-guide-terminal-fence", rel, lineNo, "shell code fence — admin guide must carry no terminal commands (cross-link to Operator Guide instead)");
    }

    for (const shellWord of ADMIN_GUIDE_SHELL_WORDS) {
      if (line.toLowerCase().includes(shellWord)) {
        warn("admin-guide-shell-reference", rel, lineNo, `shell/CLI reference ("${shellWord.trim()}") — cross-link to the Operator Guide instead`);
      }
    }

    if (/\b(apps|packages|scripts)\/[a-zA-Z0-9_-]+/.test(line)) {
      warn("admin-guide-repo-reference", rel, lineNo, "repo path reference — admin guide must carry no repo references");
    }

    for (const term of ADMIN_GUIDE_TERMS_NEEDING_EXPLANATION) {
      const re = new RegExp(`\\b${term}\\b`, "i");
      if (re.test(line)) {
        const key = term.toLowerCase();
        if (!seenTerm.has(key)) {
          seenTerm.add(key);
          warn("admin-guide-first-use-reminder", rel, lineNo, `first use of technical term "${term}" — confirm it's explained in one plain sentence here (only if the UI itself shows this term)`);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Operator guide (docs/ops/**): technical self-hoster register — but "no
// source-code references" still applies (that's a Developer Guide thing).
// ---------------------------------------------------------------------------

function lintOperatorGuide(rel, lines) {
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (/\b(apps|packages)\/[a-zA-Z0-9_-]+\/(src|test)\b/.test(line)) {
      warn("operator-guide-source-reference", rel, lineNo, "source-code path reference — operator guide must carry none (Developer Guide territory)");
    }
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const files = walkDocs(DOCS_ROOT);

for (const { full, rel } of files) {
  const content = readFileSync(full, "utf8");
  const lines = stripHtmlComments(content).split("\n");

  if (rel.startsWith("user-guide/")) {
    lintUserGuide(rel, lines);
  } else if (rel.startsWith("admin-guide/")) {
    lintAdminGuide(rel, lines);
  } else if (rel.startsWith("ops/")) {
    lintOperatorGuide(rel, lines);
  }
  // developer-guide/, install/, api-reference/, reference/, root index: no
  // per-guide banned-term rules (full technical register, or folded-as-is).
}

if (warnings.length === 0) {
  console.log(`register-lint: PASS — 0 warnings across ${files.length} page(s)`);
  process.exit(0);
}

console.log(`register-lint: ${warnings.length} warning(s) across ${files.length} page(s) (non-blocking)\n`);
for (const w of warnings) {
  console.log(`  docs/${w.rel}:${w.lineNo}  [${w.rule}]  ${w.detail}`);
}
console.log("\nregister-lint: warnings are informational only — docs build continues.");
process.exit(0);
