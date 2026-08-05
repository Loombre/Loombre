#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CI naming + telemetry ban gate (CLAUDE.md invariants 7, plus product rule
 * "no an upstream media server/an upstream media server API surface, schema, or naming anywhere").
 *
 * (a) Forbids "upstream-media-server"/"upstream-media-server" (case-insensitive) and the whole word "Ticks"
 *     (case-sensitive — an upstream media server/an upstream media server's tick-based timestamp naming) inside
 *     apps/, packages/, and examples/ (the whole shipped product + dev kit —
 *     the design docs docs/PLAN.md/PLAYBACK.md are excluded because they name
 *     the competition on purpose; STATE.md/reports carry review history).
 * (b) Forbids telemetry/analytics SDK import patterns anywhere in the repo's
 *     source files (D14 — no telemetry, ever).
 * (c) Forbids UPnP/NAT-PMP/PCP library import patterns anywhere in the
 *     repo's source files (STATE.md "Loombre Remote", RG14 — "no UPnP
 *     anywhere" is a hard line across all three remote-access paths).
 *
 * Exits non-zero and prints `file:line: reason` for every hit.
 */
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".claude",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  ".pgdata",
  // Phase 4 installer-lane build caches (gitignored; contain vendored
  // third-party trees — e.g. Node's own README mentions telemetry vendors,
  // which is upstream prose, not Loombre source). CI checkouts never contain
  // these; excluding them keeps local gate runs == CI gate runs.
  ".build",
  ".build-cache",
  ".buildx-cache",
  "vendor",
  // reports/ holds review/evidence artifacts that can legitimately NAME
  // the banned telemetry SDKs and product terms while documenting the bans
  // themselves (a review report quoting the grep-gate's own pattern list
  // would otherwise trip the gate — happened in Phase 4 Wave 3). These are
  // analysis artifacts, gitignored + force-added deliberately, NEVER
  // shipped code — the telemetry/naming ban is about SOURCE IMPORTS, not
  // prose that discusses them.
  "reports",
]);

const EXCLUDED_FILES = new Set([
  "docs/PLAN.md",
  "docs/PLAYBACK.md",
  "scripts/grep-gates.mjs",
]);

const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".sql",
  ".html",
  ".css",
]);

// ---------------------------------------------------------------------------
// R8 rename gate (2026-07-24 hard-cut rename): the FORMER project name is
// FORBIDDEN repo-wide, permanently. The pattern is assembled from parts so
// this gate file itself never contains it. It matches as a case-insensitive
// SUBSTRING — strictly stronger than the letter-boundary minimum the rename
// decision locked, because the old tree held ~254 letter-adjacent CamelCase
// compounds (…ServiceHost, …IPCKit) a boundary regex would miss, and the new
// name does not contain the old one, so substring matching has zero false
// positives from living code. There is NO code allowlist — the hard cut means
// no code needs one. The allowlist is history-only, each entry with a reason:
//   - CHANGELOG.md   — the rename entry records the former name exactly once
//   - STATE.md       — immutable dated project history (pre-rename prose)
//   - reports/**     — immutable dated review/smoke artifacts (covered by the
//                      shared EXCLUDED_DIR_NAMES entry for reports/ above)
//   - git history    — unscanned by nature
// Unlike the naming/telemetry scans, this pass walks EVERY file regardless of
// extension (Swift, C#, WiX, plists, service templates, shell shims, …) and
// does NOT honor EXCLUDED_FILES (docs/PLAN.md + PLAYBACK.md are in scope).
const FORMER_NAME_PATTERN = new RegExp(["lu", "mb", "re"].join(""), "i");
const RENAME_GATE_ALLOWLIST = new Set(["CHANGELOG.md", "STATE.md"]);

