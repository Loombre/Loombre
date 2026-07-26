#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/docs/build-api-reference.mjs
//
// Addendum A, lane D1 (STATE.md "## Addendum A", deliverable 8) — generates
// the API reference from packages/contract/openapi.yaml (the contract-first
// source of truth, CLAUDE.md invariant 1) via `redocly build-docs`
// (@redocly/cli, already a devDep of packages/contract — orchestrator
// decision AD2) and drops the resulting static, self-contained HTML file
// into the BUILT docs site output (docs/.vitepress/dist/api-reference/
// redoc.html), alongside the authored docs/api-reference/index.md landing
// page that links/iframes it. DECISION LOGGED: a static HTML artifact
// copied into the built site's output directory, rather than a VitePress
// page/component wrapping Redoc — simplest correct option, avoids adding a
// Vue/React Redoc component dependency neither installed nor requested, and
// keeps `redocly build-docs`'s own well-tested rendering intact.
//
// Runs AFTER `vitepress build` (scripts/docs/build.mjs's step order) since
// `vitepress build` empties/rewrites its outDir — writing here first would
// be silently deleted.
//
// TELEMETRY: REDOCLY_TELEMETRY=off is set on the child process env (D14 —
// no telemetry, ever; the mission brief calls this out explicitly for this
// exact command).
//
// OFFLINE REPRODUCIBILITY: `redocly build-docs`'s default HTML template
// loads its Redoc renderer from `https://cdn.redocly.com/redoc/.../
// bundles/redoc.standalone.js` — a real external-CDN dependency, verified
// by inspecting the actual generated output (not documented behavior taken
// on faith). That fails the "no external fonts/CDNs" build constraint, so
// this script POST-PROCESSES the generated HTML: it resolves the `redoc`
// package's bundle via Node's own module resolution — not a hardcoded pnpm
// store hash, which would break on every dependency bump — and inlines its
// full contents in place of the CDN `<script src>` tag. Since @redocly/cli
// 2.34 the CLI is dependency-free (its deps are bundled/inlined), so
// `redoc` no longer arrives transitively: packages/contract declares it as
// an explicit devDependency, pinned to the exact version the CLI's HTML
// template references (2.5.3 as of @redocly/cli 2.40.0), and the bundle is
// resolved from packages/contract's own tree. `--disableGoogleFont`
// handles the other external dependency (Google Fonts) via a documented
// flag. A verification pass at the end fails the build (non-zero exit) if
// any `cdn.redocly.com` reference survives the substitution — this
// generator must FAIL loudly, not ship a silently-still-CDN-dependent
// artifact.
//
// Exits non-zero on any failure — this step is part of the gate-facing
// `docs:build` and must be able to fail it (mission brief: "the docs build
// must actually FAIL the gate on broken build").

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CONTRACT_DIR = join(REPO_ROOT, "packages", "contract");
const OPENAPI_PATH = join(CONTRACT_DIR, "openapi.yaml");
// The @redocly/cli JS entry, resolved from packages/contract's own
// dependency tree and spawned through process.execPath below — NOT the
// node_modules/.bin shim. The shim is a .cmd on Windows, which Node cannot
// spawn without a shell, and a shell would mangle the space-containing
// --title argument; the direct-JS spawn is byte-identical in effect on
// every platform (the shim execs this same file). First Windows leg since
// docs-build joined the gate (Addendum A) — caught by the rename run's
// [full-ci] matrix.
const REDOCLY_CLI_JS = createRequire(join(CONTRACT_DIR, "package.json")).resolve("@redocly/cli/bin/cli.js");
const OUTPUT_DIR = join(REPO_ROOT, "docs", ".vitepress", "dist", "api-reference");
const OUTPUT_PATH = join(OUTPUT_DIR, "redoc.html");

function fail(message) {
  console.error(`build-api-reference: FAIL — ${message}`);
  process.exit(1);
}

if (!existsSync(OPENAPI_PATH)) {
  fail(`contract not found at ${OPENAPI_PATH} — is packages/contract in this checkout?`);
}

if (!existsSync(REDOCLY_CLI_JS)) {
  fail(
    `redocly CLI not found at ${REDOCLY_CLI_JS}. This lane never runs pnpm install — ` +
      `@redocly/cli should already be a devDependency of packages/contract (Addendum A ` +
      `decision AD2). Run \`pnpm install\` at the repo root if dependencies are missing.`,
  );
}

mkdirSync(OUTPUT_DIR, { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    REDOCLY_CLI_JS,
    "build-docs",
    OPENAPI_PATH,
    "-o",
    OUTPUT_PATH,
    "--disableGoogleFont",
    "--title",
    "Loombre API Reference",
  ],
  {
    cwd: CONTRACT_DIR,
    stdio: "inherit",
    env: { ...process.env, REDOCLY_TELEMETRY: "off" },
  },
);

if (result.status !== 0) {
  fail("redocly build-docs exited non-zero — see output above");
}

if (!existsSync(OUTPUT_PATH)) {
  fail(`redocly build-docs reported success but ${OUTPUT_PATH} does not exist`);
}

// --- Inline the Redoc renderer bundle instead of the CDN <script src> ------

let html = readFileSync(OUTPUT_PATH, "utf8");

// [^>]* after the src attribute: @redocly/cli 2.x adds integrity= and
// crossorigin= attributes to the CDN script tag; 1.x emitted none.
const CDN_SCRIPT_RE = /<script\s+src="https:\/\/cdn\.redocly\.com\/[^"]*redoc\.standalone\.js"[^>]*><\/script>/;

if (!CDN_SCRIPT_RE.test(html)) {
  fail(
    "expected CDN <script src> tag for redoc.standalone.js was not found in the generated " +
      "HTML — redocly's output template may have changed; update this script's regex " +
      "(CDN_SCRIPT_RE) after confirming the new shape, don't just remove the check.",
  );
}

let bundlePath;
try {
  bundlePath = createRequire(join(CONTRACT_DIR, "package.json")).resolve(
    "redoc/bundles/redoc.standalone.js",
  );
} catch (err) {
  fail(
    `could not resolve the local redoc.standalone.js bundle via Node module resolution ` +
      `(searched from packages/contract, which pins redoc as an explicit devDependency ` +
      `since @redocly/cli 2.x stopped shipping it transitively): ${err.message}`,
  );
}

const bundleJs = readFileSync(bundlePath, "utf8");

// A function replacer, NOT a string replacer: String.prototype.replace
// treats "$&", "$$", "$1", etc. specially in a STRING replacement — and a
// ~900 KB minified JS bundle reliably contains stray "$"-sequences that
// would otherwise be misinterpreted as replacement patterns, corrupting
// the output (caught during development: the naive string-replacement
// form produced a ~3x-bloated, broken file). A function replacer's return
// value is inserted literally, with no special-character processing.
html = html.replace(CDN_SCRIPT_RE, () => `<script>\n${bundleJs}\n</script>`);

if (/cdn\.redocly\.com/.test(html)) {
  fail(
    "a cdn.redocly.com reference survived inlining — offline-reproducibility constraint " +
      "violated; refusing to ship this artifact.",
  );
}

writeFileSync(OUTPUT_PATH, html);

const sizeKb = Math.round(statSync(OUTPUT_PATH).size / 1024);
console.log(
  `build-api-reference: PASS — wrote docs/.vitepress/dist/api-reference/redoc.html ` +
    `(${sizeKb} KiB, redoc.standalone.js inlined from ${bundlePath.replace(REPO_ROOT + "/", "")})`,
);
process.exit(0);
