// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The REAL `CommandRunner` (docs/PLAYBACK.md §8.1, binding constraint 1: "a
 * real runner reusing the probe pipeline's resolution + spawn
 * conventions"). Mirrors apps/worker/src/probe/ffprobe.ts's runFfprobe()
 * spawn discipline (timeout -> SIGKILL, stderr tail capture, the win32
 * .cmd/.bat shell:true fix for CVE-2024-27980) and additionally kills the
 * whole process GROUP on timeout (binding constraint 2: "20s timeout per
 * test (kill process group; timeout = absent)") — ffmpeg's own child
 * processes (rare, but some hwaccel backends spawn helper processes) must
 * not survive a killed test.
 *
 * This file is the ONLY place in apps/worker/src/hwcaps that imports
 * node:child_process — battery.ts and every ffmpeg-argv builder consume
 * the injected `CommandRunner` interface (types.ts) instead, so unit tests
 * substitute a fake implementation and never spawn a real process.
 */
import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner, RunCommandOptions } from "./types.js";

const STDERR_TAIL_BYTES = 4096;

/**
 * True process-group kill on POSIX (negative pid signals the whole
 * group — requires `detached: true` at spawn time so the child becomes its
 * own group leader); plain `child.kill()` on win32, matching
 * runFfprobe.ts's own platform split (Windows process groups work
 * differently and job-object-based suspension is handled elsewhere,
 * docs/PLAYBACK.md §9 — this is just the self-test's kill-on-timeout, not
 * that mechanism).
 */
function killProcessGroup(pid: number): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may have already exited between the timeout firing and
      // this call — not an error condition for a timeout-classified test.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group kill can fail if the child was never truly detached (e.g. a
    // sandboxed CI runner) — fall back to a direct signal so the test
    // still resolves as a timeout rather than hanging forever.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function createRealCommandRunner(): CommandRunner {
  return {
    run(bin: string, args: string[], options: RunCommandOptions): Promise<CommandResult> {
      // Same class of fix as runFfprobe.ts/scripts/gen-media-fixtures.mjs's
      // Windows .cmd-shim handling (CVE-2024-27980: Node refuses to spawn a
      // batch file without a shell on win32).
      const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);

      return new Promise<CommandResult>((resolve) => {
        let child;
        try {
          child = spawn(bin, args, {
            stdio: ["ignore", "pipe", "pipe"],
            shell: useShell,
            // detached so POSIX can signal the whole process group on
            // timeout (see killProcessGroup above); harmless on win32
            // where killProcessGroup ignores the group semantics anyway.
            detached: process.platform !== "win32",
          });
        } catch (err) {
          resolve({
            stdout: "",
            stderr: `spawn failed: ${(err as Error).message}`,
            exitCode: null,
            timedOut: false,
          });
          return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (child.pid !== undefined) killProcessGroup(child.pid);
          resolve({
            stdout,
            stderr: stderr.slice(-STDERR_TAIL_BYTES),
            exitCode: null,
            timedOut: true,
          });
        }, options.timeoutMs);

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
          resolve({
            stdout,
            stderr: `${stderr}\nprocess error: ${err.message}`.slice(-STDERR_TAIL_BYTES),
            exitCode: null,
            timedOut: false,
          });
        });

        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            stdout,
            stderr,
            exitCode,
            timedOut: false,
          });
        });
      });
    },
  };
}
