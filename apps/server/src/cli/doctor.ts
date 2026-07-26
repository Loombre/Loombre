// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/cli/doctor.ts
//
// `loombre doctor` — env sanity checks (mission spec: "DATABASE_URL/ffmpeg
// resolution/data-dir writability — read-only checks only"). Every check
// returns a typed result instead of throwing; the CLI prints all of them
// and exits non-zero only if any check is "fail" (a "warn" is informational
// — e.g. DATABASE_URL unset falls back to the documented dev default,
// which is fine on a dev box, worth flagging on a real install).
//
// "Read-only": no check ever creates, writes, or deletes anything on disk.
// The ffmpeg/ffprobe check DOES spawn the resolved binary with `-version`
// to confirm it's actually invocable (not just a file that exists) — that
// is a read-only *process* interaction, not a filesystem write, and never
// touches ffmpeg's own I/O (no transcode, no probe of real media).
//
// Every dependency this module needs (env, fs stat/access, a process
// spawner) is passed in via a `DoctorEnv`, never read from `process.*`
// directly — keeps every check a pure-ish function of its inputs, so
// apps/server/test/cli/doctor.spec.ts can fake a missing ffmpeg, an
// unwritable directory, etc. without touching the real filesystem or PATH.

import type { AppPathsEnv } from "./app-paths.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheckResult {
  name: string;
  status: DoctorStatus;
  message: string;
}

export interface SpawnVersionResult {
  ok: boolean;
  stdout: string;
}

export interface DoctorEnv extends AppPathsEnv {
  DATABASE_URL?: string | undefined;
  LOOMBRE_FFMPEG?: string | undefined;
  LOOMBRE_FFPROBE?: string | undefined;
  PATH?: string | undefined;
  Path?: string | undefined;
  PATHEXT?: string | undefined;
}

export interface DoctorDeps {
  /** Returns true if `candidate` exists and is executable — mirrors
   *  apps/worker/src/probe/ffprobe.ts's `isExecutableFile` (independently
   *  implemented here: apps/server may not import apps/worker, they're
   *  separate deployable processes). */
  isExecutableFile: (candidate: string) => boolean;
  /** Spawns `binaryPath -version` with a short timeout; never throws. */
  spawnVersion: (binaryPath: string) => SpawnVersionResult;
  /** Returns the nearest existing ancestor directory's writability, and
   *  whether `dir` itself currently exists. Never creates anything. */
  checkWritable: (dir: string) => { exists: boolean; writable: boolean; checkedPath: string };
}

const DEFAULT_DEV_DATABASE_URL = "postgres://loombre:loombre@localhost:5442/loombre";

function checkDatabaseUrl(env: DoctorEnv): DoctorCheckResult {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) {
    return {
      name: "DATABASE_URL",
      status: "warn",
      message: `not set — falling back to the dev default (${DEFAULT_DEV_DATABASE_URL}); set DATABASE_URL for any non-dev install`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { name: "DATABASE_URL", status: "fail", message: `set, but not a valid URL: ${JSON.stringify(raw)}` };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return {
      name: "DATABASE_URL",
      status: "fail",
      message: `set, but scheme is ${JSON.stringify(url.protocol)} (expected postgres:// or postgresql://)`,
    };
  }
  return { name: "DATABASE_URL", status: "ok", message: `set (${url.protocol}//${url.host}${url.pathname})` };
}

function findOnPath(env: DoctorEnv, deps: DoctorDeps, name: string, isWindows: boolean): string | null {
  const pathEnv = env.PATH ?? env.Path ?? "";
  // Delimiter is driven by the TARGET platform being checked, not the host
  // running this process — keeps every branch reachable/testable from any
  // one host OS (apps/server/test/cli/doctor.spec.ts exercises both).
  const delimiter = isWindows ? ";" : ":";
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  const extensions = isWindows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = `${dir}${isWindows ? "\\" : "/"}${name}${ext}`.replace(/[\\/]+/g, isWindows ? "\\" : "/");
      if (deps.isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function checkOneFfBinary(
  label: "ffmpeg" | "ffprobe",
  envVar: "LOOMBRE_FFMPEG" | "LOOMBRE_FFPROBE",
  env: DoctorEnv,
  deps: DoctorDeps,
  isWindows: boolean,
): DoctorCheckResult {
  const override = env[envVar]?.trim();
  let resolved: { path: string; source: "env" | "path" } | null = null;

  if (override) {
    if (deps.isExecutableFile(override)) {
      resolved = { path: override, source: "env" };
    } else {
      return {
        name: label,
        status: "fail",
        message: `${envVar}=${JSON.stringify(override)} does not point at an executable file`,
      };
    }
  } else {
    const onPath = findOnPath(env, deps, label, isWindows);
    if (onPath) resolved = { path: onPath, source: "path" };
  }

  if (!resolved) {
    return {
      name: label,
      status: "fail",
      message: `not found — set ${envVar} or add ${label} to PATH`,
    };
  }

  const versionCheck = deps.spawnVersion(resolved.path);
  if (!versionCheck.ok) {
    return {
      name: label,
      status: "warn",
      message: `resolved via ${resolved.source} (${resolved.path}) but failed to run "-version" — binary may be corrupt or incompatible`,
    };
  }

  const firstLine = versionCheck.stdout.split("\n")[0]?.trim() ?? "";
  return {
    name: label,
    status: "ok",
    message: `resolved via ${resolved.source} (${resolved.path})${firstLine ? ` — ${firstLine}` : ""}`,
  };
}

function checkDataDirWritable(dir: string, deps: DoctorDeps): DoctorCheckResult {
  const result = deps.checkWritable(dir);
  if (!result.writable) {
    return {
      name: "data directory writability",
      status: "fail",
      message: `${dir} — nearest existing ancestor (${result.checkedPath}) is not writable`,
    };
  }
  return {
    name: "data directory writability",
    status: "ok",
    message: result.exists ? `${dir} exists and is writable` : `${dir} does not exist yet, but its parent is writable (will be created on first run)`,
  };
}

/** Runs every doctor check and returns them in a fixed, stable order. */
export function runDoctorChecks(
  env: DoctorEnv,
  deps: DoctorDeps,
  nodePlatform: NodeJS.Platform,
  dataDir: string,
): DoctorCheckResult[] {
  const isWindows = nodePlatform === "win32";
  return [
    checkDatabaseUrl(env),
    checkOneFfBinary("ffmpeg", "LOOMBRE_FFMPEG", env, deps, isWindows),
    checkOneFfBinary("ffprobe", "LOOMBRE_FFPROBE", env, deps, isWindows),
    checkDataDirWritable(dataDir, deps),
  ];
}
