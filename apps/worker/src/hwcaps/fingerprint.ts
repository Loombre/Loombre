// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Invalidation fingerprints (docs/PLAYBACK.md §8.1, STATE.md P3.5):
 *
 *   ffmpeg_build_hash = sha256 of the RESOLVED binary's full `ffmpeg
 *   -version` stdout (covers both the version string and the
 *   `configuration:` line — a rebuild with different `--enable-*` flags at
 *   the SAME version number changes the hash too, which is correct: a
 *   build missing `--enable-videotoolbox` is a materially different
 *   capability surface even at an unchanged version number).
 *
 *   gpu_fingerprint = sha256 of a documented best-effort per-platform
 *   command's output; '' on ANY failure (missing command, non-zero exit,
 *   empty/unhelpful output) — invalidation then keys on ffmpeg_build_hash
 *   alone, never throws, never blocks a boot.
 *
 * Both go through the same injected `CommandRunner` battery.ts's tests do
 * (types.ts) — this file has no direct node:child_process import, keeping
 * it unit-testable with a fake runner exactly like battery.ts.
 */
import { createHash } from "node:crypto";
import type { CommandRunner } from "./types.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const FINGERPRINT_TIMEOUT_MS = 10_000;

/**
 * sha256 of `<ffmpeg> -version`'s full stdout. Throws only if the runner
 * itself throws (it shouldn't — CommandRunner never throws by contract);
 * a non-zero exit or timeout still produces a (different, and therefore
 * still invalidation-correct) hash from whatever stdout was captured, since
 * an ffmpeg that can't even answer `-version` cleanly is itself a
 * meaningful change worth invalidating on.
 */
export async function computeFfmpegBuildHash(runner: CommandRunner, ffmpegPath: string): Promise<string> {
  const result = await runner.run(ffmpegPath, ["-version"], { timeoutMs: FINGERPRINT_TIMEOUT_MS });
  return sha256(result.stdout);
}

interface GpuFingerprintCommand {
  bin: string;
  args: string[];
  /** Post-process stdout before hashing (e.g. Linux's "filtered to VGA/3D
   *  lines" requirement) — identity by default. */
  filter?: (stdout: string) => string;
}

/** Documented best-effort per-platform command (binding constraint 4,
 *  verbatim): darwin -> `system_profiler SPDisplaysDataType -detailLevel
 *  mini`; linux -> `lspci` filtered to VGA/3D lines; win32 -> `wmic path
 *  win32_VideoController get name`. Any platform not in this table (or any
 *  command that fails/times out/produces nothing after filtering) yields
 *  '' — see computeGpuFingerprint. */
const GPU_FINGERPRINT_COMMAND: Partial<Record<NodeJS.Platform, GpuFingerprintCommand>> = {
  darwin: { bin: "system_profiler", args: ["SPDisplaysDataType", "-detailLevel", "mini"] },
  linux: {
    bin: "lspci",
    args: [],
    filter: (stdout) =>
      stdout
        .split("\n")
        .filter((line) => /VGA|3D/i.test(line))
        .join("\n"),
  },
  win32: { bin: "wmic", args: ["path", "win32_VideoController", "get", "name"] },
};

/**
 * sha256 of the platform's best-effort GPU-identifying command output, or
 * '' on any failure (unknown platform, spawn error, non-zero exit, timeout,
 * or — for Linux — a filter that matched zero lines). Never throws.
 */
export async function computeGpuFingerprint(runner: CommandRunner, platform: NodeJS.Platform): Promise<string> {
  const command = GPU_FINGERPRINT_COMMAND[platform];
  if (!command) return "";
  try {
    const result = await runner.run(command.bin, command.args, { timeoutMs: FINGERPRINT_TIMEOUT_MS });
    if (result.timedOut || result.exitCode !== 0) return "";
    const filtered = command.filter ? command.filter(result.stdout) : result.stdout;
    if (filtered.trim() === "") return "";
    return sha256(filtered);
  } catch {
    return "";
  }
}
