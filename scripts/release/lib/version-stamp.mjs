// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/release/lib/version-stamp.mjs
//
// Pure drift-detection for the GENERATED file
// packages/shared/src/version.ts (STATE.md P4.11 single-source version
// stamping). Companion to derive-version.mjs: that module RENDERS the
// stamp from root package.json's `version`; this one READS a rendered
// stamp back and answers one question — "is this file still what
// `pnpm stamp-version` would produce from the version field that is
// authoritative today?"
//
// Why this exists (QA report browser-admin-F8): version.ts is a committed
// generated file, and nothing re-stamped it across seven release-candidate
// bumps. Root package.json said 0.9.0-rc.7 while the stamp still said
// 0.9.0, so the THREE independent read paths disagreed on screen at once —
// the web sidebar (root package.json → apps/web/src/lib/app-version.ts),
// the admin header + Server-info card + /settings/about (GET /system/info →
// LOOMBRE_VERSION_FULL), and the Updates card (GET /system/update →
// LOOMBRE_VERSION, which also feeds perform-check.ts's compareSemver, so a
// stale base version can flip `updateAvailable`). Only .github/workflows/
// release.yml ever re-stamped (--release, per build job), so release
// artifacts self-healed while the committed tree and every dev build went
// silently stale. `sdk-drift` protects packages/sdk from exactly this
// failure mode; nothing protected version.ts.
//
// WHAT IS CHECKED
//   1. base drift — LOOMBRE_VERSION must equal root package.json's
//      `version`, byte for byte. This IS the defect, and the only check
//      that can fail because a human bumped the version.
//   2. internal consistency — LOOMBRE_VERSION_FULL / LOOMBRE_GIT_SHORTHASH
//      must be exactly what deriveVersion() produces from the file's own
//      LOOMBRE_VERSION + LOOMBRE_BUILD_MODE. Catches a hand-edited stamp
//      (the file's banner says "do not edit") and a release-mode stamp
//      that kept a dev suffix or a short-hash.
//
// WHAT IS DELIBERATELY *NOT* CHECKED
//   - Short-hash freshness. A dev stamp bakes in the HEAD short-hash at
//     stamp time, so the committed value necessarily names the commit
//     BEFORE the one that carries it, and every subsequent commit moves
//     HEAD again. Gating on that would fail the gate on literally every
//     commit and force a re-stamp+amend loop. The short-hash is build
//     provenance; the BASE VERSION is the thing three UI surfaces render
//     and compareSemver reasons about.
//   - Which build mode is committed. dev is the committed norm; release.yml
//     re-stamps --release into a throwaway checkout per build job. Either
//     mode passes as long as it is internally consistent.
//
// Pure + dependency-free on purpose (same contract as derive-version.mjs
// and pubkey-consistency.mjs): all fs/CLI work lives in
// scripts/release/stamp-version.mjs's --check mode, and
// scripts/release/test/version-stamp.test.mjs exercises this module with
// in-memory fixtures plus one case that reads the REAL repo files.

import { assertValidSemver, deriveVersion, BUILD_MODES } from "./derive-version.mjs";

/** What a human must do when this check fails — quoted verbatim by the CLI. */
export const OWNER_ACTION =
  "run `pnpm stamp-version` and commit the regenerated packages/shared/src/version.ts";

/** Repo-relative path of the generated file, used in every message. */
export const STAMP_PATH = "packages/shared/src/version.ts";

/** Repo-relative path of the authoritative version source. */
export const SOURCE_PATH = "package.json";

const STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"`;
const VERSION_RE = new RegExp(String.raw`^export const LOOMBRE_VERSION = (${STRING_LITERAL});$`, "m");
const BUILD_MODE_RE = new RegExp(
  String.raw`^export const LOOMBRE_BUILD_MODE: "dev" \| "release" = (${STRING_LITERAL});$`,
  "m",
);
const SHORTHASH_RE = new RegExp(
  String.raw`^export const LOOMBRE_GIT_SHORTHASH: string \| null = (null|${STRING_LITERAL});$`,
  "m",
);
const VERSION_FULL_RE = new RegExp(
  String.raw`^export const LOOMBRE_VERSION_FULL = (${STRING_LITERAL});$`,
  "m",
);

function matchLiteral(source, pattern, constantName) {
  const match = pattern.exec(source);
  if (match === null) {
    throw new Error(
      `${STAMP_PATH}: no \`export const ${constantName} = …\` line in the expected generated shape — ` +
        `the file was hand-edited or renderVersionFileSource() changed without this checker; ${OWNER_ACTION}.`,
    );
  }
  return match[1] === "null" ? null : JSON.parse(match[1]);
}