/** @type {{code: string, pattern: RegExp}[]} */
const NAMING_PATTERNS = [
  // "upstream-media-server" is bounded on both sides so ordinary identifiers that merely
  // contain the letter run (getItemById → "...temBy..." case-insensitively)
  // don't false-positive; real product naming ("upstream-media-server", "upstream-media-server-api", "an upstream media server.X")
  // still hits.
  { code: "upstream-media-server-or-upstream-media-server", pattern: /upstream-media-server|(?<![a-z0-9])upstream-media-server(?![a-z0-9])/i },
  { code: "ticks-naming", pattern: /\bTicks\b/ },
];

const NAMING_SCOPE_PREFIXES = ["apps/", "packages/", "examples/"];

const TELEMETRY_PATTERNS = [
  "@sentry/",
  "posthog",
  "@segment/",
  "analytics-node",
  "mixpanel",
  "@amplitude/",
  "applicationinsights",
  "@bugsnag/",
  "datadog",
  "newrelic",
  "@google-analytics/",
].map((needle) => ({ code: `telemetry:${needle}`, pattern: new RegExp(escapeRegExp(needle)) }));

// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG14, lane WG1 — first network lane,
// assigned to wire this): "no UPnP anywhere" is a HARD LINE across all
// three remote-access paths (R9/the mission brief's "wizard detects,
// instructs, verifies — NEVER auto-configures the network"), stated as a
// FEATURE in docs, not just an omission. These are specific package/
// protocol NAME strings (import/require targets), never the bare word
// "UPnP" itself — so this repo's own docs/code explaining WHY there is no
// UPnP support (this file included) never trips it.
const UPNP_PATTERNS = ["nat-upnp", "node-upnp", "natupnp", "nat-api", "ssdp"].map((needle) => ({
  code: `no-upnp:${needle}`,
  pattern: new RegExp(escapeRegExp(needle), "i"),
}));

// History-only allowlist (same "immutable dated project history" reasoning
// as RENAME_GATE_ALLOWLIST's own STATE.md entry above): STATE.md's RG14
// decision record quotes these exact strings as the pattern group being
// added — that IS the historical record of this gate's own creation, not
// a live import.
//
// GUARD-TEST allowlisting (WG2, found by this lane's own first FULL
// `pnpm gate` run against the combined tree — RG14's own text anticipated
// this exact gap: "flagged for whichever lane first adds real WG/network/
// QR code; do not let it slip past that lane"): router-cards.test.ts
// (lane D1) asserts card copy NEVER names NAT-PMP/PCP/SSDP
// (`expect(text).not.toMatch(/NAT-PMP|natpmp|\bPCP\b|SSDP/i)`) — the
// literal string "SSDP" inside that NEGATIVE assertion regex trips the
// `ssdp` pattern the exact same way BRAND_HYGIENE_ALLOWLIST's own guard-
// test entries above already document for pulse-dot/fixture-string
// absence checks. Same posture, same fix: allowlist the GUARD file, never
// the pattern.
const UPNP_ALLOWLIST = new Set(["STATE.md", "packages/shared/test/remote/router-cards.test.ts"]);

// ---------------------------------------------------------------------------
// BRAND-HYGIENE gate (STATE.md D6/G9 — Blaze logo rollout Lane D purge):
// Legacy Loombre branding artifacts must not ship. Lanes A and B handle
// dot-animation replacement in parallel; Lane C handles spinner replacement.
// This gate verifies absence of old mark geometry, fixture strings, and
// legacy font CDN references. Pulse-dot extinction RED-first expectation:
// the guard files exist to assert their own absence, proving purge logic.
// (design/ escapes via SCAN_EXTENSIONS; .svg assets never scanned.)

