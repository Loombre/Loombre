#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CI naming + telemetry ban gate (CLAUDE.md invariants 7, plus product rule
 * "no third-party media-server API surface, schema, or naming anywhere").
 *
 * (a) Forbids the two denylisted competitor product names (case-insensitive)
 *     and the whole word "Ticks" (case-sensitive — the tick-based timestamp
 *     naming of certain incumbent servers) inside apps/, packages/, and
 *     examples/ (the whole shipped product + dev kit — the design docs
 *     docs/PLAN.md/PLAYBACK.md are excluded because they discuss prior art;
 *     STATE.md/reports carry review history). The denylisted names are
 *     assembled from fragments below so the words themselves never appear as
 *     literal tracked text anywhere in this repo.
 * (b) Forbids telemetry/analytics SDK import patterns anywhere in the repo's
 *     source files (D14 — no telemetry, ever).
 * (c) Forbids UPnP/NAT-PMP/PCP library import patterns anywhere in the
 *     repo's source files (STATE.md "Loombre Remote", RG14 — "no UPnP
 *     anywhere" is a hard line across all three remote-access paths).
 * (d) Forbids a raw NUL byte in any scanned source file (d3-aq3): git's
 *     `text=auto` binary detection turns such a file into an opaque blob —
 *     no diff to review, no blame, invisible to `git grep` and to every
 *     grep gate here, including (a)–(c).
 * (e) Forbids reading user-facing error copy off a `LoombreApiError`
 *     narrowing in apps/web (d4-e6) — `apiErrorCopy(err, fallback)` is the
 *     one way to turn a caught API error into a sentence a person reads.
 *
 * Exits non-zero and prints `file:line: reason` for every hit.
 */
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/**
 * The subset of `rels` that git IGNORES (one `git check-ignore` spawn, NUL-
 * delimited both ways so paths with spaces/newlines survive).
 *
 * Only the (d) NUL pass consults this. Its whole rationale is git-shaped — an
 * ignored path has no diff, no blame, and no `git grep` presence no matter
 * what bytes it holds, and a CI checkout does not contain it at all, so
 * scanning one makes the local gate red where CI is green (the same
 * local-run == CI-run reasoning that put `reports`/`.build*` in
 * EXCLUDED_DIR_NAMES, but resolved per-file because the ignore lives in a
 * developer's `.git/info/exclude`). Untracked-but-NOT-ignored files stay in
 * scope: a brand-new source file that has never been `git add`ed is exactly
 * the case this gate has to catch BEFORE it lands as an opaque blob.
 *
 * check-ignore exits 1 when nothing matches (not an error) and 128 when git
 * is unavailable or this is not a repo; both yield an empty set, which
 * fails CLOSED — every file stays scanned, i.e. today's behaviour.
 */
