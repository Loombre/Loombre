// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/run-cli.ts
//
// The `loombre` CLI (docs/PLAN.md §14.1 names the CLI `loombre`; STATE.md
// P4.11 requires --version/--help/paths/doctor; H2 adds `admin reset-pin`).
// Pure with respect to I/O: takes argv + an environment/platform/deps bag,
// returns `{ exitCode, stdout, stderr }` as line arrays — nothing here calls
// process.stdout.write or process.exit directly, so
// apps/server/test/cli/run-cli.spec.ts can assert on exact output without
// spawning a child process. bin/loombre.mjs (the real entrypoint) is the
// only place those side effects happen.
//
// B-1 (H2, owner brief): ASYNC (Promise<CliResult>) so the `admin` branch
// can dynamically `import("@loombre/db")` (admin-reset-pin.ts's own header)
// — every other branch below still resolves synchronously in practice, but
// the signature is uniformly async so callers (bin/loombre.mjs, this
// file's own tests) never need to know which branch they're calling.
// --version/--help/paths/doctor load NO database code at all, still —
// only `admin reset-pin` needs a reachable Postgres (see bin/loombre.mjs's
// header for the updated claim).

import { LOOMBRE_VERSION_FULL } from "@loombre/shared";
import { resolveAppPaths, toSupportedPlatform, type AppPathsEnv } from "./app-paths.js";
import { runDoctorChecks, type DoctorDeps, type DoctorEnv } from "./doctor.js";
import { runAdminCommand, type AdminDeps } from "./admin-reset-pin.js";

export interface CliResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

export interface RunCliOptions {
  argv: string[];
  env: DoctorEnv;
  nodePlatform: NodeJS.Platform;
  doctorDeps: DoctorDeps;
  adminDeps: AdminDeps;
}

const HELP_TEXT = [
  "loombre — Loombre media server CLI",
  "",
  "Usage: loombre <command> [options]",
  "",
  "Commands:",
  "  (none) | --help, -h    Show this help",
  "  --version, -v          Print the running server version",
  "  paths                  Print resolved data/config directories",
  "  doctor                 Run read-only environment sanity checks",
  "  admin reset-pin <username>",
  "                          Clear a user's restricted-content PIN/opt-in",
  "                          (recovery for a forgotten PIN). Interactive",
  "                          confirmation required; needs DATABASE_URL /",
  "                          a reachable Postgres — every other command",
  "                          above does not.",
  "  admin reset-password <username>",
  "                          Set a random temporary password for a user",
  "                          (recovery for a forgotten password), shown",
  "                          once. Interactive confirmation required;",
  "                          needs DATABASE_URL / a reachable Postgres.",
  "",
  "Environment overrides:",
  "  LOOMBRE_DATA_DIR, LOOMBRE_CONFIG_DIR   Override the resolved app-data paths",
  "  LOOMBRE_FFMPEG, LOOMBRE_FFPROBE        Point `doctor` at specific binaries",
  "  DATABASE_URL                         Postgres connection string (required for `admin`)",
];

const STATUS_GLYPH: Record<string, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]" };

function printPaths(env: AppPathsEnv, nodePlatform: NodeJS.Platform): string[] {
  const resolved = resolveAppPaths(nodePlatform, env);
  const platform = toSupportedPlatform(nodePlatform);
  return [
    `platform:   ${platform}`,
    `data dir:   ${resolved.dataDir} (${resolved.dataDirSource === "env" ? "LOOMBRE_DATA_DIR" : "default"})`,
    `config dir: ${resolved.configDir} (${resolved.configDirSource === "env" ? "LOOMBRE_CONFIG_DIR" : "default"})`,
  ];
}

function runDoctor(env: DoctorEnv, deps: DoctorDeps, nodePlatform: NodeJS.Platform): { lines: string[]; ok: boolean } {
  const resolved = resolveAppPaths(nodePlatform, env);
  const results = runDoctorChecks(env, deps, nodePlatform, resolved.dataDir);
  const lines = results.map((r) => `${STATUS_GLYPH[r.status] ?? r.status} ${r.name}: ${r.message}`);
  const anyFail = results.some((r) => r.status === "fail");
  lines.push("");
  lines.push(anyFail ? "doctor: FAIL — one or more checks failed" : "doctor: PASS");
  return { lines, ok: !anyFail };
}

export async function runCli(options: RunCliOptions): Promise<CliResult> {
  const [command, ...rest] = options.argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return { exitCode: 0, stdout: [...HELP_TEXT], stderr: [] };
  }

  if (command === "--version" || command === "-v" || command === "version") {
    return { exitCode: 0, stdout: [`Loombre ${LOOMBRE_VERSION_FULL}`], stderr: [] };
  }

  if (command === "paths") {
    return { exitCode: 0, stdout: printPaths(options.env, options.nodePlatform), stderr: [] };
  }

  if (command === "doctor") {
    const { lines, ok } = runDoctor(options.env, options.doctorDeps, options.nodePlatform);
    return { exitCode: ok ? 0 : 1, stdout: lines, stderr: [] };
  }

  if (command === "admin") {
    return runAdminCommand(rest, options.adminDeps);
  }

  const unknownArg = [command, ...rest].filter((a) => a !== undefined).join(" ");
  return {
    exitCode: 1,
    stdout: [],
    stderr: [`loombre: unknown command "${unknownArg}"`, "Run `loombre --help` for usage."],
  };
}
