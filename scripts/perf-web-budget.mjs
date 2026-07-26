#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/perf-web-budget.mjs
//
// P2.6 web bundle budget, ENFORCED: apps/web's /browse route's first-load
// JS must stay <= 200 KB gzipped (docs/PLAN.md §9.3).
//
// Method history: this script originally read the build's
// `.next/app-build-manifest.json` per-route chunk list. Next 16 REMOVED
// that manifest entirely (along with the build-output size table — Vercel
// deemed both inaccurate under RSC), so the measurement moved to the only
// contract that cannot drift from reality: what the server actually sends.
// The script now:
//   1. Boots the built app with `next start` on a loopback-only port
//      (/browse is a "use client" shell — its server render needs no API
//      backend; data fetching happens in the browser, which never runs
//      here).
//   2. GETs /browse and collects every external JS the HTML references:
//      `<script src="/_next/...">` tags plus any `<link rel="preload"|
//      "modulepreload" as="script">` hints, deduplicated. `noModule`
//      polyfill scripts are excluded — Next's old "First Load JS" metric
//      (the thing this budget has always named, and what the recorded
//      baseline numbers mean) excluded them too. Inline RSC-bootstrap
//      `<script>` bodies are likewise not chunk files and are excluded,
//      matching the old manifest-based set.
//   3. Maps each URL to its file under .next/ and gzips it (zlib level 9,
//      the compression level most static-hosting/CDN gzip middleware — and
//      Next's own header-reported sizes — approximate), summing the
//      compressed bytes. Real bytes-over-the-wire, not an estimate.
// Continuity at the method switch (measured, not assumed): the last
// manifest-derived number under Next 15.5.21 was 122,033 B gz; the first
// HTML-derived number under Next 16.2.11 (webpack build) was 156,159 B gz.
// The chunk-set diff attributes the +34.1 KB to the Next 16 framework
// chunk pair growing ~24 KB gz plus the finer-grained route chunks —
// same logical content, no double-counting (page/layout/shared chunks
// each appear exactly once). See perf/baselines.json entry
// web.browseFirstLoadJsGzipBytes for the recorded ledger of this change.
//
// Usage:
//   node scripts/perf-web-budget.mjs            # builds apps/web, then checks
//   PERF_WEB_SKIP_BUILD=1 node scripts/perf-web-budget.mjs   # checks an existing .next/
//
// Exits nonzero if the budget is exceeded. Also writes
// perf/web-budget-result.json (the measured bytes + per-chunk breakdown)
// for scripts/perf-baseline-check.mjs / perf/baselines.json comparison.

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(REPO_ROOT, "apps/web");
const NEXT_DIR = path.join(WEB_ROOT, ".next");
const OUT_PATH = path.join(REPO_ROOT, "perf/web-budget-result.json");

const ROUTE_PATH = "/browse";
const BUDGET_BYTES = 200 * 1024; // 200 KB gz, docs/PLAN.md §9.3
// Loopback-only, unlikely-collision port for the throwaway `next start`.
const PORT = 4791;

const WIN = process.platform === "win32";

function log(...args) {
  console.log("[perf-web-budget]", ...args);
}

function buildWebApp() {
  // Workspace deps first: @loombre/sdk (and friends) resolve via their
  // built dist/, which a fresh CI checkout doesn't have — `next build`
  // then fails with "Can't resolve '@loombre/sdk'". Same lesson as the
  // perf-t0 job's server build (STATE.md 2026-07-23 CI fix): build the
  // dependency closure, `^...` = dependencies of web, excluding web itself.
  log("building @loombre/web's workspace dependencies...");
  const deps = spawnSync("pnpm", ["--filter", "@loombre/web^...", "run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: WIN,
  });
  if (deps.status !== 0) {
    throw new Error("workspace dependency build failed");
  }

  log("building @loombre/web...");
  const result = spawnSync("pnpm", ["--filter", "@loombre/web", "run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: WIN,
  });
  if (result.status !== 0) {
    throw new Error("apps/web build failed");
  }
}