function gitIgnoredSet(rels) {
  if (rels.length === 0) return new Set();
  try {
    const out = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: ROOT,
      input: rels.join("\0") + "\0",
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch (err) {
    // Exit 1 = "no path was ignored": stdout is empty and that IS the answer.
    if (err && err.status === 1) return new Set();
    return new Set();
  }
}

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
  // Generated media/stash fixtures (.gitignore'd — `pnpm gen:media-fixtures`
  // builds them; git tracks NOTHING under this tree). Their `.ts` files are
  // MPEG-TS transport streams, not TypeScript: real binary that the (d) NUL
  // pass below would otherwise report by the dozen, and that every other
  // pass here was pointlessly reading as utf8.
  "test-fixtures",
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
// Denylisted competitor product names, assembled from fragments so the
// literal words are not present as tracked text anywhere in this repo. The
// two names are the AGPL-forked C#/.NET media server and the proprietary
// server it forked from; runtime string concatenation reconstitutes them
// for matching only.
const DENY_1 = "je" + "lly" + "fin";
const DENY_2 = "em" + "by";

const NAMING_PATTERNS = [
  // The second name is bounded on both sides so ordinary identifiers that
  // merely contain the letter run (getItemById → "...temBy..." case-
  // insensitively) don't false-positive; real product naming ("<name>",
  // "<name>-api", "<Name>.X") still hits. Both names are built from string
  // fragments (DENY_1/DENY_2) so this enforcement file does not itself
  // contain the literal words it forbids.
  { code: "competitor-product-naming", pattern: new RegExp(`${DENY_1}|(?<![a-z0-9])${DENY_2}(?![a-z0-9])`, "i") },
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
// CURSOR-ROW-ID gate (V1-002, audit fafa47f, Fix Wave 4 lane FW4-A):
// SEVENTEEN cursor-payload validators across packages/db/src/query/*.ts
// (the audit's own evidence undercounted this at sixteen — re-enumerated
// from source; see STATE.md for the reconciliation) bound an unvalidated
// row-id field straight into a `uuid` column keyset comparison — a
// malformed cursor (corrupt, truncated, or hand-forged; NOT only the
// hand-forged case — items.ts's own local decodeCursor 500'd on ANY
// malformed cursor, the worst instance) raised Postgres's own 22P02 as an
// uncaught 500 instead of the 422 the contract declares. The shared
// codec's isCursorRowId() (packages/db/src/query/cursor.ts) is the ONE
// correct idiom — four zone surfaces used it already; the other seventeen
// re-derived a bare `typeof x.id === 'string'` check instead (or, for
// items.ts, no check at all), which accepts ANY string, uuid-shaped or
// not. This bans that exact bare-string idiom (and its itemId sibling) for
// the `id`/`itemId` field of a cursor payload anywhere in
// packages/db/src/query/ — the literal shape every one of those validators
// shared before FW4-A fixed them. (catalog-detail.ts's own
// isListCursorPayload, also named in the audit's evidence, turned out on
// re-check to already validate its `id` against the same UUID_PATTERN
// inline — not one of the seventeen, left as-is.)
//
// Deliberately line-based/textual (matching this whole gate file's style)
// rather than a real type-flow check: it cannot prove a given `id` field
// feeds a `uuid` column (that's stash-sync-reports.ts's one legitimate
// exception below), only that the WRONG idiom for validating one was used.
// That is exactly the property that let this bug recur silently across
// twelve files — a check that requires zero judgment call to satisfy
// (call isCursorRowId, or don't write a cursor validator that way) is the
// point.
// Matches BOTH polarities (`=== "string"` and `!== "string"` — the latter
// is literally items.ts's original pre-fix form) and both access spellings
// (`v.id` / `v["id"]`). Known, accepted blind spots of a line-based check
// (the live-DB spec packages/db/test/cursor-row-id-validation.spec.ts is
// the real backstop): a destructured `const { id } = v; typeof id === ...`
// and a row-id field named something other than id/itemId.
const CURSOR_ROW_ID_PATTERN =
  /typeof\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\.(?:id|itemId)|\[\s*['"](?:id|itemId)['"]\s*\])\s*[!=]==\s*['"]string['"]/;
const CURSOR_ROW_ID_SCOPE = "packages/db/src/query/";
const CURSOR_ROW_ID_EXEMPT_FILES = new Set([
  // The codec itself — isCursorRowId's OWN implementation is not a cursor
  // payload validator calling itself.
  "packages/db/src/query/cursor.ts",
]);
// Line-level (NOT file-level) escape hatch for the rare legitimate
// bare-string row-id check — a keyset cursor keyed on a non-uuid column
// (today: stash-sync-reports.ts's isStashSceneCursorPayload, keyed on
// stash_scene_id TEXT). The marker must sit on the flagged line or the
// line directly above it, so exempting one validator can never silently
// exempt a whole file's OTHER validators (the hole a file-level allowlist
// had). If the marker and the check ever drift apart, the gate fires —
// it fails closed.
const CURSOR_ROW_ID_ALLOW_MARKER = "grep-gates:allow-bare-cursor-row-id";

// ---------------------------------------------------------------------------
// API-ERROR-COPY gate (d4-e6, backlog #123 — the residue d3-e2 believed it
// had finished): user-facing error copy in apps/web comes from
// `apiErrorCopy(err, fallback)` (apps/web/src/lib/api-error-message.ts),
// NEVER from a bare `err instanceof LoombreApiError ? err.message : fallback`.
//
// Two distinct defects live in the banned idiom, and only the second is
// visible today:
//   1. It reads the TITLE-level message. The helper prefers the RFC 9457
//      `problem.detail` — the specific, actionable sentence the server
//      wrote — and falls back to `.message` only when there is no detail.
//      The two happen to agree right now ONLY because `LoombreApiError`'s
//      constructor is detail-first (packages/sdk); that is a property of a
//      generated client this app does not own, and the day it changes,
//      ~67 catch blocks silently downgrade to "Unprocessable Entity".
//   2. `instanceof` is the wrong test for a value that crossed a module
//      boundary. Any error that is structurally a problem response but not
//      that exact class — a re-thrown copy, a mocked/duck-typed error, a
//      second copy of the SDK in the graph — takes the `: fallback` branch
//      and throws the server's sentence away. The helper duck-types.
// `instanceof LoombreApiError` remains CORRECT and is untouched here when it
// discriminates on `err.status` (404 → not-found screen, 429 → rate-limit
// copy, 501 → unsupported); this gate bans only reading COPY off it.
//
// Deliberately textual, in this file's house style, and IDENTIFIER-AWARE
// rather than shape-aware: the defect wears at least three syntaxes —
//   `setError(err instanceof LoombreApiError ? err.message : fallback)`
//   `if (err instanceof LoombreApiError) { setError(err.message); } else …`
//   `setError(err instanceof LoombreApiError ? (err.status === 404 ? … : err.message) : …)`
// — and a rule written against any one of them leaves the others as an open
// door for the class to regrow through, which is the whole point of the gate.
// So: for each `X instanceof LoombreApiError`, a read of `X.message` within
// the next few lines is the violation, whatever punctuation sits between.
// `err.status` discrimination is untouched; so is `.message` on a value that
// was NOT narrowed to LoombreApiError (a plain `err instanceof Error` branch
// keeps its own identifier's message — different identifier, or the marker).
const API_ERROR_COPY_SCOPE = "apps/web/src/";
const API_ERROR_COPY_NARROWING = /([A-Za-z_$][\w$]*)\s+instanceof\s+LoombreApiError\b/g;
/** Lines searched from (and including) the narrowing line — the wrapped ternary needs ~5. */
const API_ERROR_COPY_WINDOW_LINES = 8;
// Line-level escape hatch, same fails-closed posture as
// CURSOR_ROW_ID_ALLOW_MARKER: the marker must sit on the flagged line or the
// line directly above it. For the case where the title-level message really
// is the right copy and the detail really is not.
const API_ERROR_COPY_ALLOW_MARKER = "grep-gates:allow-api-error-message";
// Test files are out of scope: the shape appears there as PROSE (comments
// describing this very migration) and inside deliberately hand-built fake
// errors. Nothing in a spec file reaches a viewer, so there is no copy to
// protect there — and a guard test that could not name the idiom it guards
// against would be the same self-defeating shape UPNP_ALLOWLIST documents.
const API_ERROR_COPY_TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
/**
 * Files that still hold the old shape, each with the reason it was not swept
 * and who sweeps it. This map must SHRINK: an entry whose file no longer
 * matches is itself reported, so a stale exemption cannot outlive the defect
 * it excuses (the failure mode a plain allowlist has).
 */
const API_ERROR_COPY_KNOWN_REMAINING = new Map([
  // Empty since the d4-e6 follow-up swept HomeContent.tsx (the last entry).
  // Add entries only with an owner and a deletion condition, as that one had.
]);

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

// ---------------------------------------------------------------------------
// (f) RZI SURFACE-SCOPING gate (run RZI-2026-08-30, DECISIONS.md
// §2026-08-29 rulings RZI-D1..D7, docs/PLAN.md §6.4 as amended): restricted
// rows leave the server only for a restricted-zone surface or a
// full-clearance item-addressed read. Option B's promise is "misuse fails a
// gate, not a review" — three checks deliver it:
//
//   f1 rzi:route-blind-resolve — the pre-RZI `viewerContextProvider
//      .resolve(` (no surface dimension) may not be called anywhere in
//      apps/server or apps/worker: every resolution must choose
//      resolveGeneralSurface / resolveRestrictedSurface / resolveSurfaces
//      explicitly. (The method is also deleted; this catches a
//      reintroduction.)
//   f2 rzi:restricted-surface-resolver — the restricted-capable resolvers
//      are callable ONLY from the RZI-D3/D5/D6/D7 allowlist below (zone
//      controllers, playback, images/chapters, item-addressed progress/
//      watchlist ops, admin tools, data-freedom, the WS broadcaster, and
//      the provider itself). A new caller is a §6.4 surface-assignment
//      decision, not a convenience — add it here WITH its ruling.
//   f3 rzi:restricted-surface-literal — a hand-built `surface: 'restricted'`
//      ViewerContext literal is constructible only inside the provider.
//
// Spec/test files are exempt (they construct contexts freely; nothing in
// them reaches a viewer), same posture as API_ERROR_COPY_TEST_FILE.
const RZI_SCOPE_PREFIXES = ["apps/server/src/", "apps/worker/src/"];
const RZI_TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
const RZI_ROUTE_BLIND_RESOLVE = /[A-Za-z_$]*[Pp]rovider\s*\.\s*resolve\s*\(/;
const RZI_RESTRICTED_RESOLVERS = /\b(?:resolveRestrictedSurface|resolveViewerRestrictedSurface|resolveSurfaces)\s*\(/;
const RZI_RESTRICTED_SURFACE_LITERAL = /surface:\s*["']restricted["']/;
const RZI_RESOLVER_ALLOWLIST = new Map([
  ["apps/server/src/common/viewer-context.provider.ts", "defines the surface-scoped resolvers"],
  ["apps/server/src/session/restricted-zone.controller.ts", "the zone surface itself"],
  ["apps/server/src/session/restricted.controller.ts", "unlock/lock/count (count is gate-5-independent by design)"],
  ["apps/server/src/catalog/viewer.ts", "defines resolveViewerRestrictedSurface for the catalog D3 list"],
  ["apps/server/src/catalog/images.controller.ts", "RZI-D3: item-addressed, serves zone artwork"],
  ["apps/server/src/catalog/chapters.controller.ts", "RZI-D3: item-addressed, serves the zone player"],
  ["apps/server/src/catalog/progress.controller.ts", "RZI-D3: GET/PUT /progress/{itemId} only (list stays general)"],
  ["apps/server/src/catalog/watchlist.controller.ts", "RZI-D2a/D3: PUT/DELETE /watchlist/{itemId} only (list stays general)"],
  ["apps/server/src/catalog/admin.controller.ts", "RZI-D6: admin tooling keeps full clearance"],
  ["apps/server/src/catalog/data-freedom.controller.ts", "RZI-D7: the user's own export keeps full clearance"],
  ["apps/server/src/playback/viewer.ts", "RZI-D3: every playback read serves the player"],
  ["apps/server/src/gateway/ws-broadcaster.service.ts", "RZI-D5c: per-socket pair; delivery surface follows the zone subscription"],
]);
const RZI_SURFACE_LITERAL_ALLOWLIST = new Set([
  "apps/server/src/common/viewer-context.provider.ts",
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

// Consulted by the (d) NUL pass only — every other pass keeps its full scope.
const ignoredFiles = gitIgnoredSet(files.map((f) => f.rel));

/** Files the API-ERROR-COPY pass actually flagged, for the stale-entry check. */
const apiErrorCopyHitFiles = new Set();

for (const { full, rel } of files) {
  const inNamingScope = NAMING_SCOPE_PREFIXES.some((p) => rel.startsWith(p));
  const inBrandHygieneScope = rel.startsWith(BRAND_HYGIENE_SCOPE);
  const isInBrandAllowlist = BRAND_HYGIENE_ALLOWLIST.has(rel);
  const content = readFileSync(full, "utf8");
  const lines = content.split("\n");

  // (d) d3-aq3 (verify/gap-F1): NO scanned source file may contain a raw
  // NUL byte. `.gitattributes`' `* text=auto` binary-detects a file with a
  // NUL near its head, and a binary file has NO reviewable diff, no blame,
  // and is invisible to `git grep` — a 176-line module once landed that way
  // over one `\x00` used as a map-key separator, permanently blinding every
  // diff/grep gate to it. A separator that needs a control character is
  // spelled with an ESCAPE (`"\u0000"`), never a literal byte.
  const nulIndex = content.indexOf("\u0000");
  // git-IGNORED paths are out of scope (see gitIgnoredSet): they carry no
  // diff/blame/grep surface to protect and never exist in a CI checkout, so
  // scanning one only makes a developer's gate red where CI is green.
  if (nulIndex !== -1 && !ignoredFiles.has(rel)) {
    violations.push({
      rel,
      lineNo: content.slice(0, nulIndex).split("\n").length,
      code: "binary-source:nul-byte",
      line: "raw NUL byte in repo source (git would treat this file as binary — no diff, no blame, no grep)",
    });
  }

  // (e) API-ERROR-COPY pass — windowed, so it must run over the line array
  // rather than inside the single-line loop below.
  if (rel.startsWith(API_ERROR_COPY_SCOPE) && !API_ERROR_COPY_TEST_FILE.test(rel)) {
    lines.forEach((line, idx) => {
      API_ERROR_COPY_NARROWING.lastIndex = 0;
      for (let m = API_ERROR_COPY_NARROWING.exec(line); m; m = API_ERROR_COPY_NARROWING.exec(line)) {
        const window = [
          line.slice(m.index + m[0].length),
          ...lines.slice(idx + 1, idx + API_ERROR_COPY_WINDOW_LINES),
        ].join(" ");
        if (!new RegExp(`\\b${escapeRegExp(m[1])}\\.message\\b`).test(window)) continue;
        apiErrorCopyHitFiles.add(rel);
        if (API_ERROR_COPY_KNOWN_REMAINING.has(rel)) continue;
        if (line.includes(API_ERROR_COPY_ALLOW_MARKER)) continue;
        if (idx > 0 && lines[idx - 1].includes(API_ERROR_COPY_ALLOW_MARKER)) continue;
        violations.push({
          rel,
          lineNo: idx + 1,
          code: "api-error-copy:bare-message",
          line: `${line.trim().slice(0, 160)}  — reads \`${m[1]}.message\` off a LoombreApiError; use apiErrorCopy(${m[1]}, fallback) from lib/api-error-message`,
        });
      }
    });
  }

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
    if (
      rel.startsWith(CURSOR_ROW_ID_SCOPE) &&
      !CURSOR_ROW_ID_EXEMPT_FILES.has(rel) &&
      CURSOR_ROW_ID_PATTERN.test(line) &&
      !line.includes(CURSOR_ROW_ID_ALLOW_MARKER) &&
      !(idx > 0 && lines[idx - 1].includes(CURSOR_ROW_ID_ALLOW_MARKER))
    ) {
      violations.push({ rel, lineNo: idx + 1, code: "cursor-validator:bare-string-row-id", line: line.trim() });
    }
    if (RZI_SCOPE_PREFIXES.some((p) => rel.startsWith(p)) && !RZI_TEST_FILE.test(rel)) {
      if (RZI_ROUTE_BLIND_RESOLVE.test(line)) {
        violations.push({
          rel,
          lineNo: idx + 1,
          code: "rzi:route-blind-resolve",
          line: `${line.trim().slice(0, 160)}  — choose resolveGeneralSurface/resolveRestrictedSurface (docs/PLAN.md §6.4 surface scoping)`,
        });
      }
      if (!RZI_RESOLVER_ALLOWLIST.has(rel) && RZI_RESTRICTED_RESOLVERS.test(line)) {
        violations.push({
          rel,
          lineNo: idx + 1,
          code: "rzi:restricted-surface-resolver",
          line: `${line.trim().slice(0, 160)}  — restricted-capable resolution outside the RZI allowlist; a new caller needs a §6.4 surface ruling`,
        });
      }
      if (!RZI_SURFACE_LITERAL_ALLOWLIST.has(rel) && RZI_RESTRICTED_SURFACE_LITERAL.test(line)) {
        violations.push({
          rel,
          lineNo: idx + 1,
          code: "rzi:restricted-surface-literal",
          line: `${line.trim().slice(0, 160)}  — hand-built restricted-surface ViewerContext outside the provider`,
        });
      }
    }
  });
}

// (e) API-ERROR-COPY stale-exemption check: the KNOWN_REMAINING map is a
// to-do list, not an allowlist. When a listed file stops matching (swept, or
// gone), its entry is the only thing left saying the defect is there —
// report it so the entry is deleted with the fix.
for (const [rel, reason] of API_ERROR_COPY_KNOWN_REMAINING) {
  if (apiErrorCopyHitFiles.has(rel)) continue;
  violations.push({
    rel,
    lineNo: 0,
    code: "api-error-copy:stale-exemption",
    line: `no longer holds the old shape — delete this API_ERROR_COPY_KNOWN_REMAINING entry (was: ${reason})`,
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
