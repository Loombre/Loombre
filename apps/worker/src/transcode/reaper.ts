// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Boot-time orphaned-ffmpeg reaper (process-lifecycle hardening wave,
 * 2026-08-11, item C2). Runs once at worker start, alongside the
 * job-ledger reconciliation in apps/worker/src/index.ts.
 *
 * WHAT IT IS FOR. run-registry.ts (item C1) handles the graceful case: a
 * worker that gets to run its shutdown handler kills its ffmpeg children
 * before exiting. This handles the case it structurally cannot — SIGKILL,
 * an OOM kill, a power cut, a container stop that skips straight to
 * SIGKILL. No shutdown code runs, and because every run is spawned
 * `detached: true` on POSIX (process.ts) the ffmpeg keeps encoding at full
 * rate with nothing left to throttle it (docs/PLAYBACK.md §9's ahead>10
 * SIGSTOP needs a live supervisor), seek it, or end it. Worse, its
 * admission slot is freed the moment the server's heartbeat sweeper ends
 * the session — countActiveTranscodeSessions counts only non-terminal rows
 * — so the next viewer is admitted ON TOP of a process still burning a
 * core. On Tier-0 hardware (N100/4GB) two of those is the machine.
 *
 * The only thing that survives a hard kill is the database row, which is
 * why migrations/0041 puts the pid there.
 *
 * WHAT COUNTS AS AN ORPHAN. Any non-terminal session whose recorded
 * worker generation predates the booting worker — including one whose
 * ffmpeg is alive and healthy. "Still running" is not "still supervised":
 * its supervisor is dead, so it will never be throttled, seeked, or
 * ended, and its session cannot be resumed (the runner's whole state
 * machine, served-playlist folding included, lived in the dead process).
 * Reaping it costs the viewer one restart of playback; leaving it costs
 * the box.
 *
 * VERIFICATION IS PID + CMDLINE, NEVER PID ALONE. Pids are reused, and on
 * a machine that has rebooted since the crash, pid 4242 is overwhelmingly
 * likely to be something else entirely. SIGKILLing an unrelated process
 * would be a far worse bug than the one being fixed, so this module only
 * ever signals a process whose command line actually contains the
 * session's own staging directory (a path that carries the session id —
 * see staging.ts). An unverifiable pid — no cmdline readable, no staging
 * dir recorded — is never signaled; the session is still reclaimed,
 * because its supervisor is gone either way.
 *
 * NO NEW NATIVE DEPENDENCY (this repo's standing constraint for process
 * inspection — see hwcaps/command-runner.ts and throttle.ts's win32
 * decision for the same posture): /proc/<pid>/cmdline where it exists
 * (Linux), `ps -o args=` where it does not (darwin has no /proc),
 * tasklist + wmic on Windows. Every one of those is injected through
 * ProcessInspector so the decision logic above is testable without
 * spawning anything.
 */
import { execFile } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface ProcessInspection {
  alive: boolean;
  /** The process's full command line, when the platform could produce
   *  one. `undefined` means "could not be read" (permission, an
   *  unsupported platform, a truncating tool) — NEVER "empty command
   *  line", because the difference decides whether a kill is allowed. */
  commandLine?: string;
}

export interface ProcessInspector {
  inspect(pid: number): Promise<ProcessInspection>;
  /** SIGKILL the whole process GROUP (negative pid on POSIX — runs are
   *  spawned detached; `taskkill /T` on win32). */
  killGroup(pid: number): Promise<void>;
}

/** One row of the reaper's candidate set — the shape
 *  packages/db's listReapableTranscodeSessions returns, renamed to this
 *  module's own vocabulary at the call boundary. */
export interface ReapableSession {
  id: string;
  workerPid: number;
  workerStartedAtMs: number | null;
  stagingDir: string | null;
}

export type ReapOutcome =
  /** Verified as this session's ffmpeg and still alive — SIGKILLed. */
  | "killed"
  /** The pid is not running any more; nothing to kill. */
  | "already-gone"
  /** A live process, but demonstrably NOT this session's ffmpeg — the pid
   *  was reused. Never signaled. */
  | "pid-reused"
  /** A live process whose identity could not be established either way.
   *  Never signaled (the conservative direction). */
  | "unverified";

export interface ReapedSession {
  sessionId: string;
  workerPid: number;
  outcome: ReapOutcome;
}