// Boots the built app, fetches ROUTE_PATH, returns the deduplicated list
// of .next-relative JS files its HTML references (script src + preload/
// modulepreload hints, noModule polyfills excluded — see header).
async function collectRouteJsFromHtml() {
  if (!existsSync(path.join(NEXT_DIR, "BUILD_ID"))) {
    throw new Error(`${path.relative(REPO_ROOT, NEXT_DIR)}/BUILD_ID not found — did the build run?`);
  }
  // Spawn the Next CLI's JS entry directly through this same Node binary —
  // the node_modules/.bin shim is a .cmd on Windows that Node can't spawn
  // without a shell (the build-api-reference.mjs lesson).
  const nextBin = createRequire(path.join(WEB_ROOT, "package.json")).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: WEB_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (d) => (childOutput += d));
  child.stderr.on("data", (d) => (childOutput += d));
  const killChild = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.on("exit", killChild);

  const extractScriptSet = (html) => {
    const files = new Set();
    for (const m of html.matchAll(/<script\s[^>]*src="([^"]+)"[^>]*>/g)) {
      if (/\bnomodule\b/i.test(m[0])) continue; // polyfills — excluded, see header
      files.add(m[1]);
    }
    for (const m of html.matchAll(/<link\s[^>]*rel="(?:module)?preload"[^>]*>/g)) {
      if (!/as="script"/.test(m[0])) continue;
      const href = /href="([^"]+)"/.exec(m[0]);
      if (href) files.add(href[1]);
    }
    return [...files]
      .filter((u) => u.startsWith("/_next/") && u.split("?")[0].endsWith(".js"))
      .map((u) => u.split("?")[0].replace("/_next/", ""))
      .sort();
  };

  try {
    const deadline = Date.now() + 30_000;
    let html;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`next start exited early (code ${child.exitCode}):\n${childOutput}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}${ROUTE_PATH}`);
        if (res.ok) {
          html = await res.text();
          break;
        }
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        throw new Error(`next start did not serve ${ROUTE_PATH} within 30s:\n${childOutput}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // The very first (cold) render can reference some chunks only through
    // the streamed RSC payload rather than literal <script src> tags —
    // observed on Next 16: the cold /browse response omitted the route's
    // own page-*.js tag that every warm response includes. Re-fetch until
    // two consecutive responses yield the identical script set so the
    // measurement is deterministic, and refuse to proceed if it never
    // stabilizes.
    let scripts = extractScriptSet(html);
    let stable = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`http://127.0.0.1:${PORT}${ROUTE_PATH}`);
      if (!res.ok) throw new Error(`re-fetch of ${ROUTE_PATH} returned ${res.status}`);
      const next = extractScriptSet(await res.text());
      if (JSON.stringify(next) === JSON.stringify(scripts)) {
        stable = true;
        break;
      }
      log(`script set not yet stable (cold-render streaming) — ${scripts.length} -> ${next.length} files, re-fetching`);
      scripts = next;
    }
    if (!stable) {
      throw new Error(`${ROUTE_PATH}'s script set did not stabilize across repeated fetches`);
    }
    return scripts;
  } finally {
    killChild();
    process.removeListener("exit", killChild);
  }
}

async function main() {
  if (process.env.PERF_WEB_SKIP_BUILD !== "1") {
    buildWebApp();
  } else {
    log("PERF_WEB_SKIP_BUILD=1 — using existing apps/web/.next/ as-is");
  }

  const jsFiles = await collectRouteJsFromHtml();
  if (jsFiles.length === 0) {
    throw new Error(`${ROUTE_PATH}'s served HTML references zero .js files — this can't be right`);
  }

  const breakdown = jsFiles.map((relFile) => {
    const abs = path.join(NEXT_DIR, relFile);
    if (!existsSync(abs)) {
      throw new Error(`manifest references ${relFile} but it doesn't exist under .next/`);
    }
    const raw = readFileSync(abs);
    const gz = gzipSync(raw, { level: 9 });
    return { file: relFile, rawBytes: raw.length, gzipBytes: gz.length };
  });

  const totalGzipBytes = breakdown.reduce((sum, row) => sum + row.gzipBytes, 0);
  const totalRawBytes = breakdown.reduce((sum, row) => sum + row.rawBytes, 0);

  log(`${ROUTE_PATH} first-load JS: ${jsFiles.length} chunks`);
  for (const row of breakdown.sort((a, b) => b.gzipBytes - a.gzipBytes)) {
    log(
      `  ${row.file.padEnd(55)} raw=${String(row.rawBytes).padStart(7)}B  gz=${String(row.gzipBytes).padStart(7)}B`,
    );
  }
  log(
    `  TOTAL raw=${totalRawBytes}B gz=${totalGzipBytes}B ` +
      `(${(totalGzipBytes / 1024).toFixed(1)} KB gz, budget ${(BUDGET_BYTES / 1024).toFixed(0)} KB gz)`,
  );

  const result = {
    recordedAtMs: Date.now(),
    route: ROUTE_PATH,
    method:
      "gzip(level 9) of every external .js file the served /browse HTML references (script src + preload hints, noModule polyfills excluded), summed",
    totalGzipBytes,
    totalRawBytes,
    budgetGzipBytes: BUDGET_BYTES,
    breachedBudget: totalGzipBytes > BUDGET_BYTES,
    chunks: breakdown,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  log(`wrote ${path.relative(REPO_ROOT, OUT_PATH)}`);

  if (result.breachedBudget) {
    console.error(
      `\n[perf-web-budget] BUDGET BREACH: ${ROUTE_PATH} first-load JS is ${(totalGzipBytes / 1024).toFixed(1)} KB gz ` +
        `> ${(BUDGET_BYTES / 1024).toFixed(0)} KB gz budget (docs/PLAN.md §9.3)`,
    );
    process.exit(1);
  }

  log("done — within budget");
}

await main();
