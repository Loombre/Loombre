// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/provisioning-pg/src/exec.ts
//
// The ONLY place this package touches node:child_process. Every bundled
// binary (postgres/initdb/pg_ctl/psql/pg_isready/pg_controldata/pg_dumpall)
// is invoked through one of these two functions — never a `pg`/`kysely`
// driver import (CLAUDE.md invariant 4; depcruise's
// "no-raw-db-driver-outside-packages-db" rule enforces this repo-wide, this
// package simply never gives it anything to fire on).
//
// LD_LIBRARY_PATH/DYLD_LIBRARY_PATH are set defensively to the vendored
// lib/ dir on every invocation. Verified NOT strictly required on this
// lane's darwin-arm64 host (the vendored `postgres` binary resolves its
// bundled dylibs via `@loader_path/../lib/...` rpath entries — confirmed
// with `otool -L`), but costs nothing to set and protects against a
// platform where the rpath-relative resolution doesn't hold (e.g. a future
// linux glibc edge case) — belt-and-suspenders, not load-bearing here.

import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function libraryPathEnv(libDir: string): Record<string, string> {
  return {
    DYLD_LIBRARY_PATH: libDir,
    LD_LIBRARY_PATH: libDir,
  };
}

/**
 * Runs a bundled binary to completion and captures its output. NEVER
 * rejects on a non-zero exit — callers decide what a given exit code means
 * (pg_controldata, for instance, exits non-zero for several DIFFERENT
 * corruption reasons this package must distinguish by parsing stdout/
 * stderr text, not by catching a thrown error). Only rejects on a genuine
 * spawn failure (binary not executable, ENOENT despite binaries.ts's
 * existsSync check racing a deletion, etc).
 */
export async function runBinary(
  binPath: string,
  args: string[],
  opts: { libDir: string; cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, ...libraryPathEnv(opts.libDir) },
      timeout: opts.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; signal?: string };
    if (typeof e.code === "number") {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
    }
    // A string `code` (e.g. "ENOENT") or a signal means the process never
    // produced a normal exit code — a genuine execution failure, not a
    // "ran and returned non-zero" outcome this package can classify.
    throw err;
  }
}

/**
 * Spawns a bundled binary as a long-running supervised child (the
 * `postgres` server process itself — this package spawns it DIRECTLY
 * rather than via `pg_ctl start`'s daemonizing fork, precisely so it holds
 * a real child handle to detect an unexpected exit — see supervisor.ts).
 * Does not wait for readiness; the caller health-polls separately (via
 * runBinary + pg_isready).
 */
export function spawnServer(
  binPath: string,
  args: string[],
  opts: { libDir: string; env?: Record<string, string | undefined> },
): ChildProcess {
  return spawn(binPath, args, {
    env: { ...process.env, ...opts.env, ...libraryPathEnv(opts.libDir) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
