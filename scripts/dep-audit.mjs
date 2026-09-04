#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/dep-audit.mjs
//
// Phase 4 lane G1 deliverable 6 (STATE.md P4.15 audit gate): runs
// `pnpm audit --prod --json` (production dependency graph ONLY — matches
// what actually ships; devDependency-only advisories, e.g. transitive
// findings inside @redocly/cli's OpenTelemetry deps or stylelint's
// js-yaml, are reported separately as non-blocking noise, same posture as
// LICENSE-INTENT.md's "tooling exclusions" precedent) and fails on any
// high/critical-severity advisory UNLESS it has a live (non-expired) entry
// in audit-allowlist.json.
//
// audit-allowlist.json shape:
//   { "entries": [ { "advisoryId": "GHSA-...", "reason": "...", "expires": "YYYY-MM-DD" } ] }
// Every field is required. `advisoryId` matches the advisory's
// `github_advisory_id` (pnpm audit's JSON — the stable GHSA identifier,
// not pnpm's own internal numeric `id`, which can differ across registry
// mirrors/rebuilds). An entry whose `expires` date has passed is treated
// as ABSENT — the advisory blocks the gate again, forcing a deliberate
// re-review rather than a silent forever-allowlist.
//
// Usage:
//   node scripts/dep-audit.mjs              # runs the real `pnpm audit`
//   DEP_AUDIT_INPUT_JSON=<path> node scripts/dep-audit.mjs   # test/offline seam:
//     reads pre-captured audit JSON from a file instead of shelling out —
//     used by dep-audit.test.mjs to exercise the classification logic
//     deterministically without hitting the real npm registry.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_ALLOWLIST_PATH = path.join(REPO_ROOT, "audit-allowlist.json");

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/** @typedef {{ advisoryId: string, reason: string, expires: string }} AllowlistEntry */

/** Parses+validates audit-allowlist.json's shape. Throws a clear error for
 *  any malformed entry (missing field, bad date) rather than silently
 *  treating it as absent — a broken allowlist entry must be visibly wrong,
 *  never silently permissive. */
export function loadAllowlist(jsonText, sourcePath = DEFAULT_ALLOWLIST_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`dep-audit: ${sourcePath} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(`dep-audit: ${sourcePath} must be an object with an "entries" array.`);
  }
  /** @type {AllowlistEntry[]} */
  const entries = [];
  for (const [i, raw] of parsed.entries.entries()) {
    const where = `${sourcePath} entries[${i}]`;
    if (!raw || typeof raw !== "object") throw new Error(`dep-audit: ${where} must be an object.`);
    for (const field of ["advisoryId", "reason", "expires"]) {
      if (typeof raw[field] !== "string" || raw[field].trim().length === 0) {
        throw new Error(`dep-audit: ${where} is missing required non-empty string field "${field}".`);
      }
    }
    if (Number.isNaN(Date.parse(raw.expires))) {
      throw new Error(`dep-audit: ${where}.expires ("${raw.expires}") is not a valid date (use YYYY-MM-DD).`);
    }
    entries.push({ advisoryId: raw.advisoryId, reason: raw.reason, expires: raw.expires });
  }
  return entries;
}

/** @returns {{ id: string, title: string, moduleName: string, severity: string, url: string }[]} */
export function parseAdvisories(auditJsonText) {
  let parsed;
  try {
    parsed = JSON.parse(auditJsonText);
  } catch (err) {
    throw new Error(`dep-audit: could not parse \`pnpm audit\` output as JSON: ${err.message}`);
  }
  // `pnpm audit --json` reports its OWN failure to reach the registry as an
  // error object instead of a report — e.g. {"error":{"code":23,"message":
  // "The operation was aborted due to timeout"}} when npm's audit endpoint
  // times out. Name that cause: it is a registry/network failure, not a
  // finding about the tree and not a code defect — but it still fails the
  // gate, because an unverified tree must never read as clean.
  const pnpmError = parsed?.error;
  if (pnpmError && typeof pnpmError === "object") {
    const code = pnpmError.code !== undefined ? `code ${pnpmError.code}` : "unknown code";
    const message = typeof pnpmError.message === "string" ? pnpmError.message : JSON.stringify(pnpmError);
    throw new Error(
      `dep-audit: \`pnpm audit\` reported an error instead of an audit report — ${code}: ${message}. ` +
        "This is a registry/network failure (npm's audit endpoint), not a finding about the dependency tree; " +
        "the gate still fails because an unverified tree must never read as clean. Retry when the endpoint answers.",
    );
  }
  const advisories = parsed?.advisories;
  if (advisories === undefined || typeof advisories !== "object") {
    throw new Error("dep-audit: audit JSON has no \"advisories\" object — unexpected pnpm audit output shape.");
  }
  return Object.values(advisories).map((a) => ({
    id: a.github_advisory_id ?? String(a.id),
    title: a.title,
    moduleName: a.module_name,
    severity: a.severity,
    url: a.url,
  }));
}