const BRAND_HYGIENE_PATTERNS = [
  // Check 1: PULSE-DOT EXTINCTION — old sidebar/login dot class names and
  // their keyframe animations. Expected violations: the two test files
  // (Lanes A/C) contain regexes asserting absence, not the violations
  // themselves; on main after lanes A/B merge, these checks go green.
  { code: "brand:pulse-dot", pattern: /\b(wordmarkDot|sidebar-wordmark-pulse|brandDot|loombre-login-dot-pulse)\b/ },
  // Check 2: D6 FIXTURE STRINGS — never ship boot-splash fixture values
  // (version literals, mount paths, service names).
  { code: "brand:fixture-strings", pattern: /LOOMBRE CORE 0\.9\.2|V0\.9\.2|LIBRARY MOUNT|\/MNT\/MEDIA|STREAM ENGINE/ },
  // Check 3: GOOGLE FONTS CDN — must not fetch fonts at runtime.
  // Self-hosted woff2 in apps/web/public/fonts/ + local import via
  // apps/web/src/styles/fonts.css (U6 per Phosphor spec). Allowlist marks
  // provenance ledger, build-time fetcher comments, and CSP regression test.
  { code: "brand:google-fonts", pattern: /fonts\.googleapis\.com|fonts\.gstatic\.com/ },
  // Check 4: STRAY FLAME GEOMETRY — the Blaze mark's exact path-data
  // prefixes are permitted ONLY in the canonical geometry module.
  { code: "brand:stray-geometry", pattern: /M56 6 C50 12|M50 34 C47 40/ },
];

const BRAND_HYGIENE_SCOPE = "apps/";
const BRAND_HYGIENE_ALLOWLIST = new Map([
  // Check 1 allowlist: Guard test files that assert pulse-dot ABSENCE.
  // These files contain regexes matching the dot patterns; the regexes
  // themselves are in test assertions, never in shipped code.
  ["apps/web/src/components/shell/Sidebar.blaze-purge.test.ts",
   "Lane A guard: asserts sidebar pulse-dot animation is gone"],
  ["apps/web/src/components/ui/BlazeSpinner.purge.test.ts",
   "Lane C guard: asserts login dot animation is gone"],

  // Check 2 allowlist: Boot-splash fixture file (Lane B's negative test).
  // Contains the regexes that enforce absence; the file itself names them.
  ["apps/web/src/components/brand/BootSplash.fixtures.test.tsx",
   "Lane B guard: regexes that assert fixture strings are removed"],
  // G17 (STATE.md, orchestrator-adjudicated at W1 merge): H19 fidelity-audit
  // ledger comment quotes the dc prototype's fixture literal precisely to
  // document its OMISSION ("Both omitted, not fabricated") — prose evidence
  // in a frozen Phosphor artifact, not shipped UI; rewording would destroy
  // its evidentiary value. Blaze-run files reworded instead of allowlisted.
  ["apps/web/src/app/admin/page.tsx",
   "G17: H19 ledger comment quotes the dc fixture to document its omission"],

  // Check 3 allowlist: Fonts self-hosting infrastructure (U6, Phosphor spec).
  ["apps/web/public/fonts/PROVENANCE.md",
   "Ledger of self-hosted font sources (no CDN)"],
  ["apps/web/src/styles/fonts.css",
   "Build-time @import declarations + comments documenting local fetch"],
  ["apps/web/src/lib/csp.ts",
   "U6 guard documentation: comments explain why font-src is 'self'-only"],
  ["apps/web/src/lib/csp.test.ts",
   "U6 regression guard: verifies fonts.googleapis.com/fonts.gstatic.com NOT in CSP"],

  // Check 4 allowlist: Canonical Blaze path-data module (escaped via
  // SCAN_EXTENSIONS — .svg assets never scanned).
  ["apps/web/src/components/brand/blaze-paths.ts",
   "Canonical Blaze mark geometry — exact path-data prefixes live here only"],
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).split(sep).join("/");
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      walk(full, out);
      continue;
    }
    if (!st.isFile()) continue;
    const dotIdx = entry.lastIndexOf(".");
    const ext = dotIdx === -1 ? "" : entry.slice(dotIdx);
    if (!SCAN_EXTENSIONS.has(ext)) continue;
    if (EXCLUDED_FILES.has(rel)) continue;
    out.push({ full, rel });
  }
}

