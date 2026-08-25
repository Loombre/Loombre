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
//   4. The transcode-runtime knobs the SPEC owns (docs/PLAYBACK.md §9 and
//      §9.1.7 vs apps/worker/src/transcode/config.ts — d4-doc1). Two rules
//      shipped in dispatch 3 (d3-f3's bounded throttle suspend, d3-f5's
//      post-seek rung cool-down) changed what §9 promises while §9 still
//      described the throttle as suspend/resume-only and §9.1.4/§9.1.7 as
//      restart-on-pending-rung with no cool-down. Neither knob is a
//      settings-registry entry (deliberate — same class as
//      SEGMENT_RETENTION_SEC), so prose is the ONLY place an operator can
//      learn the value, which is exactly the kind of restatement that rots.
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
 * d4-i5 (QA backlog #118): scripts/gate.mjs's OWN header restates its step
 * counts too, and was the last copy in the tree still saying "15" — it even
 * carried a disclaimer that prose elsewhere might disagree. A file is not
 * exempt from a drift gate for being the source: the header is prose about
 * the array, and drifts from it exactly the way a doc does.
 */
const GATE_COUNT_SOURCES = [...GATE_CHAIN_DOCS, { file: "scripts/gate.mjs" }];

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

/**
 * d4-doc1 (QA backlog #108): the transcode-runtime knobs whose ONLY
 * operator-facing description is spec prose. Each entry names the spec
 * section that OWNS the rule, the `apps/worker/src/transcode/config.ts`
 * constant that is the truth, and the env var that overrides it; `action`
 * (optional) is the `throttle.ts` `ThrottleAction` member the section must
 * name, so a renamed action fails here instead of silently orphaning the
 * paragraph that describes it.
 */
const TRANSCODE_KNOB_DOCS = [
  {
    constant: "THROTTLE_MAX_SUSPEND_MS",
    env: "LOOMBRE_TRANSCODE_MAX_SUSPEND_MS",
    file: "docs/PLAYBACK.md",
    from: "## 9. Session execution layer",
    to: "### 9.1 Multi-variant delivery",
    action: "release-stopped-process",
  },
  {
    constant: "RUNG_SWITCH_SEEK_COOLDOWN_MS",
    env: "LOOMBRE_TRANSCODE_RUNG_SWITCH_COOLDOWN_MS",
    file: "docs/PLAYBACK.md",
    from: "#### 9.1.7",
    to: "#### 9.1.8",
  },
];

/** The shipped value of a `export const NAME = 1_234;` in the worker's
 *  transcode config — the truth docs/PLAYBACK.md restates. */
function workerConfigMs(constant) {
  const src = read("apps/worker/src/transcode/config.ts");
  const found = new RegExp(`export const ${constant} = ([0-9_]+);`).exec(src);
  assert.ok(found, `apps/worker/src/transcode/config.ts: no \`export const ${constant} = <number>;\``);
  return Number(found[1].replace(/_/g, ""));
}

/**
 * One spec section, whitespace-collapsed so a restatement matches whether or
 * not the 80-column wrap happens to fall inside it.
 */
function docSection(file, from, to) {
  const text = read(file);
  const start = text.indexOf(from);
  assert.ok(start !== -1, `${file}: section heading "${from}" not found`);
  const end = text.indexOf(to, start + 1);
  assert.ok(end > start, `${file}: section end heading "${to}" not found after "${from}"`);
  return text.slice(start, end).replace(/\s+/g, " ");
}

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

test("scripts/gate.mjs's own header lists its real step chain, fast then full", () => {
  const { fast, fullExtra } = gateSteps();
  const src = read("scripts/gate.mjs");

  // The header spells the chain with "->" (the docs use "→") and ends on
  // the full-mode step, tagged "[gate:full only]".
  const start = src.indexOf("codegen");
  const end = src.indexOf(fullExtra.at(-1), start);
  assert.ok(start !== -1 && end !== -1, "scripts/gate.mjs: no header step chain found");
  const chain = src
    .slice(start, end + fullExtra.at(-1).length)
    .split("->")
    .map((token) => token.replace(/\[[^\]]*\]/g, "").replace(/[\s*`]+/g, ""))
    .filter(Boolean);

  assert.deepEqual(
    chain,
    [...fast, ...fullExtra],
    "scripts/gate.mjs: the header's own chain drifted from the `steps` array below it",
  );
});

test("contributor docs state the real gate step counts (fast, and fast + full)", () => {
  const { fast, total } = gateSteps();
  for (const { file, optional } of GATE_COUNT_SOURCES) {
    const text = optional ? readOptional(file) : read(file);
    if (text === null) continue;

    // "16 steps", and the "15 fixed steps"/"those 15 steps" shapes
    // gate.mjs's header uses — every count claim spells the word `steps`
    // so ONE pattern pins them all (keep it that way when editing prose).
    for (const [match, n] of text.matchAll(/(\d+) (?:[a-z]+ )?steps\b/g)) {
      assert.equal(
        Number(n),
        fast.length,
        `${file}: "${match}" — scripts/gate.mjs's fast gate has ${fast.length} steps`,
      );
    }

    // "an 18th step" / "plus that 18th" / "+ an 18th" — the full-mode total.
    const ordinals = [
      ...text.matchAll(/(\d+)(?:st|nd|rd|th) step\b/g),
      ...text.matchAll(/steps? (?:plus|\+) (?:an? |that )?(\d+)(?:st|nd|rd|th)/g),
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

test("docs/PLAYBACK.md documents each transcode knob with the value config.ts ships", () => {
  for (const knob of TRANSCODE_KNOB_DOCS) {
    const section = docSection(knob.file, knob.from, knob.to);
    const ms = workerConfigMs(knob.constant);
    assert.equal(ms % 1000, 0, `apps/worker/src/transcode/config.ts: ${knob.constant} is not a whole number of seconds`);

    assert.ok(
      section.includes(knob.env),
      `${knob.file} "${knob.from}": does not name the env override ${knob.env}`,
    );

    const stated = new RegExp("`" + knob.constant + "` = (\\d+) s\\b").exec(section);
    assert.ok(
      stated,
      `${knob.file} "${knob.from}": no \`${knob.constant}\` = <n> s restatement — the rule this section owns is undocumented`,
    );
    assert.equal(
      Number(stated[1]),
      ms / 1000,
      `${knob.file} "${knob.from}": restated ${knob.constant} drifted from apps/worker/src/transcode/config.ts`,
    );

    if (knob.action) {
      const throttle = read("apps/worker/src/transcode/throttle.ts");
      assert.ok(
        throttle.includes(`kind: "${knob.action}"`),
        `apps/worker/src/transcode/throttle.ts: no ThrottleAction member "${knob.action}" (did the action move?)`,
      );
      assert.ok(
        section.includes(knob.action),
        `${knob.file} "${knob.from}": does not name the \`${knob.action}\` action it documents`,
      );
    }
  }
});

test("STATE.md records the transcode knobs, and they are still env-only constants", () => {
  const state = read("STATE.md");
  for (const { constant } of TRANSCODE_KNOB_DOCS) {
    assert.ok(state.includes(constant), `STATE.md: no decision record naming ${constant}`);
  }

  // What STATE.md records about BOTH knobs is "env constant in
  // apps/worker/src/transcode/config.ts by design, not a settings-registry
  // entry" (same class as SEGMENT_RETENTION_SEC). Promoting either to an
  // admin-configurable setting makes that sentence false, so the registry is
  // part of this assertion, not a separate concern.
  const registry = read("packages/shared/src/settings-registry.ts");
  assert.ok(
    !/maxSuspend|rungSwitchCooldown/i.test(registry),
    "packages/shared/src/settings-registry.ts: a transcode suspend-bound / rung-cool-down key now exists — " +
      "STATE.md still records both knobs as env-only constants",
  );
});
