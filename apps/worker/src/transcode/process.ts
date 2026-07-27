// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ffmpeg process supervision for ONE run of a transcode session: spawn,
 * SIGSTOP/SIGCONT throttle suspend/resume (POSIX), graceful-then-forceful
 * kill (seek-restart/teardown), and a 4 KB stderr ring buffer (docs/
 * PLAYBACK.md §9 audit requirement — "ffmpeg stderr tail (last 4KB ring)
 * stored on failure").
 *
 * Mirrors apps/worker/src/hwcaps/command-runner.ts's spawn/process-group
 * conventions (detached:true on POSIX so the whole process group can be
 * signaled — some hwaccel backends spawn helper processes; the win32
 * .cmd/.bat shell:true fix, irrelevant here since ffmpeg itself is never a
 * batch shim, kept for parity with every other spawn site in this repo)
 * but is a fundamentally different SHAPE: command-runner.ts runs a probe
 * to COMPLETION and resolves once; this module supervises a LONG-RUNNING
 * process across an unbounded number of suspend/resume cycles, so it
 * returns a live handle + a completion promise rather than a single
 * result object.
 *
 * `spawnFn` is injectable (defaults to node:child_process's real `spawn`)
 * so unit tests can substitute a fake child process without touching a
 * real ffmpeg binary — this module's own unit tests do exactly that;
 * apps/worker/test/transcode/*.integration.spec.ts use the real thing.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

const STDERR_TAIL_BYTES = 4096;
const GRACEFUL_TERM_TIMEOUT_MS = 2_000;

export type SpawnFn = typeof nodeSpawn;

export interface FfmpegRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when this process was killed BY US (terminate() was called) —
   *  the caller (runner.ts) uses this to distinguish "we killed it on
   *  purpose" (seek-restart, teardown) from a genuine ffmpeg failure
   *  (binding constraint 7: "ffmpeg non-zero exit (not caused by our
   *  kill)"). */
  killedByUs: boolean;
  stderrTail: string;
}

export interface FfmpegRunHandle {
  readonly pid: number | undefined;
  /** Resolves exactly once, when the process has fully exited. */
  readonly result: Promise<FfmpegRunResult>;
  /** SIGSTOP the whole process group (POSIX only — a no-op on win32,
   *  which uses -readrate pacing instead, never real suspension; see
   *  throttle.ts's header for the platform decision, P3.8). Safe to call
   *  redundantly (already-stopped process — POSIX SIGSTOP is idempotent). */
  suspend(): void;
  /** SIGCONT the whole process group (POSIX only, no-op on win32). Safe to
   *  call redundantly. */
  resume(): void;
  /** SIGCONT (see the implementation's comment — a throttle-suspended run
   *  must be resumed first or the graceful term below cannot work), then a
   *  graceful SIGTERM, escalating to a process-group SIGKILL after
   *  `GRACEFUL_TERM_TIMEOUT_MS` if the process hasn't exited by then
   *  (binding constraint 5: "kill (SIGKILL after graceful term attempt
   *  with short timeout)"). Resolves once the process has actually
   *  exited. Idempotent — calling this twice, or after the process has
   *  already exited on its own, is a no-op. */
  terminate(): Promise<void>;
  /** Current stderr tail (last 4 KB) — readable before exit too, so a
   *  caller can snapshot diagnostics without waiting. */
  stderrTail(): string;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export interface SpawnFfmpegRunOptions {
  cwd: string;
  spawnFn?: SpawnFn;
}

/**
 * Spawns one ffmpeg run. `args` must already have every docs/PLAYBACK.md
 * §6 token substituted (this module knows nothing about tokens — see
 * args.ts) — `cwd` is where ffmpeg resolves ITS OWN relative output paths
 * from (the builder's `-hls_fmp4_init_filename init.mp4` is relative by
 * construction, args.ts's header explains why this matters).
 */
export function spawnFfmpegRun(ffmpegPath: string, args: string[], options: SpawnFfmpegRunOptions): FfmpegRunHandle {
  const spawnImpl = options.spawnFn ?? nodeSpawn;

  const child: ChildProcess = spawnImpl(ffmpegPath, args, {
    cwd: options.cwd,
    stdio: ["ignore", "ignore", "pipe"],
    // Process-group detach on POSIX only, mirroring command-runner.ts —
    // lets suspend()/resume()/terminate() signal the whole group (some
    // hwaccel backends spawn helper processes).
    detached: process.platform !== "win32",
  });

  let stderr = "";
  let killedByUs = false;
  let terminated = false;

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });

  const result = new Promise<FfmpegRunResult>((resolvePromise) => {
    child.on("close", (exitCode, signal) => {
      resolvePromise({ exitCode, signal, killedByUs, stderrTail: stderr });
    });
    child.on("error", () => {
      // spawn-failed or similar — exitCode stays null, treated as a
      // failure by the caller exactly like a nonzero exit.
      resolvePromise({ exitCode: null, signal: null, killedByUs, stderrTail: stderr });
    });
  });

  return {
    get pid() {
      return child.pid;
    },
    result,
    suspend() {
      if (child.pid === undefined) return;
      killProcessGroup(child.pid, "SIGSTOP");
    },
    resume() {
      if (child.pid === undefined) return;
      killProcessGroup(child.pid, "SIGCONT");
    },
    async terminate() {
      if (terminated) {
        await result;
        return;
      }
      terminated = true;
      killedByUs = true;
      if (child.pid !== undefined) {
        // SIGCONT FIRST, unconditionally: ffmpeg installs a SIGTERM handler,
        // and a SIGSTOPped process never runs one — the signal just stays
        // pending until it is continued, so a term of a throttle-suspended
        // run (runner.ts's seek-restart and teardown paths both reach here
        // with the group stopped) would sit out the full graceful window and
        // die by SIGKILL. Harmless on a process that was never stopped, and
        // already a documented no-op on win32 (killProcessGroup above).
        killProcessGroup(child.pid, "SIGCONT");
        killProcessGroup(child.pid, "SIGTERM");
      }
      const timedOutTerm = await Promise.race([
        result.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), GRACEFUL_TERM_TIMEOUT_MS)),
      ]);
      if (timedOutTerm && child.pid !== undefined) {
        killProcessGroup(child.pid, "SIGKILL");
      }
      await result;
    },
    stderrTail() {
      return stderr;
    },
  };
}
