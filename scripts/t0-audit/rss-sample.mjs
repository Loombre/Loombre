#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/t0-audit/rss-sample.mjs
//
// docs/PLAN.md §9.2: "Idle RSS (server + worker + embedded PG) <= 500 MB;
// server process alone <= 220 MB." Unlike scripts/perf-t0.mjs's own idle-RSS
// figure (which samples a server+worker pair IT spawns itself, from a dev
// checkout, against whatever DATABASE_URL is set — see that script's header
// comment), this samples the REAL systemd-managed loombre-server.service /
// loombre-worker.service units plus the embedded-PostgreSQL process family
// they provisioned — i.e. the actual installed stack, not a stand-in.
//
// N100-ONLY: requires systemd (`systemctl show`), `ps`, `pgrep` — Linux.
// Not runnable for real on this repo's macOS dev host; syntax/logic-checked
// here only (see docs/ops/t0-audit-runbook.md).
//
// Usage:
//   node scripts/t0-audit/rss-sample.mjs [--config-dir /etc/loombre]
//     [--server-unit loombre-server] [--worker-unit loombre-worker]
//     [--results-dir DIR] [--label idle]
//
// Exits nonzero (after printing every measured number — never silent) if
// either hard-enforced budget is breached:
//   - server RSS > 220 MiB
//   - server+worker+embeddedPg RSS > 500 MiB
// Writes <results-dir>/rss-sample.<label>.json for collect-report.mjs.

import path from "node:path";
import {
  parseArgs,
  resolveInstallEnv,
  resolveDataDir,
  systemdMainPid,
  systemdActiveState,
  rssBytesForPid,
  embeddedPgRssBytes,
  fmtMiB,
  log,
  warn,
  fail,
  nowIso,
  writeJsonResult,
  resultsDir,
  isLinux,
} from "./lib/common.mjs";

const SERVER_BUDGET_BYTES = 220 * 1024 * 1024;
const STACK_BUDGET_BYTES = 500 * 1024 * 1024;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label ?? "idle";

  if (!isLinux()) {
    warn("rss-sample", "not running on Linux — this measurement is meaningless off the real N100 host. Continuing anyway (dry logic check only).");
  }

  const env = resolveInstallEnv(args);
  const dataDir = resolveDataDir(env);
  const pgDataDir = path.join(dataDir, "postgres", "data");
  const serverUnit = args["server-unit"] ?? "loombre-server";
  const workerUnit = args["worker-unit"] ?? "loombre-worker";

  log("rss-sample", `data dir: ${dataDir}`);
  log("rss-sample", `server unit: ${serverUnit} (${systemdActiveState(serverUnit)})`);
  log("rss-sample", `worker unit: ${workerUnit} (${systemdActiveState(workerUnit)})`);

  const serverPid = systemdMainPid(serverUnit);
  const workerPid = systemdMainPid(workerUnit);

  if (serverPid === null) {
    throw new Error(
      `t0-audit: ${serverUnit} has no MainPID (not running?) — start it first: sudo systemctl start ${serverUnit}`,
    );
  }

  const serverRssBytes = rssBytesForPid(serverPid);
  const workerRssBytes = workerPid !== null ? rssBytesForPid(workerPid) : NaN;
  const pg = embeddedPgRssBytes(pgDataDir);

  log("rss-sample", `server pid ${serverPid}: ${fmtMiB(serverRssBytes)}`);
  if (workerPid !== null) {
    log("rss-sample", `worker pid ${workerPid}: ${fmtMiB(workerRssBytes)}`);
  } else {
    warn("rss-sample", `${workerUnit} not running — worker RSS omitted from the stack total`);
  }
  if (pg) {
    log(
      "rss-sample",
      `embedded PG (master pid ${pg.masterPid} + ${pg.pidCount - 1} child process(es)): ${fmtMiB(pg.totalBytes)}`,
    );
  } else {
    warn(
      "rss-sample",
      `no embedded PostgreSQL process found under ${pgDataDir} — either DATABASE_URL is set (external-PG mode, ` +
        "not this audit's target per the mission: embedded PG NOT external) or PG failed to start.",
    );
  }

  const stackBytes =
    (Number.isFinite(serverRssBytes) ? serverRssBytes : 0) +
    (Number.isFinite(workerRssBytes) ? workerRssBytes : 0) +
    (pg ? pg.totalBytes : 0);

  const breaches = [];
  if (Number.isFinite(serverRssBytes) && serverRssBytes > SERVER_BUDGET_BYTES) {
    breaches.push(`server RSS ${fmtMiB(serverRssBytes)} > budget ${fmtMiB(SERVER_BUDGET_BYTES)}`);
  }
  if (stackBytes > STACK_BUDGET_BYTES) {
    breaches.push(`stack (server+worker+embeddedPG) RSS ${fmtMiB(stackBytes)} > budget ${fmtMiB(STACK_BUDGET_BYTES)}`);
  }
  const stackComplete = Number.isFinite(workerRssBytes) && pg !== null;
  if (!stackComplete) {
    warn(
      "rss-sample",
      "stack total is PARTIAL (worker and/or embedded PG missing from the sum) — the 500 MiB comparison above is " +
        "informational only until all three processes are captured in one sample. Re-run with both services up.",
    );
  }

  log("rss-sample", `stack total (server+worker+embeddedPG): ${fmtMiB(stackBytes)}${stackComplete ? "" : " (PARTIAL)"}`);

  const result = {
    recordedAtMs: Date.now(),
    recordedAtIso: nowIso(),
    label,
    dataDir,
    pgDataDir,
    serverUnit,
    workerUnit,
    serverPid,
    workerPid,
    serverRssBytes: Number.isFinite(serverRssBytes) ? serverRssBytes : null,
    workerRssBytes: Number.isFinite(workerRssBytes) ? workerRssBytes : null,
    embeddedPg: pg,
    stackBytes,
    stackComplete,
    budgets: { serverRssBytes: SERVER_BUDGET_BYTES, stackRssBytes: STACK_BUDGET_BYTES },
    breaches,
  };

  const outPath = path.join(resultsDir(args), `rss-sample.${label}.json`);
  writeJsonResult(outPath, result);
  log("rss-sample", `wrote ${outPath}`);

  if (breaches.length > 0) {
    fail("rss-sample", `${breaches.length} budget breach(es):`);
    for (const b of breaches) console.error(`  - ${b}`);
    process.exit(1);
  }
  log("rss-sample", "done — budgets green (server hard-enforced; stack total per docs/PLAN.md §9.2)");
}

main().catch((err) => {
  fail("rss-sample", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
