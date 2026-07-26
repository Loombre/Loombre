#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `pnpm --filter @loombre/worker run hwprobe` — the operator entry point
 * (binding constraint 5: "a direct operator entry ... running the battery
 * synchronously and printing the report"). Runs the full self-test
 * battery for the current platform against the resolved ffmpeg, persists
 * the result as the new current `hw_capability_snapshots` row, and prints
 * a human-readable report to stdout. This is an operator command run from
 * a terminal, never a request path (CLAUDE.md Tier-0 law 9 is about
 * request paths — this script is the same class of thing as `pnpm
 * db:migrate`/`db:seed`).
 */
import { createDb } from "@loombre/db";
import { persistProbeReport } from "./persist.js";
import { formatProbeReport } from "./report.js";
import { runRealHwProbeBattery } from "./run.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://loombre:loombre@localhost:5442/loombre";

async function main(): Promise<void> {
  console.log("hwprobe: running the hardware capability self-test battery...");
  const report = await runRealHwProbeBattery();

  console.log("");
  console.log(formatProbeReport(report));

  const db = createDb(DATABASE_URL);
  try {
    await persistProbeReport(db, report);
    console.log(`hwprobe: persisted as the current snapshot for platform "${report.platform}".`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error("hwprobe: failed:", err);
  process.exitCode = 1;
});
