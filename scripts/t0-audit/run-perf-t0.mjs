#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: scripts/t0-audit/run-perf-t0.mjs
//
// Invocation wrapper around the EXISTING, already-enforcing
// scripts/perf-t0.mjs (STATE.md P2.6/D15, docs/PLAN.md §9.2) — this file
// does NOT reimplement perf-t0's measurements (p95 hot-path latency @
// 50k-item seed, scan throughput, its own idle-RSS figure); it points that
// harness at the REAL N100 install instead of the shared dev-compose
// Postgres it defaults to, per this lane's mission ("point at it, document
// running it against the real install not the dev tree").
//
// What "against the real install" means here, precisely (read this before
// running it — it is a deliberate, documented scope, not an oversight):
//
//   - The DATABASE_URL this wrapper resolves and passes through IS the
//     real embedded-PostgreSQL instance the installed loombre-server.service
//     provisioned (same binary, same data directory, same hardware) — read
//     from the secret file apps/server/src/bootstrap/provisioning.ts writes
//     (<dataDir>/postgres/superuser.secret) and the same default port
//     (5433) that file uses. p95 query latency and scan-throughput I/O
//     timings are therefore genuinely against the real N100's real Postgres
//     on real disk.
//   - perf-t0.mjs's SERVER PROCESS is NOT the real systemd-managed
//     loombre-server.service — it boots its own, separate instance (via tsx,
//     from THIS checkout's apps/server/dist/main.js, on PERF_T0_PORT) the
//     same way it does in CI/dev. This is a KNOWN deviation: it exercises
//     the identical compiled server code and the real database/hardware,
//     but not the packaged Node runtime, systemd hardening
//     (ProtectSystem=strict etc.), or the bundled ffmpeg. For that reason
//     perf-t0.mjs's OWN idle-RSS figure in its output is NOT what this
//     audit reports for the §9.2 idle-RSS budget — use
//     scripts/t0-audit/rss-sample.mjs against the real systemd units for
//     that number instead (see the runbook). This wrapper still surfaces
//     perf-t0's own idle-RSS reading in its saved JSON for completeness/
//     comparison, clearly labeled informational-only.
//   - scanThroughput's synthetic library is written under `os.tmpdir()`
//     (scripts/perf-t0.mjs's SCAN_LIBRARY_DIR — not owner-configurable, and
//     this wrapper deliberately does NOT patch that script). On many
//     distros /tmp is tmpfs (RAM-backed), which would silently turn the
//     "on HDD" budget into an in-memory measurement. Node's os.tmpdir()
//     honors $TMPDIR on POSIX — so pass --hdd-tmp-dir pointing at a real,
//     writable directory on the target HDD and this wrapper exports TMPDIR
//     accordingly before invoking perf-t0. VERIFY the directory you pass is
//     actually HDD-backed (`mount | grep <path>`/`findmnt <path>`) — this
//     wrapper cannot detect that for you.
//
// This wrapper does NOT seed the database itself (matching perf-t0.mjs's
// own "Seed prerequisite" contract in its header) — run
// `pnpm db:migrate && pnpm db:seed && pnpm db:seed-large` against the
// resolved DATABASE_URL first (the runbook's Step B does this).
//
// N100-ONLY in the sense that the DATABASE_URL/data-dir resolution targets
// a real embedded-PG install; the underlying `pnpm perf:t0` invocation
// itself already runs identically in CI on Linux/Windows/macOS, so this
// wrapper's OWN logic (arg parsing, secret-file reading, env assembly) is
// fully exercised here without a real N100 (see the runbook's "Verifying
// these scripts without an N100" section) — only the actual end-to-end run
// needs the real hardware + a real embedded PG cluster.
//
// Usage:
//   node scripts/t0-audit/run-perf-t0.mjs \
//     --repo-checkout /home/owner/loombre-src \
//     --hdd-tmp-dir /mnt/media-hdd/loombre-perf-tmp \
//     [--config-dir /etc/loombre] [--results-dir DIR]

import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs,
  resolveInstallEnv,
  resolveDataDir,
  log,
  warn,
  fail,
  nowIso,
  writeJsonResult,
  resultsDir,
} from "./lib/common.mjs";

const EMBEDDED_PG_DEFAULT_PORT = 5433; // apps/server/src/bootstrap/provisioning.ts EMBEDDED_PG_DEFAULT_PORT
const EMBEDDED_PG_DEFAULT_USERNAME = "loombre"; // packages/provisioning-pg/src/supervisor.ts DEFAULT_USERNAME
const EMBEDDED_PG_DEFAULT_DATABASE = "loombre"; // packages/provisioning-pg/src/supervisor.ts DEFAULT_DATABASE