export interface ReapOrphanedTranscodeSessionsDeps {
  /** Candidate set. Injected rather than taking a `db` so the decision
   *  logic is unit-testable with no database at all; index.ts binds it to
   *  listReapableTranscodeSessions. */
  listReapable: () => Promise<ReapableSession[]>;
  /** Marks the session failed (index.ts binds markSessionFailed). */
  failSession: (sessionId: string, stderrTail: string) => Promise<void>;
  inspector: ProcessInspector;
  /** THIS worker process's start time — the generation horizon. */
  workerStartedAtMs: number;
  nowMs?: () => number;
  /** How long to wait for a killed process to actually disappear before
   *  giving up and reclaiming the row anyway. See waitForRunExit below for
   *  why this wait exists at all. */
  exitWaitTimeoutMs?: number;
  /** Test seam for that wait. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_EXIT_WAIT_TIMEOUT_MS = 5_000;
const EXIT_WAIT_POLL_MS = 50;

/** Plain language on purpose: this string lands in
 *  `playback_sessions.stderr_tail`, which is surfaced to operators (admin
 *  sessions panel) and can reach a user-visible error path. No
 *  reaper/orphan/ledger jargon. */
function reclaimedMessage(pid: number, outcome: ReapOutcome): string {
  const fate =
    outcome === "killed"
      ? `The leftover video process (id ${pid}) was stopped.`
      : outcome === "already-gone"
        ? "Its video process was already gone."
        : `Its video process (id ${pid}) could not be identified, so it was left alone.`;
  return (
    "This playback session was interrupted — the background worker stopped while it was running. " +
    `${fate} Start playback again to resume.`
  );
}

/**
 * Waits until `pid` is no longer running this session's ffmpeg.
 *
 * WHY THIS EXISTS — it is the difference between the fix working and only
 * appearing to. Signal delivery is asynchronous: `kill(2)` returns as soon
 * as the signal is queued, not when the target has died. Without this
 * wait, the reaper marked the session terminal (which is exactly what
 * frees its admission slot — countActiveTranscodeSessions counts only
 * non-terminal rows) while the process it had just SIGKILLed was still
 * scheduled. That window is small, but it is the SAME window the whole
 * item exists to close: a slot handed to the next viewer on top of a
 * process still holding a core. Caught by lifecycle.integration.spec.ts
 * scenario (c), which asserts the ordering from inside the transition.
 *
 * "Gone" is deliberately `not alive OR no longer running this session's
 * ffmpeg`, not `not alive` alone: a killed process can linger briefly as a
 * zombie (an un-reaped entry that holds no CPU and no memory), which some
 * platforms still report as a process. A zombie has no command line, so
 * the cmdline predicate settles it correctly and platform-independently.
 */
async function waitForRunExit(
  inspector: ProcessInspector,
  pid: number,
  stagingDir: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  nowMs: () => number,
): Promise<boolean> {
  const deadline = nowMs() + timeoutMs;
  for (;;) {
    let gone: boolean;
    try {
      const inspection = await inspector.inspect(pid);
      gone = !inspection.alive || !(inspection.commandLine ?? "").includes(stagingDir);
    } catch {
      gone = true; // cannot see it any more — treat as gone rather than spin
    }
    if (gone) return true;
    if (nowMs() >= deadline) return false;
    await sleep(EXIT_WAIT_POLL_MS);
  }
}

/**
 * Reclaims every session orphaned by a previous worker generation.
 *
 * Never throws: like every other boot step in apps/worker/src/index.ts, a
 * failure here is logged by the caller and must not stop the worker from
 * coming up. One session's failure never aborts the sweep either — the
 * whole point is to clean up ALL of them.
 */
export async function reapOrphanedTranscodeSessions(
  deps: ReapOrphanedTranscodeSessionsDeps,
): Promise<ReapedSession[]> {
  const candidates = await deps.listReapable();
  const reaped: ReapedSession[] = [];
  const nowMs = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exitWaitTimeoutMs = deps.exitWaitTimeoutMs ?? DEFAULT_EXIT_WAIT_TIMEOUT_MS;

  for (const session of candidates) {
    // Defense in depth: the query already applies the generation horizon,
    // but a row this process itself wrote must never be reaped even if a
    // caller passes a sloppier candidate set.
    if (session.workerStartedAtMs !== null && session.workerStartedAtMs >= deps.workerStartedAtMs) continue;

    let outcome: ReapOutcome;
    try {
      const inspection = await deps.inspector.inspect(session.workerPid);
      if (!inspection.alive) {
        outcome = "already-gone";
      } else if (inspection.commandLine === undefined || session.stagingDir === null) {
        outcome = "unverified";
      } else if (inspection.commandLine.includes(session.stagingDir)) {
        await deps.inspector.killGroup(session.workerPid);
        // The session must not become terminal — freeing its admission
        // slot — until the process is actually gone (waitForRunExit's
        // header).
        await waitForRunExit(deps.inspector, session.workerPid, session.stagingDir, exitWaitTimeoutMs, sleep, nowMs);
        outcome = "killed";
      } else {
        outcome = "pid-reused";
      }
    } catch {
      // Inspection itself blew up — treat the process as unidentifiable
      // and, per this module's header, never signal it.
      outcome = "unverified";
    }

    try {
      await deps.failSession(session.id, reclaimedMessage(session.workerPid, outcome));
    } catch {
      // The row could not be updated (a racing close, a database blip).
      // The process half already happened and is the part that matters;
      // this session simply gets another chance on the next boot.
      continue;
    }
    reaped.push({ sessionId: session.id, workerPid: session.workerPid, outcome });
  }

  return reaped;
}

// ---------------------------------------------------------------------------
// The real, platform-specific inspector.
// ---------------------------------------------------------------------------

export interface CreateProcessInspectorOptions {
  platform: NodeJS.Platform;
  /** Whether /proc is actually mounted. Defaults to a real existsSync
   *  probe rather than a platform guess: Linux is the normal case, but a
   *  minimal container can lack it. */
  hasProc?: boolean;
  /** Test seams. */
  readFile?: (path: string) => Promise<Buffer>;
  runCommand?: (command: string, args: string[]) => Promise<{ status: number; stdout: string }>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

function defaultRunCommand(command: string, args: string[]): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        const status = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code || 1) : 1;
        resolve({ status, stdout: stdout ?? "" });
        return;
      }
      resolve({ status: 0, stdout: stdout ?? "" });
    });
  });
}

