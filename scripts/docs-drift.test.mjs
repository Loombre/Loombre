// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs-drift.test.mjs
//
// Drift gate over the facts the contributor/ops docs RESTATE from source
// files (QA report d3-doc1 + d3-doc2). Three restatements have already gone
// stale in-tree, each for the same reason — the source moved and nothing
// mechanically checked the prose:
//
//   1. The `pnpm gate` step chain and its step COUNTS (CONTRIBUTING.md,
//      CLAUDE.md, docs/developer-guide/getting-started.md). `version-stamp`
//      was inserted after `sdk-drift` (scripts/gate.mjs) for QA report
//      browser-admin-F8 and every prose copy kept listing 15 steps without
//      it — gate.mjs's own header had to carry a "prose elsewhere may still
//      say 15 steps" disclaimer.
//   2. The shipped VERSION (README.md, docs/developer-guide/architecture/
//      packaging-release.md), which sat four release-candidate bumps behind
//      root package.json: `stamp-version --check` only compares
//      packages/shared/src/version.ts, so no gate ever looked at the docs.
//   3. The `GET /system/update` example payload (docs/ops/updating.md),
//      which showed `"currentVersion": "0.9.0-dev+<shorthash>"` — both a
//      dead short hash (history was scrubbed) and a SHAPE the contract says
//      that member never has (packages/contract/openapi.yaml,
//      SystemUpdateInfo.currentVersion: "a BARE semver ... which is why it
//      carries no build metadata").
//
// scripts/ is not a pnpm workspace, so `turbo run test` (the gate's `test`
// step) never reaches this file; CI runs it as `pnpm scripts:test`. Run it
// directly with:
//
//   node --test scripts/docs-drift.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** null when the file isn't in this checkout at all (see CLAUDE.md below). */
function readOptional(rel) {
  try {
    return read(rel);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Docs that spell out the ordered gate chain and/or its step counts.
 *
 * CLAUDE.md is `optional`: it is git-IGNORED (.gitignore `/CLAUDE.md`), so a
 * CI checkout does not contain it and this suite must not fail there — but
 * every developer tree does have it, and it restates the chain, so it is
 * checked wherever it exists. Same fails-where-it-can posture grep-gates
 * takes over ignored paths.
 */
const GATE_CHAIN_DOCS = [
  { file: "CONTRIBUTING.md" },
  { file: "CLAUDE.md", optional: true },
  { file: "docs/developer-guide/getting-started.md" },
];

/**
 * Docs that restate root package.json's `version`. Each pattern must
 * capture the version string itself, so the assertion names the exact
 * sentence that drifted rather than "somewhere in this file".
 */
const VERSION_RESTATEMENTS = [
  { file: "README.md", pattern: /version `([^`]+)`, pre-release/ },
  {
    file: "docs/developer-guide/architecture/packaging-release.md",
    pattern: /Version ([0-9][0-9A-Za-z.+-]*), no release published yet/,
  },
];

/** scripts/gate.mjs's own step list — the truth every doc restates. */
function gateSteps() {
  const src = read("scripts/gate.mjs");

  const fastBlock = /const steps = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(fastBlock, "scripts/gate.mjs: could not find the `const steps = [ ... ];` array");
  const fast = [...fastBlock[1].matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);

  const fullBlock = /if \(FULL\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(fullBlock, "scripts/gate.mjs: could not find the `if (FULL) { ... }` block");
  const fullExtra = [...fullBlock[1].matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);

  assert.ok(fast.length >= 2, "scripts/gate.mjs: parsed a suspiciously short fast-step list");
  assert.ok(fullExtra.length >= 1, "scripts/gate.mjs: parsed no full-mode step");
  return { fast, fullExtra, total: fast.length + fullExtra.length };
}

/**
 * The arrow-separated chain a doc spells out, from the first step name to
 * the last. Works for both the backticked (`codegen` → `sdk-drift`) and
 * bare (codegen → sdk-drift) styles, and across line wraps.
 */
function chainIn(text, firstStep, lastStep) {
  const start = text.indexOf(firstStep);
  if (start === -1) return null;
  const end = text.indexOf(lastStep, start);
  if (end === -1) return null;
  return text
    .slice(start, end + lastStep.length)
    .split("→")
    .map((token) => token.replace(/[\s`]+/g, ""))
    .filter(Boolean);
}

