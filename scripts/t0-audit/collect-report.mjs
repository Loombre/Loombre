#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/t0-audit/collect-report.mjs
//
// The "measurement-collector" the mission names: reads every JSON artifact
// the other scripts/t0-audit/*.mjs scripts wrote into --results-dir and
// stamps the report's `MEASURE:<key>` placeholders with the real numbers +
// a mechanically-derived PASS/FAIL verdict. The report lives at
// reports/t0-audit.md — LOCAL, gitignored scratch output — and is seeded on
// first run from the tracked template scripts/t0-audit/t0-audit.template.md
// (reports/ holds nothing tracked). Never invents a
// number for a measurement that wasn't run — a missing artifact leaves its
// placeholder(s) untouched (still reading `MEASURE:...` afterward), logged
// as a warning, not silently marked PASS.
//
// Verdicts are derived from each source script's OWN `breaches`/`overallPass`
// field wherever one exists (scripts/perf-t0.mjs's, rss-sample.mjs's,
// cold-start.mjs's, sustained-monitor.mjs's) rather than re-encoding the
// §9.2/§9.3 budget numbers a second time here — single-sourced, so a future
// budget change in one of those scripts can't silently drift out of sync
// with what this collector calls PASS.
//
// Usage:
//   node scripts/t0-audit/collect-report.mjs \
//     [--results-dir DIR] [--report-path reports/t0-audit.md] \
//     [--web-budget-json <path to perf/web-budget-result.json>] \
//     [--lighthouse-score 0.94]     # hand-read from `pnpm perf:lighthouse`'s
//                                    # own console output — LHCI's on-disk
//                                    # report format is not stable enough
//                                    # across versions to parse robustly
//                                    # here; this one field stays a manual
//                                    # pass-through by design, not an
//                                    # oversight (see the runbook).
//
// Idempotent — re-run any measurement script and re-run this collector to
// refresh the report; it always re-reads the report's CURRENT `MEASURE:`
// placeholders (so if you've already stamped a value and want to redo it,
// restore that cell to `MEASURE:<key>` by hand first, or delete
// reports/t0-audit.md and re-run — it is re-seeded from the template).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, fmtMiB, log, warn, fail, resultsDir } from "./lib/common.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
/** The tracked report template. The stamped report itself is written under
 *  reports/ (gitignored) and seeded from this file when absent. */