function resolveEmbeddedPgDatabaseUrl(env, dataDir, args) {
  const secretPath = path.join(dataDir, "postgres", "superuser.secret");
  if (!existsSync(secretPath)) {
    throw new Error(
      `t0-audit: no superuser secret at ${secretPath} — embedded PG has not provisioned yet on this data dir. ` +
        "Start loombre-server.service at least once (with DATABASE_URL unset) before running this wrapper.",
    );
  }
  const secret = readFileSync(secretPath, "utf8").trim();
  const port = args["pg-port"] ?? env["LOOMBRE_EMBEDDED_PG_PORT"] ?? String(EMBEDDED_PG_DEFAULT_PORT);
  const username = EMBEDDED_PG_DEFAULT_USERNAME;
  const database = EMBEDDED_PG_DEFAULT_DATABASE;
  return `postgres://${username}:${encodeURIComponent(secret)}@127.0.0.1:${port}/${database}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const repoCheckout = args["repo-checkout"];
  if (!repoCheckout) {
    throw new Error(
      "t0-audit: --repo-checkout <path> is required — a full Loombre source checkout ON THE N100 " +
        "(pnpm install already run) that `pnpm perf:t0` will be executed from. This is deliberately " +
        "separate from the packaged install at /opt/loombre (that tarball has no dev toolchain/tsx/vitest).",
    );
  }
  if (!existsSync(path.join(repoCheckout, "package.json"))) {
    throw new Error(`t0-audit: ${repoCheckout} does not look like a repo checkout (no package.json)`);
  }

  const hddTmpDir = args["hdd-tmp-dir"];
  if (!hddTmpDir) {
    warn(
      "run-perf-t0",
      "--hdd-tmp-dir not given — scanThroughput will run against whatever os.tmpdir() resolves to by " +
        "default, which is very likely NOT the target HDD (see this file's header). Pass --hdd-tmp-dir to " +
        "make the 'on HDD' qualifier in the budget honest.",
    );
  } else {
    mkdirSync(hddTmpDir, { recursive: true });
  }

  const env = resolveInstallEnv(args);
  const dataDir = resolveDataDir(env);
  const databaseUrl = args["database-url"] ?? resolveEmbeddedPgDatabaseUrl(env, dataDir, args);

  log("run-perf-t0", `repo checkout: ${repoCheckout}`);
  log("run-perf-t0", `DATABASE_URL: postgres://***:***@${databaseUrl.split("@")[1]}`); // never log the secret
  if (hddTmpDir) log("run-perf-t0", `TMPDIR (scanThroughput target): ${hddTmpDir}`);

  const childEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ...(hddTmpDir ? { TMPDIR: hddTmpDir } : {}),
  };

  log("run-perf-t0", "invoking `pnpm perf:t0` (this builds @loombre/server if needed, then runs for several minutes)...");
  const result = spawnSync("pnpm", ["perf:t0"], {
    cwd: repoCheckout,
    env: childEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const perfBaselinePath = path.join(repoCheckout, "perf", "t0-baseline.json");
  let perfBaseline = null;
  if (existsSync(perfBaselinePath)) {
    perfBaseline = JSON.parse(readFileSync(perfBaselinePath, "utf8"));
    const destPath = path.join(resultsDir(args), "perf-t0-baseline.json");
    mkdirSync(path.dirname(destPath), { recursive: true });
    copyFileSync(perfBaselinePath, destPath);
    log("run-perf-t0", `copied ${perfBaselinePath} -> ${destPath}`);
  } else {
    warn("run-perf-t0", `${perfBaselinePath} was not written — perf-t0.mjs likely failed before producing output`);
  }

  const summary = {
    recordedAtMs: Date.now(),
    recordedAtIso: nowIso(),
    repoCheckout,
    hddTmpDir: hddTmpDir ?? null,
    exitCode: result.status,
    perfT0ExitedNonzero: result.status !== 0,
    perfBaseline, // the full perf-t0.mjs output (endpoints p95, scanThroughput, its own idle RSS, breaches[])
    note:
      "perfBaseline.idleRss.* is perf-t0's OWN spawned server+worker, NOT the real systemd units — " +
      "see scripts/t0-audit/rss-sample.mjs for the §9.2 idle-RSS figure this audit actually reports.",
  };
  writeJsonResult(path.join(resultsDir(args), "run-perf-t0-summary.json"), summary);

  if (result.status !== 0) {
    fail("run-perf-t0", `pnpm perf:t0 exited ${result.status} — see its own breach list above (perf-t0.mjs prints breaches before exiting nonzero)`);
    process.exit(result.status ?? 1);
  }
  log("run-perf-t0", "done — pnpm perf:t0 reported all budgets green against the real install's database");
}

main().catch((err) => {
  fail("run-perf-t0", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