test("contributor docs list scripts/gate.mjs's real fast-step chain, in order", () => {
  const { fast } = gateSteps();
  for (const { file, optional } of GATE_CHAIN_DOCS) {
    const text = optional ? readOptional(file) : read(file);
    if (text === null) continue;
    const chain = chainIn(text, fast[0], fast[fast.length - 1]);
    assert.ok(chain, `${file}: no gate chain found (expected ${fast[0]} → … → ${fast.at(-1)})`);
    assert.deepEqual(chain, fast, `${file}: gate chain drifted from scripts/gate.mjs`);
  }
});

test("contributor docs state the real gate step counts (fast, and fast + full)", () => {
  const { fast, total } = gateSteps();
  for (const { file, optional } of GATE_CHAIN_DOCS) {
    const text = optional ? readOptional(file) : read(file);
    if (text === null) continue;

    for (const [match, n] of text.matchAll(/(\d+) steps\b/g)) {
      assert.equal(
        Number(n),
        fast.length,
        `${file}: "${match}" — scripts/gate.mjs's fast gate has ${fast.length} steps`,
      );
    }

    // "a 16th step" / "plus that 16th" / "+ a 16th" — the full-mode total.
    const ordinals = [
      ...text.matchAll(/(\d+)(?:st|nd|rd|th) step\b/g),
      ...text.matchAll(/steps? (?:plus|\+) (?:a |that )?(\d+)(?:st|nd|rd|th)/g),
    ];
    for (const [match, n] of ordinals) {
      assert.equal(
        Number(n),
        total,
        `${file}: "${match}" — gate:full runs ${total} steps in total`,
      );
    }
  }
});

test("docs that restate the shipped version agree with root package.json", () => {
  const { version } = JSON.parse(read("package.json"));
  for (const { file, pattern } of VERSION_RESTATEMENTS) {
    const found = pattern.exec(read(file));
    assert.ok(found, `${file}: no version restatement matched ${pattern} (did the sentence move?)`);
    assert.equal(found[1], version, `${file}: restated version drifted from root package.json`);
  }
});

test("docs/ops/updating.md's GET /system/update example matches the contract", () => {
  const text = read("docs/ops/updating.md");
  const example = /"currentVersion": "([^"]+)"/.exec(text);
  assert.ok(example, "docs/ops/updating.md: no GET /system/update example payload found");
  const currentVersion = example[1];

  // openapi.yaml, SystemUpdateInfo.currentVersion: "a BARE semver — the
  // string `latestVersion` is compared against, which is why it carries no
  // build metadata". A "-dev+<shorthash>" example is SystemInfo.version's
  // shape, not this member's.
  assert.ok(
    !currentVersion.includes("+"),
    `docs/ops/updating.md: currentVersion example "${currentVersion}" carries build metadata; ` +
      "the contract says this member is a bare semver",
  );

  // The example must also be internally consistent: updateAvailable is
  // compareSemver(latestVersion, currentVersion) > 0, so an example whose
  // two versions are equal cannot claim an update is available.
  const latest = /"latestVersion": ("[^"]+"|null)/.exec(text);
  const available = /"updateAvailable": (true|false)/.exec(text);
  assert.ok(latest && available, "docs/ops/updating.md: example payload is missing fields");
  if (latest[1] === `"${currentVersion}"`) {
    assert.equal(
      available[1],
      "false",
      "docs/ops/updating.md: example has latestVersion === currentVersion but claims an update",
    );
  }
});