/**
 * Reads the four constants back out of a rendered version.ts.
 *
 * @param {string} source
 * @returns {{ version: string, buildMode: "dev" | "release", gitShortHash: string | null, versionFull: string }}
 * @throws {Error} when the file is missing a constant or holds a bad build mode
 */
export function parseVersionStamp(source) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error(`${STAMP_PATH}: missing or empty — ${OWNER_ACTION}.`);
  }
  const version = matchLiteral(source, VERSION_RE, "LOOMBRE_VERSION");
  const buildMode = matchLiteral(source, BUILD_MODE_RE, "LOOMBRE_BUILD_MODE");
  const gitShortHash = matchLiteral(source, SHORTHASH_RE, "LOOMBRE_GIT_SHORTHASH");
  const versionFull = matchLiteral(source, VERSION_FULL_RE, "LOOMBRE_VERSION_FULL");

  if (!BUILD_MODES.includes(buildMode)) {
    throw new Error(
      `${STAMP_PATH}: LOOMBRE_BUILD_MODE is ${JSON.stringify(buildMode)} (expected "dev" or "release"); ${OWNER_ACTION}.`,
    );
  }

  return { version, buildMode, gitShortHash, versionFull };
}

/**
 * @param {{ baseVersion: unknown, stampSource: unknown }} input
 *   baseVersion  — root package.json's `version` field
 *   stampSource  — the current text of packages/shared/src/version.ts
 * @returns {{ ok: boolean, problems: Array<{ type: "structural" | "drift" | "inconsistent", message: string }>, stamp: object | null }}
 */
export function checkVersionStampDrift({ baseVersion, stampSource }) {
  /** @type {Array<{ type: "structural" | "drift" | "inconsistent", message: string }>} */
  const problems = [];

  let expectedVersion = null;
  try {
    if (typeof baseVersion !== "string") {
      throw new Error(`${SOURCE_PATH}: has no string "version" field`);
    }
    expectedVersion = assertValidSemver(baseVersion);
  } catch (err) {
    problems.push({ type: "structural", message: `${SOURCE_PATH}: ${err.message}` });
  }

  let stamp = null;
  try {
    stamp = parseVersionStamp(stampSource);
  } catch (err) {
    problems.push({ type: "structural", message: err.message });
  }

  if (stamp === null || expectedVersion === null) {
    return { ok: problems.length === 0, problems, stamp };
  }

  if (stamp.version !== expectedVersion) {
    problems.push({
      type: "drift",
      message:
        `${STAMP_PATH} is STALE: LOOMBRE_VERSION is ${JSON.stringify(stamp.version)} but ` +
        `${SOURCE_PATH}'s "version" is ${JSON.stringify(expectedVersion)}. The generated stamp ` +
        `feeds GET /system/info, GET /system/update and \`loombre --version\`, so admin surfaces ` +
        `disagree with the web shell until it is re-stamped — ${OWNER_ACTION}.`,
    });
  }

  // Internal consistency is judged against the file's OWN version+mode, so a
  // base-version drift reports as exactly one problem rather than cascading.
  const expected = deriveVersion({
    baseVersion: stamp.version,
    mode: stamp.buildMode,
    gitShortHash: stamp.gitShortHash,
  });

  if (stamp.gitShortHash !== expected.gitShortHash) {
    problems.push({
      type: "inconsistent",
      message:
        `${STAMP_PATH}: LOOMBRE_GIT_SHORTHASH ${JSON.stringify(stamp.gitShortHash)} is not valid for a ` +
        `${stamp.buildMode} stamp (expected ${JSON.stringify(expected.gitShortHash)}) — ${OWNER_ACTION}.`,
    });
  }

  if (stamp.versionFull !== expected.versionFull) {
    problems.push({
      type: "inconsistent",
      message:
        `${STAMP_PATH}: LOOMBRE_VERSION_FULL is ${JSON.stringify(stamp.versionFull)} but ` +
        `LOOMBRE_VERSION ${JSON.stringify(stamp.version)} + LOOMBRE_BUILD_MODE ${JSON.stringify(stamp.buildMode)} ` +
        `derive ${JSON.stringify(expected.versionFull)} — ${OWNER_ACTION}.`,
    });
  }

  return { ok: problems.length === 0, problems, stamp };
}
