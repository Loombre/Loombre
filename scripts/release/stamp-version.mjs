#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/stamp-version.mjs
//
// STATE.md P4.11 single-source version stamping. Reads the root
// package.json `version` field (the ONE place a human edits a version
// number) and writes packages/shared/src/version.ts — the one import point
// every consumer (`/system/info`, the `loombre` CLI, the release manifest
// build script) reads instead of hardcoding or re-deriving anything.
//
// Usage:
//   node scripts/release/stamp-version.mjs            # dev mode (default)
//   node scripts/release/stamp-version.mjs --release   # release mode
//   node scripts/release/stamp-version.mjs --check     # verify, write nothing
//   pnpm stamp-version [--release|--check]
//
// --check (QA report browser-admin-F8) is the DRIFT GATE, wired into
// scripts/gate.mjs as the `version-stamp` step right after `sdk-drift` —
// the same class of check over a different generated file. It writes
// nothing and exits 1 when packages/shared/src/version.ts no longer
// matches root package.json's `version`. Without it, a version bump that
// forgets `pnpm stamp-version` goes unnoticed until an admin sees the
// sidebar, the admin header and the Updates card each reporting a
// different version (which is exactly what happened across seven rc
// bumps: only .github/workflows/release.yml ever re-stamped, so release
// artifacts self-healed while the committed tree stayed at 0.9.0).
// Short-hash freshness is deliberately NOT gated — see
// lib/version-stamp.mjs's header.
//
// Dev mode appends "-dev+<gitShortHash>" (git metadata is read here, at
// stamp time, NOT at runtime — packages/shared/src/version.ts stays a pure
// data file, see derive-version.mjs's header). Release mode — what
// .github/workflows/release.yml runs before every build-* job for a `v*`
// tag — writes the exact semver with no suffix.
//
// This script does zero git/network work when it doesn't need to: a
// missing git binary or a checkout with no .git directory (e.g. a
// downloaded source tarball) degrades to gitShortHash "unknown" in dev
// mode rather than failing the stamp.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveVersion, renderVersionFileSource } from "./lib/derive-version.mjs";
import { checkVersionStampDrift } from "./lib/version-stamp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const VERSION_FILE_OUT = path.join(REPO_ROOT, "packages/shared/src/version.ts");

function readBaseVersion() {
  const raw = readFileSync(ROOT_PACKAGE_JSON, "utf8");
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== "string") {
    throw new Error(`stamp-version: root package.json has no string "version" field`);
  }
  return pkg.version;
}

function readGitShortHash() {
  const result = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

const KNOWN_FLAGS = new Set(["--release", "--check"]);

/** --check: read-only drift gate (scripts/gate.mjs's `version-stamp` step). */
function runCheck() {
  const baseVersion = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8")).version;
  let stampSource;
  try {
    stampSource = readFileSync(VERSION_FILE_OUT, "utf8");
  } catch {
    stampSource = undefined;
  }

  const verdict = checkVersionStampDrift({ baseVersion, stampSource });
  if (!verdict.ok) {
    console.error(`stamp-version --check: FAIL — ${verdict.problems.length} problem(s) found\n`);
    for (const problem of verdict.problems) {
      console.error(`[${problem.type}] ${problem.message}`);
    }
    process.exit(1);
  }

  console.log(
    `stamp-version --check: PASS — ${path.relative(REPO_ROOT, VERSION_FILE_OUT)} matches package.json version ${verdict.stamp.version} (${verdict.stamp.buildMode})`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`stamp-version: unknown argument(s): ${unknown.join(", ")}`);
    console.error("usage: node scripts/release/stamp-version.mjs [--release|--check]");
    process.exit(1);
  }
  if (args.includes("--check")) {
    if (args.includes("--release")) {
      console.error("stamp-version: --check and --release are mutually exclusive");
      console.error("usage: node scripts/release/stamp-version.mjs [--release|--check]");
      process.exit(1);
    }
    runCheck();
    return;
  }
  const mode = args.includes("--release") ? "release" : "dev";

  const baseVersion = readBaseVersion();
  const gitShortHash = mode === "dev" ? readGitShortHash() : null;
  const derived = deriveVersion({ baseVersion, mode, gitShortHash });
  const source = renderVersionFileSource(derived);

  writeFileSync(VERSION_FILE_OUT, source);
  console.log(
    `stamp-version: wrote ${path.relative(REPO_ROOT, VERSION_FILE_OUT)} — ${derived.versionFull} (${derived.buildMode})`,
  );
}

main();
