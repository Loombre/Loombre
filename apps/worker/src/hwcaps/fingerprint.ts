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
import { BATTERY_RECIPE_VERSION } from "./tables.js";
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
  // The battery recipe version rides along (tables.ts
  // BATTERY_RECIPE_VERSION): what a snapshot proves depends on the argv
  // that produced it as much as on the binary, and a recipe fix must
  // re-verify every install rather than wait for an ffmpeg bump.
  return sha256(`${result.stdout}\nbattery-recipe:${BATTERY_RECIPE_VERSION}`);
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

export interface GpuFingerprintExtras {
  /** Linux only: linux-devices.ts's formatDeviceAccessSummary() — which
   *  GPU device nodes exist and whether THIS process may open them. Folded
   *  into the hash so that an access change (the service account joined
   *  `render`; the NVIDIA driver got installed) invalidates the snapshot
   *  and the next boot re-probes on its own. A fix that leaves a stale
   *  software-only snapshot in place forever is exactly what invalidation
   *  exists to prevent, and lspci's output alone cannot see it — the PCI
   *  bus looks identical before and after `usermod`. Ignored on other
   *  platforms. */
  deviceAccessSummary?: string;
}

/**
 * sha256 of the platform's best-effort GPU-identifying command output, or
 * '' on any failure (unknown platform, spawn error, non-zero exit, timeout,
 * or — for Linux — a filter that matched zero lines). Never throws.
 *
 * Linux additionally hashes `extras.deviceAccessSummary` beneath the
 * filtered lspci lines (see GpuFingerprintExtras); when lspci is unusable
 * but a device summary exists, the summary alone is hashed — a host
 * without pciutils still gets access-change invalidation.
 */
export async function computeGpuFingerprint(
  runner: CommandRunner,
  platform: NodeJS.Platform,
  extras: GpuFingerprintExtras = {},
): Promise<string> {
  const command = GPU_FINGERPRINT_COMMAND[platform];
  if (!command) return "";
  const deviceSummary = platform === "linux" ? (extras.deviceAccessSummary ?? "").trim() : "";
  try {
    const result = await runner.run(command.bin, command.args, { timeoutMs: FINGERPRINT_TIMEOUT_MS });
    const usable = !result.timedOut && result.exitCode === 0;
    const filtered = usable ? (command.filter ? command.filter(result.stdout) : result.stdout) : "";
    const material = [filtered.trim() === "" ? "" : filtered, deviceSummary].filter((part) => part !== "");
    if (material.length === 0) return "";
    return sha256(material.join("\n--devices--\n"));
  } catch {
    return deviceSummary === "" ? "" : sha256(deviceSummary);
  }
}