/**
 * @param {{ id: string, title: string, moduleName: string, severity: string, url: string }[]} advisories
 * @param {AllowlistEntry[]} allowlist
 * @param {number} nowMs
 */
export function classifyAdvisories(advisories, allowlist, nowMs) {
  const byId = new Map(allowlist.map((e) => [e.advisoryId, e]));
  const blocking = [];
  const allowlisted = [];
  const expired = [];
  const nonBlocking = [];

  for (const advisory of advisories) {
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) {
      // Wrapped, not bare: main()'s reporter destructures `{ advisory }` from
      // EVERY bucket, so a bare push here made `advisory` undefined and threw
      // mid-report — turning any merely-moderate advisory into a crashed gate
      // step instead of an informational line.
      nonBlocking.push({ advisory, entry: byId.get(advisory.id) ?? null });
      continue;
    }
    const entry = byId.get(advisory.id);
    if (!entry) {
      blocking.push({ advisory, entry: null });
      continue;
    }
    const expiresAtMs = Date.parse(`${entry.expires}T00:00:00Z`) + 24 * 60 * 60 * 1000; // end of the expires day, UTC
    if (nowMs >= expiresAtMs) {
      expired.push({ advisory, entry });
      blocking.push({ advisory, entry });
    } else {
      allowlisted.push({ advisory, entry });
    }
  }

  return { blocking, allowlisted, expired, nonBlocking };
}

function runPnpmAudit() {
  const WIN = process.platform === "win32";
  const result = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: WIN,
  });
  if (result.error) {
    throw new Error(`dep-audit: failed to spawn \`pnpm audit\`: ${result.error.message}`);
  }
  // pnpm audit exits 0 (clean) or a nonzero status (vulnerabilities found,
  // or a real failure) — the JSON body is what actually distinguishes
  // "found issues" from "the command itself broke" (no registry
  // connectivity, malformed lockfile, ...): a genuine failure to run
  // produces NO valid advisories/metadata JSON at all, which parseAdvisories
  // above already turns into a thrown, gate-failing error rather than a
  // silently-passing empty result.
  if (result.stdout.trim().length === 0) {
    const stderr = result.stderr?.trim() ?? "";
    throw new Error(`dep-audit: \`pnpm audit --prod --json\` produced no output (exit ${result.status}).${stderr ? ` stderr: ${stderr}` : ""}`);
  }
  return result.stdout;
}

async function main() {
  const auditJsonText = process.env.DEP_AUDIT_INPUT_JSON
    ? readFileSync(process.env.DEP_AUDIT_INPUT_JSON, "utf8")
    : runPnpmAudit();

  const allowlistPath = process.env.DEP_AUDIT_ALLOWLIST_PATH ?? DEFAULT_ALLOWLIST_PATH;
  const allowlist = loadAllowlist(readFileSync(allowlistPath, "utf8"), allowlistPath);

  const advisories = parseAdvisories(auditJsonText);
  const { blocking, allowlisted, expired, nonBlocking } = classifyAdvisories(advisories, allowlist, Date.now());

  console.log(`dep-audit: ${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} found (--prod scope).`);

  for (const { advisory } of nonBlocking) {
    console.log(`  [info] ${advisory.severity.toUpperCase()} is below the blocking threshold: ${advisory.id} (${advisory.moduleName}) — ${advisory.title}`);
  }
  for (const { advisory, entry } of allowlisted) {
    console.log(`  [allowlisted, expires ${entry.expires}] ${advisory.severity.toUpperCase()} ${advisory.id} (${advisory.moduleName}): ${entry.reason}`);
  }
  for (const { advisory, entry } of expired) {
    console.error(`  [EXPIRED ${entry.expires}] ${advisory.severity.toUpperCase()} ${advisory.id} (${advisory.moduleName}) — allowlist entry expired, re-review required: ${entry.reason}`);
  }
  for (const { advisory, entry } of blocking) {
    if (entry) continue; // already reported above under "expired"
    console.error(`  [BLOCKING] ${advisory.severity.toUpperCase()} ${advisory.id} (${advisory.moduleName}): ${advisory.title}\n    ${advisory.url}\n    Fix by upgrading ${advisory.moduleName}, or add a dated audit-allowlist.json entry with an honest reason.`);
  }

  if (blocking.length > 0) {
    console.error(`\ndep-audit: FAIL — ${blocking.length} unallowlisted (or expired-allowlist) high/critical advisor${blocking.length === 1 ? "y" : "ies"}.`);
    process.exitCode = 1;
    return;
  }

  console.log("dep-audit: PASS — no unallowlisted high/critical advisories.");
}

// Only run when executed directly (`node scripts/dep-audit.mjs`) — NOT
// when imported as a module (dep-audit.test.mjs imports the pure functions
// above), matching scripts/fetch-embedded-pg.mjs's own established
// isDirectEntrypoint convention. Importing this file must never have the
// side effect of shelling out to the real `pnpm audit` or touching the
// real allowlist file.
const isDirectEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
