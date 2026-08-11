// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/boot-reaper.spec.ts
//
// an upstream media server-study implementation run, Lane A1 item C2: pid persistence +
// a boot-time crash reaper for orphaned ffmpeg processes.
//
// C1 covers the GRACEFUL path (a worker that gets to run its shutdown
// handler kills its children). This covers the one it cannot: a hard kill
// — SIGKILL, an OOM kill, a power cut, a `kill -9` from a frustrated
// operator. The worker never runs any code in that case, so the only place
// left to clean up is the NEXT boot, and the only thing that survives the
// crash is the database row.
//
// The four facts this pins:
//   1. The runner persists the ffmpeg pid + its supervising worker's start
//      time on the session row, so a later boot has something to look at.
//   2. A live ffmpeg from a PREVIOUS worker generation is an orphan even
//      though it is running perfectly: its supervisor is dead, so nothing
//      will ever throttle, seek, or reap it. It gets SIGKILLed (process
//      GROUP — the run was spawned detached) and its session failed.
//   3. Verification is PID + CMDLINE, never pid alone. Pids are reused;
//      SIGKILLing an unrelated process that inherited pid 4242 would be a
//      far worse bug than the one being fixed. An unverifiable pid is
//      never killed — the session is still reclaimed, because its
//      supervisor is gone either way.
//   4. Sessions belonging to THIS worker generation are never touched.
//
// The platform-specific inspector (/proc on Linux, `ps` on darwin — which
// has no /proc — tasklist/WMI on Windows, NO new native dependency) is
// injected here; its real behavior against a real process is covered by
// lifecycle.integration.spec.ts scenario (b).

import { describe, expect, it, vi } from "vitest";
import {
  createProcessInspector,
  reapOrphanedTranscodeSessions,
  type ProcessInspection,
  type ProcessInspector,
  type ReapableSession,
} from "../../src/transcode/reaper.js";

const WORKER_STARTED_AT_MS = 5_000_000;
const PREVIOUS_GENERATION_MS = WORKER_STARTED_AT_MS - 60_000;

function session(overrides: Partial<ReapableSession> & { id: string }): ReapableSession {
  return {
    workerPid: 4242,
    workerStartedAtMs: PREVIOUS_GENERATION_MS,
    stagingDir: `/var/tmp/loombre-transcode/${overrides.id}`,
    ...overrides,
  };
}

interface Harness {
  inspector: ProcessInspector;
  killed: number[];
}

function inspectorFor(map: Record<number, ProcessInspection>): Harness {
  const killed: number[] = [];
  return {
    killed,
    inspector: {
      inspect: async (pid: number) => map[pid] ?? { alive: false },
      killGroup: async (pid: number) => {
        killed.push(pid);
      },
    },
  };
}