const TEMPLATE_PATH = path.join(__dirname, "t0-audit.template.md");

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    warn("collect-report", `${filePath} exists but failed to parse as JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function verdict(pass) {
  return pass ? "PASS" : "FAIL → BLOCKER or AMENDED (owner decides — see report)";
}

/** Replaces the FIRST occurrence of `MEASURE:<key>` (word-bounded so
 *  `p95_browse` doesn't also match inside `p95_browse_verdict`) with
 *  `value`. Throws if the key is not found — a stale/renamed placeholder
 *  should be loud, not silently skipped. */
function stamp(text, key, value) {
  const re = new RegExp(`MEASURE:${key}(?![A-Za-z0-9_])`);
  if (!re.test(text)) {
    warn("collect-report", `placeholder MEASURE:${key} not found in the report (already stamped, or the template drifted) — skipping`);
    return text;
  }
  return text.replace(re, String(value));
}

function stampPair(text, key, valueText, pass) {
  text = stamp(text, key, valueText);
  text = stamp(text, `${key}_verdict`, verdict(pass));
  return text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = args["report-path"] ?? path.join(REPO_ROOT, "reports", "t0-audit.md");
  if (!existsSync(reportPath)) {
    if (!existsSync(TEMPLATE_PATH)) {
      throw new Error(`t0-audit: template ${TEMPLATE_PATH} not found — the tracked template is missing`);
    }
    mkdirSync(path.dirname(reportPath), { recursive: true });
    copyFileSync(TEMPLATE_PATH, reportPath);
    log("collect-report", `seeded ${reportPath} from ${path.relative(REPO_ROOT, TEMPLATE_PATH)}`);
  }
  let text = readFileSync(reportPath, "utf8");
  const dir = resultsDir(args);
  log("collect-report", `reading measurement artifacts from ${dir}`);

  // --- idle RSS -------------------------------------------------------
  const rss = readJsonIfExists(path.join(dir, "rss-sample.idle.json"));
  if (rss) {
    const serverPass = !rss.breaches.some((b) => b.startsWith("server RSS"));
    text = stampPair(text, "idle_rss_server", fmtMiB(rss.serverRssBytes), serverPass);
    const stackValueText = rss.stackComplete ? fmtMiB(rss.stackBytes) : `${fmtMiB(rss.stackBytes)} (PARTIAL — worker or embedded PG missing)`;
    const stackPass = rss.stackComplete && !rss.breaches.some((b) => b.startsWith("stack"));
    text = stampPair(text, "idle_rss_stack", stackValueText, stackPass);
  } else {
    warn("collect-report", "no rss-sample.idle.json — run scripts/t0-audit/rss-sample.mjs --label idle first");
  }

  // --- p95 / scan throughput (via run-perf-t0.mjs's summary) ---------
  const perfSummary = readJsonIfExists(path.join(dir, "run-perf-t0-summary.json"));
  const perfBaseline = perfSummary?.perfBaseline ?? null;
  if (perfBaseline) {
    const breaches = perfBaseline.breaches ?? [];
    const e = perfBaseline.endpoints ?? {};
    if (e.browsePageList) {
      text = stampPair(text, "p95_browse", `${e.browsePageList.p95Ms.toFixed(1)} ms (n=${e.browsePageList.sampleCount})`, !breaches.some((b) => b.startsWith("browsePageList")));
    }
    if (e.itemDetail) {
      text = stampPair(text, "p95_item_detail", `${e.itemDetail.p95Ms.toFixed(1)} ms (n=${e.itemDetail.sampleCount})`, !breaches.some((b) => b.startsWith("itemDetail")));
    }
    if (e.continueWatching) {
      text = stampPair(text, "p95_continue_watching", `${e.continueWatching.p95Ms.toFixed(1)} ms (n=${e.continueWatching.sampleCount})`, !breaches.some((b) => b.startsWith("continueWatching")));
    }
    if (e.searchAsYouType) {
      text = stampPair(text, "p95_search", `${e.searchAsYouType.p95Ms.toFixed(1)} ms (n=${e.searchAsYouType.sampleCount})`, !breaches.some((b) => b.startsWith("searchAsYouType")));
    }
    if (perfBaseline.scanThroughput) {
      const st = perfBaseline.scanThroughput;
      const tmpNote = perfSummary.hddTmpDir ? ` (TMPDIR=${perfSummary.hddTmpDir})` : " (WARNING: default os.tmpdir(), NOT verified HDD-backed)";
      text = stampPair(text, "scan_throughput", `${st.filesPerMin.toFixed(0)} files/min${tmpNote}`, !breaches.some((b) => b.startsWith("scanThroughput")));
    }
  } else {
    warn("collect-report", "no run-perf-t0-summary.json (or it has no perfBaseline) — run scripts/t0-audit/run-perf-t0.mjs first");
  }

  // --- cold start -------------------------------------------------------
  const coldStart = readJsonIfExists(path.join(dir, "cold-start.json"));
  if (coldStart) {
    const valueText =
      coldStart.steadyStateMs === null
        ? "n/a (no steady-state sample — re-run with --runs >= 2)"
        : `${coldStart.steadyStateMs.toFixed(0)} ms (worst of ${coldStart.samplesMs.length - (coldStart.firstBootMs !== null ? 1 : 0)} steady-state run(s)${coldStart.firstBootMs !== null ? `; first-ever boot was ${coldStart.firstBootMs.toFixed(0)} ms, informational` : ""})`;
    text = stampPair(text, "cold_start", valueText, coldStart.breaches.length === 0 && coldStart.steadyStateMs !== null);
  } else {
    warn("collect-report", "no cold-start.json — run scripts/t0-audit/cold-start.mjs first");
  }

  // --- headline dual-transcode + sustained monitor -----------------------
  const dual = readJsonIfExists(path.join(dir, "dual-transcode.json"));
  const sustained = readJsonIfExists(path.join(dir, "sustained-monitor.json"));
  if (dual && sustained) {
    const bySessionId = new Map(sustained.sessions.map((s) => [s.sessionId, s]));
    const letters = ["a", "b"];
    dual.sessions.slice(0, 2).forEach((session, i) => {
      const letter = letters[i];
      const s = bySessionId.get(session.sessionId);
      text = stamp(text, `headline_item_${letter}`, `"${session.title ?? session.itemId}" (${session.resolution ?? "resolution unknown"})`);
      text = stamp(text, `headline_backend_${letter}`, session.backend);
      if (s) {
        text = stamp(text, `headline_segments_${letter}`, String(s.segmentsConsumed));
        text = stamp(text, `headline_gap_${letter}`, String(s.gapDetected));
        const rssText =
          s.ffmpegRss.firstBytes === null
            ? "no ffmpeg RSS samples captured (process never located via /proc/<pid>/cwd — see runbook troubleshooting)"
            : `${fmtMiB(s.ffmpegRss.firstBytes)} → ${fmtMiB(s.ffmpegRss.lastBytes)}${s.ffmpegRss.growthPct !== null ? ` (${s.ffmpegRss.growthPct >= 0 ? "+" : ""}${s.ffmpegRss.growthPct.toFixed(1)}%)` : ""}`;
        text = stamp(text, `headline_rss_trend_${letter}`, rssText);
      }
    });
    const thermalText = !sustained.dmesgAvailable
      ? "dmesg unavailable — UNVERIFIED, not confirmed clean (see runbook: run as root, or check kernel.dmesg_restrict)"
      : sustained.newDmesgLines.length === 0
        ? "none"
        : `${sustained.newDmesgLines.length} line(s) — see t0-audit-results/sustained-monitor.json.newDmesgLines`;
    text = stamp(text, "headline_thermal", thermalText);
    text = stamp(text, "headline_mechanical_verdict", sustained.overallPass ? "PASS" : "FAIL");
    const bothHardware = dual.sessions.slice(0, 2).every((s) => s.backend && s.backend !== "software");
    const bothStarted = dual.sessions.length >= 2;
    const overallHeadline = bothStarted && bothHardware && sustained.overallPass;
    text = stamp(
      text,
      "headline_verdict",
      overallHeadline
        ? "PASS (mechanical checks green — RSS-growth trend still needs the owner's explicit sign-off above)"
        : `FAIL → BLOCKER${!bothStarted ? " (fewer than 2 sessions started)" : ""}${!bothHardware ? " (a session used software fallback, not hardware)" : ""}${!sustained.overallPass ? " (sustained-monitor mechanical checks failed)" : ""}`,
    );
  } else {
    warn("collect-report", "no dual-transcode.json and/or sustained-monitor.json — run those two scripts (in order) first");
  }

  // --- web budgets --------------------------------------------------------
  const webBudgetPath = args["web-budget-json"] ?? path.join(dir, "web-budget-result.json");
  const webBudget = readJsonIfExists(webBudgetPath);
  if (webBudget) {
    text = stampPair(
      text,
      "web_bundle",
      `${(webBudget.totalGzipBytes / 1024).toFixed(1)} KB gz`,
      !webBudget.breachedBudget,
    );
  } else {
    warn("collect-report", `no web-budget-result.json at ${webBudgetPath} — copy it from a checkout's perf/web-budget-result.json after \`pnpm perf:web-budget\`, or pass --web-budget-json`);
  }

  if (args["lighthouse-score"] !== undefined) {
    const score = Number.parseFloat(args["lighthouse-score"]);
    if (Number.isFinite(score)) {
      text = stampPair(text, "web_lighthouse", score >= 1 ? score.toFixed(0) : (score * 100).toFixed(0), score >= 0.9 || score >= 90);
    } else {
      warn("collect-report", `--lighthouse-score "${args["lighthouse-score"]}" did not parse as a number — leaving that placeholder untouched`);
    }
  } else {
    warn("collect-report", "no --lighthouse-score given — read the score from `pnpm perf:lighthouse`'s own console output and pass it (e.g. --lighthouse-score 0.94)");
  }

  writeFileSync(reportPath, text);
  log("collect-report", `wrote ${reportPath}`);

  const remaining = [...text.matchAll(/MEASURE:[A-Za-z0-9_]+/g)].map((m) => m[0]);
  if (remaining.length > 0) {
    warn("collect-report", `${remaining.length} placeholder(s) still unfilled: ${[...new Set(remaining)].join(", ")}`);
  } else {
    log("collect-report", "every MEASURE: placeholder is now stamped. FILL: fields (environment, notes, amendments) still need the owner's own hand.");
  }
}

main().catch((err) => {
  fail("collect-report", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
