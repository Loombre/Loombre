#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/t0-audit/cold-start.mjs
//
// docs/PLAN.md §9.2: "Cold start <= 5s." Measured as: systemd unit start
// command issued -> first HTTP 200 from /healthz. This necessarily includes
// apps/server/src/bootstrap/provisioning.ts's embedded-PG bootstrap path
// (provision()+start() run before Nest ever constructs anything, per that
// file's own header) — so a cold start on this install genuinely means
// "postgres reachable + Nest booted + first request served", not just the
// Node process spawning.
//
// Two distinct numbers are recorded, because they mean very different
// things and the plan's "<=5s" reads as the steady-state figure (an
// operator restarting an already-provisioned instance), not first-ever boot:
//   - `steadyStateMs`: stop -> start -> first /healthz 200, against an
//     ALREADY-PROVISIONED data directory (initdb already ran). This is the
//     hard-enforced <=5s budget.
//   - `firstBootMs`: informational only, captured automatically the FIRST
//     time this script is ever run against a given data dir (detected by
//     the absence of <dataDir>/postgres/data/PG_VERSION before the run) —
//     includes one-time initdb cost, which is real but not what the budget
//     is naming.
//
// N100-ONLY: requires systemd (`systemctl`). Not runnable for real on this
// repo's macOS dev host; syntax/logic-checked here only.
//
// Usage:
//   node scripts/t0-audit/cold-start.mjs [--config-dir /etc/loombre]
//     [--server-unit loombre-server] [--runs 3] [--results-dir DIR]
//     [--base-url http://127.0.0.1:3001]
//
// Requires passwordless (or interactive) sudo for `systemctl stop/start`
// unless run as root already — this script does NOT silently sudo on your
// behalf; it shells out to `systemctl` directly and expects the invoking
// user to already have the necessary privilege (run the whole script under
// `sudo`, simplest).

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs,
  resolveInstallEnv,
  resolveDataDir,
  resolvePort,
  waitForHealthz,
  log,
  warn,
  fail,
  nowIso,
  writeJsonResult,
  resultsDir,
  isLinux,
} from "./lib/common.mjs";

const BUDGET_MS = 5000;

function systemctl(args) {
  const result = spawnSync("systemctl", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`t0-audit: systemctl ${args.join(" ")} failed (exit ${result.status})`);
  }
}

async function timeOneStart(serverUnit, baseUrl) {
  systemctl(["stop", serverUnit]);
  const startedAt = process.hrtime.bigint();
  systemctl(["start", serverUnit]);
  await waitForHealthz(baseUrl, 30_000);
  const endedAt = process.hrtime.bigint();
  return Number(endedAt - startedAt) / 1_000_000;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = Number.parseInt(args.runs ?? "3", 10);

  if (!isLinux()) {
    warn("cold-start", "not running on Linux — systemctl-based timing is meaningless off the real N100 host.");
  }

  const env = resolveInstallEnv(args);
  const dataDir = resolveDataDir(env);
  const serverUnit = args["server-unit"] ?? "loombre-server";
  const baseUrl = args["base-url"] ?? `http://127.0.0.1:${resolvePort(env)}`;

  const pgVersionMarker = path.join(dataDir, "postgres", "data", "PG_VERSION");
  const isFirstBootEver = !existsSync(pgVersionMarker);

  if (isFirstBootEver) {
    log("cold-start", "no existing PG_VERSION marker under the data dir — this run's FIRST start includes initdb (firstBootMs, informational).");
  }

  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    log("cold-start", `run ${i + 1}/${runs}: stopping + starting ${serverUnit}...`);
    const ms = await timeOneStart(serverUnit, baseUrl);
    log("cold-start", `run ${i + 1}/${runs}: ${ms.toFixed(0)}ms to first healthy /healthz`);
    samples.push(ms);
    // Let the stack settle briefly between runs so run N+1 isn't measuring
    // against a still-warming-up disk cache from run N in a way that makes
    // every run after the first look artificially fast.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const firstBootMs = isFirstBootEver ? samples[0] : null;
  // Steady-state figure: if this run included the one-time first boot,
  // exclude sample[0] from the enforced comparison (it is not what the
  // budget names) — otherwise all samples are steady-state already.
  const steadyStateSamples = isFirstBootEver ? samples.slice(1) : samples;
  if (steadyStateSamples.length === 0) {
    warn(
      "cold-start",
      `only ${runs} run(s) requested and the only one was the first-ever boot — re-run with --runs >= 2 ` +
        "to get at least one steady-state sample.",
    );
  }
  const steadyStateMs =
    steadyStateSamples.length > 0 ? Math.max(...steadyStateSamples) : null; // worst-case, not average — a budget is a ceiling

  const breaches = [];
  if (steadyStateMs !== null && steadyStateMs > BUDGET_MS) {
    breaches.push(`steady-state cold start ${steadyStateMs.toFixed(0)}ms > budget ${BUDGET_MS}ms`);
  }

  log("cold-start", `firstBootMs: ${firstBootMs === null ? "n/a (data dir was already provisioned)" : `${firstBootMs.toFixed(0)}ms (informational)`}`);
  log("cold-start", `steadyStateMs (worst of ${steadyStateSamples.length} run(s)): ${steadyStateMs === null ? "n/a" : `${steadyStateMs.toFixed(0)}ms`} vs budget ${BUDGET_MS}ms`);

  const result = {
    recordedAtMs: Date.now(),
    recordedAtIso: nowIso(),
    serverUnit,
    baseUrl,
    runs,
    samplesMs: samples,
    firstBootMs,
    steadyStateMs,
    budgetMs: BUDGET_MS,
    breaches,
  };

  const outPath = path.join(resultsDir(args), "cold-start.json");
  writeJsonResult(outPath, result);
  log("cold-start", `wrote ${outPath}`);

  if (breaches.length > 0) {
    fail("cold-start", `${breaches.length} budget breach(es):`);
    for (const b of breaches) console.error(`  - ${b}`);
    process.exit(1);
  }
  log("cold-start", "done — budget green");
}

main().catch((err) => {
  fail("cold-start", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
