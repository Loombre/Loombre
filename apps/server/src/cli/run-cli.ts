// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/run-cli.ts
//
// The `loombre` CLI (docs/PLAN.md §14.1 names the CLI `loombre`; STATE.md
// P4.11 requires --version/--help/paths/doctor). Pure with respect to I/O:
// takes argv + an environment/platform/deps bag, returns
// `{ exitCode, stdout, stderr }` as line arrays — nothing here calls
// process.stdout.write or process.exit directly, so
// apps/server/test/cli/run-cli.spec.ts can assert on exact output without
// spawning a child process. bin/loombre.mjs (the real entrypoint) is the
// only place those side effects happen.

import { LOOMBRE_VERSION_FULL } from "@loombre/shared";
import { resolveAppPaths, toSupportedPlatform, type AppPathsEnv } from "./app-paths.js";
import { runDoctorChecks, type DoctorDeps, type DoctorEnv } from "./doctor.js";

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
  "",
  "Environment overrides:",
  "  LOOMBRE_DATA_DIR, LOOMBRE_CONFIG_DIR   Override the resolved app-data paths",
  "  LOOMBRE_FFMPEG, LOOMBRE_FFPROBE        Point `doctor` at specific binaries",
  "  DATABASE_URL                         Postgres connection string",
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

export function runCli(options: RunCliOptions): CliResult {
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

  const unknownArg = [command, ...rest].filter((a) => a !== undefined).join(" ");
  return {
    exitCode: 1,
    stdout: [],
    stderr: [`loombre: unknown command "${unknownArg}"`, "Run `loombre --help` for usage."],
  };
}