function walkAll(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).split(sep).join("/");
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      walkAll(full, out);
      continue;
    }
    if (!st.isFile()) continue;
    // In a git WORKTREE, .git is a FILE (`gitdir: <absolute parent path>`),
    // not a directory — EXCLUDED_DIR_NAMES never sees it, and the parent
    // path it contains is host-machine metadata, not repo content (it
    // false-positived the R8 scan for every worktree lane; found Phosphor
    // W1b). CI checkouts have a real .git directory, already excluded.
    if (entry === ".git") continue;
    if (RENAME_GATE_ALLOWLIST.has(rel)) continue;
    out.push({ full, rel });
  }
}

const files = [];
walk(ROOT, files);

const violations = [];

// R8 rename gate pass — every file, every line, no code allowlist.
{
  const allFiles = [];
  walkAll(ROOT, allFiles);
  for (const { full, rel } of allFiles) {
    // File NAMES are in scope too (the old name must not survive as a path).
    if (FORMER_NAME_PATTERN.test(rel)) {
      violations.push({ rel, lineNo: 0, code: "former-name:path", line: rel });
    }
    const content = readFileSync(full, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (FORMER_NAME_PATTERN.test(line)) {
        violations.push({
          rel,
          lineNo: idx + 1,
          code: "former-name",
          line: line.trim().slice(0, 200),
        });
      }
    });
  }
}

// Pre-release ban pass (N2 runtime policy, supported-latest sweep
// 2026-07-25: "no betas/RCs/pre-release versions anywhere in the
// dependency tree" — enforced, not asserted). Scans pnpm-lock.yaml's
// resolved package keys (the `  'name@version':` / `  name@version:`
// lines of the packages section) for -alpha/-beta/-rc/-next/-canary/
// -dev/-insiders/-experimental suffixes. Range SPECIFIERS elsewhere in
// the lockfile can legitimately mention pre-release bounds (e.g. a peer
// range `>=1.0.0-0`); only what actually RESOLVED matters.
{
  const lockLines = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split("\n");
  const RESOLVED_KEY = /^ {2}'?((?:@[^@'\s]+\/)?[^@'\s]+)@(\d+\.\d+\.\d+-[^'(:\s]+)/;
  const PRERELEASE_TAG = /-(alpha|beta|rc|next|canary|dev|insiders|experimental|pre)[.\d-]*/i;
  lockLines.forEach((line, idx) => {
    const m = RESOLVED_KEY.exec(line);
    if (m && PRERELEASE_TAG.test(`-${m[2].split("-").slice(1).join("-")}`)) {
      violations.push({
        rel: "pnpm-lock.yaml",
        lineNo: idx + 1,
        code: "prerelease-dependency",
        line: `${m[1]}@${m[2]}`,
      });
    }
  });
}

for (const { full, rel } of files) {
  const inNamingScope = NAMING_SCOPE_PREFIXES.some((p) => rel.startsWith(p));
  const inBrandHygieneScope = rel.startsWith(BRAND_HYGIENE_SCOPE);
  const isInBrandAllowlist = BRAND_HYGIENE_ALLOWLIST.has(rel);
  const content = readFileSync(full, "utf8");
  const lines = content.split("\n");

  lines.forEach((line, idx) => {
    if (inNamingScope) {
      for (const { code, pattern } of NAMING_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ rel, lineNo: idx + 1, code, line: line.trim() });
        }
      }
    }
    for (const { code, pattern } of TELEMETRY_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ rel, lineNo: idx + 1, code, line: line.trim() });
      }
    }
    if (!UPNP_ALLOWLIST.has(rel)) {
      for (const { code, pattern } of UPNP_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ rel, lineNo: idx + 1, code, line: line.trim() });
        }
      }
    }
    if (inBrandHygieneScope && !isInBrandAllowlist) {
      for (const { code, pattern } of BRAND_HYGIENE_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ rel, lineNo: idx + 1, code, line: line.trim() });
        }
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`grep-gates: FAIL (${violations.length} violation(s))\n`);
  for (const v of violations) {
    console.error(`${v.rel}:${v.lineNo}: [${v.code}] ${v.line}`);
  }
  process.exit(1);
}

console.log(`grep-gates: PASS (${files.length} files scanned, 0 violations)`);
process.exit(0);
