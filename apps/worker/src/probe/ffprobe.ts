// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ffprobe/ffmpeg binary resolution + the ffprobe spawn wrapper.
 *
 * This is the ONLY place in the probe pipeline that touches the
 * filesystem/process table. `resolveFfprobe`/`resolveFfmpeg` never throw and
 * do zero work at import time (P1.9 spirit) — a missing binary is a typed,
 * reportable `ProbeError`, returned in a result object, not a crash. Nothing
 * else in apps/worker/src/probe spawns ffmpeg; CLAUDE.md invariant 6 (long-
 * running work goes through the job queue) governs actual transcode
 * invocation, which lives in the future job consumer, not here.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { ProbeError } from "./errors.js";
import type { RawProbeResult } from "./types.js";

export interface ResolvedBinary {
  /** Absolute (or as-given) path to the resolved executable. */
  path: string;
  /** Where the path came from: the env var override, or a PATH scan. */
  source: "env" | "path";
}

export type ResolveBinaryResult =
  | { ok: true; binary: ResolvedBinary }
  | { ok: false; error: ProbeError };

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Scan PATH for an executable named `name` (with platform executable
 * extensions on Windows via PATHEXT). Returns null, never throws. */
function findOnPath(name: string): string | null {
  const pathEnv = process.env["PATH"] ?? process.env["Path"] ?? "";
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  const extensions =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveBinary(envVar: string, name: string): ResolveBinaryResult {
  const envPath = process.env[envVar];
  if (envPath) {
    if (isExecutableFile(envPath)) {
      return { ok: true, binary: { path: envPath, source: "env" } };
    }
    return {
      ok: false,
      error: new ProbeError(
        "binary-not-found",
        `${envVar} is set to '${envPath}' but that path is not an executable file`,
        { envVar, envPath },
      ),
    };
  }

  const found = findOnPath(name);
  if (found) {
    return { ok: true, binary: { path: found, source: "path" } };
  }
  return {
    ok: false,
    error: new ProbeError(
      "binary-not-found",
      `'${name}' was not found on PATH and ${envVar} is not set`,
      { envVar, name },
    ),
  };
}

/** Resolve the ffprobe binary: `LOOMBRE_FFPROBE` env var first, else a PATH
 * lookup for 'ffprobe'. Never throws; absence is a typed result. */
export function resolveFfprobe(): ResolveBinaryResult {
  return resolveBinary("LOOMBRE_FFPROBE", "ffprobe");
}

/** Resolve the ffmpeg binary: `LOOMBRE_FFMPEG` env var first, else a PATH
 * lookup for 'ffmpeg'. Never throws; absence is a typed result. Used by the
 * fixture generator and (in Phase 1+) the transcode job consumer — never
 * spawned inline from a request path. */
export function resolveFfmpeg(): ResolveBinaryResult {
  return resolveBinary("LOOMBRE_FFMPEG", "ffmpeg");
}

export interface RunFfprobeOptions {
  /** Hard kill timeout in milliseconds. Default 20_000, matching the
   * PLAYBACK.md §8.1 self-test budget (20 s per capability test). */
  timeoutMs?: number;
  /** Explicit ffprobe binary path, bypassing resolveFfprobe(). Mainly for
   * tests. */
  ffprobePath?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const STDERR_TAIL_BYTES = 4096;

/**
 * Spawn `ffprobe -v error -print_format json -show_format -show_streams
 * -show_chapters <path>` and return the parsed raw JSON.
 *
 * `-show_streams` includes `side_data_list` automatically for any stream
 * that carries side data (Dolby Vision configuration records, display
 * matrices, etc.) — no extra flag needed; verified against a real ffprobe
 * 8.1.1 build while building the extraction rules in extract.ts.
 *
 * Failure modes are all typed `ProbeError`s: binary missing, spawn failure,
 * timeout (process is SIGKILLed), non-zero exit (stderr tail attached,
 * mirroring the 4 KB ring PLAYBACK.md §9 uses for ffmpeg failures), or
 * unparseable stdout.
 */
export async function runFfprobe(
  filePath: string,
  options: RunFfprobeOptions = {},
): Promise<RawProbeResult> {
  let ffprobePath = options.ffprobePath;
  if (!ffprobePath) {
    const resolved = resolveFfprobe();
    if (!resolved.ok) {
      throw resolved.error;
    }
    ffprobePath = resolved.binary.path;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-show_chapters",
    filePath,
  ];

  // Windows refuses to spawn a .cmd/.bat batch shim without a shell since
  // the CVE-2024-27980 fix (spawn() throws EINVAL). ffprobe itself ships as
  // an .exe (spawned directly, shell:false), but LOOMBRE_FFPROBE may legally
  // point at a .cmd wrapper — and our own test shim is one — so on win32 a
  // batch target is spawned through the shell. Same class as the Phase 0
  // pnpm .cmd-shim fix; POSIX and .exe stay shell:false. filePath here is a
  // library path we produced, not untrusted input, but shell:true is
  // deliberately scoped to the batch-target case only to keep the surface
  // minimal.
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(ffprobePath);

  return await new Promise<RawProbeResult>((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"], shell: useShell });
    } catch (err) {
      reject(
        new ProbeError("spawn-failed", `failed to spawn ffprobe: ${(err as Error).message}`, {
          filePath,
          ffprobePath,
        }),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new ProbeError("timeout", `ffprobe timed out after ${timeoutMs}ms probing '${filePath}'`, {
          filePath,
          timeoutMs,
        }),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ProbeError("spawn-failed", `ffprobe process error: ${err.message}`, {
          filePath,
          ffprobePath,
        }),
      );
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (exitCode !== 0) {
        reject(
          new ProbeError("nonzero-exit", `ffprobe exited ${exitCode} probing '${filePath}'`, {
            filePath,
            exitCode,
            stderrTail: stderr.slice(-STDERR_TAIL_BYTES),
          }),
        );
        return;
      }

      try {
        resolvePromise(JSON.parse(stdout) as RawProbeResult);
      } catch (err) {
        reject(
          new ProbeError("invalid-json", `ffprobe produced unparseable JSON: ${(err as Error).message}`, {
            filePath,
            stdoutTail: stdout.slice(-2048),
          }),
        );
      }
    });
  });
}