export function createProcessInspector(options: CreateProcessInspectorOptions): ProcessInspector {
  const platform = options.platform;
  const hasProc = options.hasProc ?? (platform === "linux" && existsSync("/proc/self/cmdline"));
  const readFile = options.readFile ?? ((path: string) => fsReadFile(path));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));

  async function inspectProc(pid: number): Promise<ProcessInspection> {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`);
      // /proc cmdline is NUL-separated with a trailing NUL.
      const commandLine = raw.toString("utf8").split("\0").filter(Boolean).join(" ");
      return { alive: true, commandLine };
    } catch {
      // ENOENT means the process is gone; anything else (EACCES on a
      // differently-owned process) means we cannot identify it. Both are
      // handled correctly by the caller if we distinguish them, but /proc
      // ENOENT is by far the dominant case and `ps` below is the honest
      // second opinion for the rest.
      const ps = await runCommand("ps", ["-p", String(pid), "-o", "pid="]);
      if (ps.status !== 0 || ps.stdout.trim() === "") return { alive: false };
      return { alive: true };
    }
  }

  async function inspectPs(pid: number): Promise<ProcessInspection> {
    // `-ww` widens the output so a long ffmpeg command line is not
    // truncated at terminal width — the staging-dir match depends on it.
    const result = await runCommand("ps", ["-ww", "-p", String(pid), "-o", "args="]);
    if (result.status !== 0) return { alive: false };
    const commandLine = result.stdout.trim();
    if (commandLine === "") return { alive: false };
    return { alive: true, commandLine };
  }

  async function inspectWindows(pid: number): Promise<ProcessInspection> {
    const listed = await runCommand("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    // tasklist exits 0 even when nothing matched, printing an INFO line —
    // the pid appearing in a CSV row is the real liveness signal.
    if (listed.status !== 0 || !listed.stdout.includes(`"${pid}"`)) return { alive: false };

    // tasklist knows the image name but never the command line; WMI does.
    const wmic = await runCommand("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/format:list"]);
    if (wmic.status === 0) {
      const match = /CommandLine=(.*)/.exec(wmic.stdout);
      const commandLine = match?.[1]?.trim();
      if (commandLine) return { alive: true, commandLine };
    }
    // wmic is deprecated and absent on some builds — PowerShell's CIM
    // provider is the supported replacement. Still no native dependency.
    const cim = await runCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    const psCommandLine = cim.status === 0 ? cim.stdout.trim() : "";
    return psCommandLine ? { alive: true, commandLine: psCommandLine } : { alive: true };
  }

  return {
    async inspect(pid: number): Promise<ProcessInspection> {
      if (platform === "win32") return inspectWindows(pid);
      if (hasProc) return inspectProc(pid);
      return inspectPs(pid);
    },
    async killGroup(pid: number): Promise<void> {
      if (platform === "win32") {
        // /T kills the whole tree, /F forces it — the win32 equivalent of
        // signaling a POSIX process group (process.ts's killProcessGroup
        // makes the same platform split).
        await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
        return;
      }
      try {
        // Negative pid = the whole process group. Runs are spawned
        // detached precisely so this works (process.ts).
        kill(-pid, "SIGKILL");
      } catch {
        try {
          kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
  };
}
