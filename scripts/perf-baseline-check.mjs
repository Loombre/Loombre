#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/perf-baseline-check.mjs
//
// Deliverable F (STATE.md P2.6 task spec): "Baselines with
// update-requires-reason" — perf/baselines.json is a hand-curated ledger of
// every enforced perf budget + its last-measured value (see that file's own
// "$rule" header). This script is the CI-enforced half of that rule: if
// perf/baselines.json differs from the version on `main` at all, EVERY
// entry (matched by `id`) whose value actually changed must ALSO have a
// changed `reason` string in the same diff — otherwise it fails. This makes
// "quietly loosen a budget" or "quietly baseline away a regression" a
// concrete, blocked action: you can't touch a number here without writing
// down why.
//
// Run via `pnpm perf:baseline-check` (wired into CI's perf-t0 job — see
// .github/workflows/ci.yml). Not part of `pnpm gate`: that step list is a
// CLAUDE.md-documented contract owned by a different concurrent work
// stream; this is genuinely a perf-lane concern.
//
// Comparison base: `git show main:perf/baselines.json`. If that fails
// (file doesn't exist on main yet — e.g. this IS the PR introducing it),
// there is nothing to diff against: PASS with a note, same posture as
// scripts/gate.mjs's own oasdiff step for an absent baseline.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CURRENT_PATH = path.join(REPO_ROOT, "perf/baselines.json");
const REL_PATH = "perf/baselines.json";

function log(...args) {
  console.log("[perf-baseline-check]", ...args);
}

function loadBaselineFromMain() {
  const result = spawnSync("git", ["show", `main:${REL_PATH}`], { encoding: "utf8" });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`main's ${REL_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadCurrentBaseline() {
  if (!existsSync(CURRENT_PATH)) {
    throw new Error(`${REL_PATH} is missing from the working tree`);
  }
  return JSON.parse(readFileSync(CURRENT_PATH, "utf8"));
}

function indexById(doc) {
  const map = new Map();
  for (const entry of doc?.budgets ?? []) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) {
      throw new Error(`a perf/baselines.json entry is missing a string "id": ${JSON.stringify(entry)}`);
    }
    if (map.has(entry.id)) {
      throw new Error(`perf/baselines.json has a duplicate id: "${entry.id}"`);
    }
    map.set(entry.id, entry);
  }
  return map;
}

/** Deep-equal on plain JSON values (objects/arrays/primitives) — no cycles,
 *  no functions, exactly what JSON.parse ever produces. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(a[k], b[k]));
}

function validateSchema(doc) {
  for (const entry of doc?.budgets ?? []) {
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
      throw new Error(`entry "${entry.id}" is missing a substantive "reason" string`);
    }
  }
}

function main() {
  const current = loadCurrentBaseline();
  validateSchema(current);

  const previous = loadBaselineFromMain();
  if (previous === null) {
    log(`no ${REL_PATH} on main — nothing to diff against. PASS.`);
    return;
  }

  const currentById = indexById(current);
  const previousById = indexById(previous);

  const violations = [];
  for (const [id, currentEntry] of currentById) {
    const previousEntry = previousById.get(id);
    if (!previousEntry) continue; // brand-new entry — nothing to compare "reason" against

    const { reason: currentReason, ...currentRest } = currentEntry;
    const { reason: previousReason, ...previousRest } = previousEntry;

    const nonReasonChanged = !deepEqual(currentRest, previousRest);
    const reasonChanged = currentReason !== previousReason;

    if (nonReasonChanged && !reasonChanged) {
      violations.push(
        `"${id}": budget/measurement fields changed vs main but "reason" did not — ` +
          `update the reason string to explain why.`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(`\n[perf-baseline-check] FAILED — ${REL_PATH} changed without an updated reason:\n`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      `\nSee ${REL_PATH}'s own "$rule" header, and docs/developer-guide/architecture/performance-budgets.md.`,
    );
    process.exit(1);
  }

  log(`PASS — every changed entry in ${REL_PATH} carries an updated reason.`);
}

main();