describe("reapOrphanedTranscodeSessions (C2 boot crash reaper)", () => {
  it("SIGKILLs a live ffmpeg from a previous worker generation and fails its session", async () => {
    const target = session({ id: "s-live-orphan", workerPid: 111 });
    const { inspector, killed } = inspectorFor({
      111: { alive: true, commandLine: `/usr/bin/ffmpeg -i movie.mkv ${target.stagingDir}/run0/media.m3u8` },
    });
    const failed: string[] = [];

    const report = await reapOrphanedTranscodeSessions({
      listReapable: async () => [target],
      failSession: async (id) => {
        failed.push(id);
      },
      inspector,
      workerStartedAtMs: WORKER_STARTED_AT_MS,
      nowMs: () => 6_000_000,
    });

    expect(killed).toEqual([111]);
    expect(failed).toEqual(["s-live-orphan"]);
    expect(report).toEqual([{ sessionId: "s-live-orphan", workerPid: 111, outcome: "killed" }]);
  });

  it("reclaims a session whose ffmpeg is already gone, killing nothing", async () => {
    const target = session({ id: "s-dead", workerPid: 222 });
    const { inspector, killed } = inspectorFor({});
    const failed: string[] = [];

    const report = await reapOrphanedTranscodeSessions({
      listReapable: async () => [target],
      failSession: async (id) => {
        failed.push(id);
      },
      inspector,
      workerStartedAtMs: WORKER_STARTED_AT_MS,
      nowMs: () => 6_000_000,
    });

    expect(killed).toEqual([]);
    expect(failed).toEqual(["s-dead"]);
    expect(report[0]?.outcome).toBe("already-gone");
  });

  it("never kills a REUSED pid: a live process whose cmdline is not this session's ffmpeg", async () => {
    const target = session({ id: "s-reused", workerPid: 333 });
    const { inspector, killed } = inspectorFor({
      333: { alive: true, commandLine: "/usr/sbin/sshd -D" },
    });
    const failed: string[] = [];

    const report = await reapOrphanedTranscodeSessions({
      listReapable: async () => [target],
      failSession: async (id) => {
        failed.push(id);
      },
      inspector,
      workerStartedAtMs: WORKER_STARTED_AT_MS,
      nowMs: () => 6_000_000,
    });

    expect(killed, "an unrelated process must NEVER be killed").toEqual([]);
    // The session is still reclaimed — whatever pid 333 is now, this
    // session's supervisor is gone and its pipeline is not coming back.
    expect(failed).toEqual(["s-reused"]);
    expect(report[0]?.outcome).toBe("pid-reused");
  });

  it("never kills an UNVERIFIABLE pid (no cmdline readable, or no staging dir recorded)", async () => {
    const noCmdline = session({ id: "s-nocmdline", workerPid: 444 });
    const noStagingDir = session({ id: "s-nostaging", workerPid: 555, stagingDir: null });
    const { inspector, killed } = inspectorFor({
      444: { alive: true },
      555: { alive: true, commandLine: "/usr/bin/ffmpeg -i movie.mkv /somewhere/else/media.m3u8" },
    });
    const failed: string[] = [];

    const report = await reapOrphanedTranscodeSessions({
      listReapable: async () => [noCmdline, noStagingDir],
      failSession: async (id) => {
        failed.push(id);
      },
      inspector,
      workerStartedAtMs: WORKER_STARTED_AT_MS,
      nowMs: () => 6_000_000,
    });

    expect(killed).toEqual([]);
    expect(failed.sort()).toEqual(["s-nocmdline", "s-nostaging"]);
    expect(report.map((r) => r.outcome)).toEqual(["unverified", "pid-reused"]);
  });

  it("leaves THIS generation's own sessions strictly alone", async () => {
    const mine = session({ id: "s-mine", workerPid: 666, workerStartedAtMs: WORKER_STARTED_AT_MS });
    const { inspector, killed } = inspectorFor({
      666: { alive: true, commandLine: `/usr/bin/ffmpeg ${mine.stagingDir}/run0/media.m3u8` },
    });
    const failed: string[] = [];

    const report = await reapOrphanedTranscodeSessions({
      listReapable: async () => [mine],
      failSession: async (id) => {
        failed.push(id);
      },
      inspector,
      workerStartedAtMs: WORKER_STARTED_AT_MS,
      nowMs: () => 6_000_000,
    });

    expect(killed).toEqual([]);
    expect(failed).toEqual([]);
    expect(report).toEqual([]);
  });

  it("one session's failure never aborts the sweep", async () => {
    const first = session({ id: "s-boom", workerPid: 777 });
    const second = session({ id: "s-ok", workerPid: 888 });
    const { inspector, killed } = inspectorFor({
      777: { alive: true, commandLine: `ffmpeg ${first.stagingDir}/run0/media.m3u8` },
      888: { alive: true, commandLine: `ffmpeg ${second.stagingDir}/run0/media.m3u8` },
    });
    const failSession = vi.fn(async (id: string) => {
      if (id === "s-boom") throw new Error("db went away");
    });

    const report = await reapOrphanedTranscodeSessions({
      listReapable: async () => [first, second],
      failSession,
      inspector,
      workerStartedAtMs: WORKER_STARTED_AT_MS,
      nowMs: () => 6_000_000,
    });

    expect(killed).toEqual([777, 888]);
    expect(report.map((r) => r.sessionId)).toEqual(["s-ok"]);
  });
});

describe("createProcessInspector (no new native dependency)", () => {
  it("reads /proc/<pid>/cmdline where it exists (linux)", async () => {
    const readFile = vi.fn(async () => Buffer.from("ffmpeg\0-i\0movie.mkv\0"));
    const inspector = createProcessInspector({ platform: "linux", hasProc: true, readFile });
    await expect(inspector.inspect(9)).resolves.toEqual({ alive: true, commandLine: "ffmpeg -i movie.mkv" });
    expect(readFile).toHaveBeenCalledWith("/proc/9/cmdline");
  });

  it("falls back to `ps` on darwin, which has no /proc", async () => {
    const runCommand = vi.fn(async () => ({ status: 0, stdout: "ffmpeg -i movie.mkv\n" }));
    const inspector = createProcessInspector({ platform: "darwin", hasProc: false, runCommand });
    await expect(inspector.inspect(9)).resolves.toEqual({ alive: true, commandLine: "ffmpeg -i movie.mkv" });
    expect(runCommand.mock.calls[0]?.[0]).toBe("ps");
    expect(runCommand.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-p", "9"]));
  });

  it("reports a dead process when `ps` finds nothing", async () => {
    const runCommand = vi.fn(async () => ({ status: 1, stdout: "" }));
    const inspector = createProcessInspector({ platform: "darwin", hasProc: false, runCommand });
    await expect(inspector.inspect(9)).resolves.toEqual({ alive: false });
  });

  it("uses tasklist/WMI on win32 and taskkill /T for the process tree", async () => {
    const runCommand = vi.fn(async (command: string) => {
      if (command === "tasklist") return { status: 0, stdout: '"ffmpeg.exe","9","Console","1","10 K"\r\n' };
      if (command === "wmic") return { status: 0, stdout: "CommandLine=ffmpeg -i movie.mkv\r\n" };
      return { status: 0, stdout: "" };
    });
    const inspector = createProcessInspector({ platform: "win32", hasProc: false, runCommand });

    const inspection = await inspector.inspect(9);
    expect(inspection.alive).toBe(true);
    expect(inspection.commandLine).toContain("ffmpeg -i movie.mkv");

    await inspector.killGroup(9);
    expect(runCommand).toHaveBeenCalledWith("taskkill", expect.arrayContaining(["/PID", "9", "/T", "/F"]));
  });

  it("signals the whole process GROUP on POSIX (negative pid — runs are spawned detached)", async () => {
    const kill = vi.fn();
    const inspector = createProcessInspector({ platform: "darwin", hasProc: false, kill });
    await inspector.killGroup(9);
    expect(kill).toHaveBeenCalledWith(-9, "SIGKILL");
  });
});
