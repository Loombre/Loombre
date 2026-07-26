// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/process.spec.ts
//
// Tests for src/transcode/process.ts using an INJECTED fake child process
// (no real ffmpeg) — exercises the stderr ring buffer, exit-result shape,
// killedByUs semantics, and terminate() idempotency. Real SIGSTOP/SIGCONT
// suspend/resume behavior against a REAL process is covered by this
// step's ffmpeg-gated integration suite (session.integration.spec.ts),
// which is where that claim actually matters end-to-end.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnFfmpegRun } from "../../src/transcode/process.js";

class FakeStream extends EventEmitter {
  emitData(chunk: string): void {
    this.emit("data", Buffer.from(chunk, "utf8"));
  }
}

class FakeChild extends EventEmitter {
  readonly pid: number | undefined = undefined; // never a real pid — see module header
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();

  emitClose(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", exitCode, signal);
  }
}

function fakeSpawnFn(child: FakeChild) {
  return (() => child as unknown as ReturnType<typeof import("node:child_process").spawn>) as typeof import("node:child_process").spawn;
}

describe("spawnFfmpegRun — stderr ring buffer + exit result", () => {
  it("resolves with the exit code/signal once the process closes", async () => {
    const child = new FakeChild();
    const handle = spawnFfmpegRun("ffmpeg", ["-i", "x"], { cwd: "/tmp", spawnFn: fakeSpawnFn(child) });
    child.stderr.emitData("some diagnostic output\n");
    child.emitClose(0, null);
    const result = await handle.result;
    expect(result).toEqual({ exitCode: 0, signal: null, killedByUs: false, stderrTail: "some diagnostic output\n" });
  });

  it("keeps only the last 4096 bytes of stderr", async () => {
    const child = new FakeChild();
    const handle = spawnFfmpegRun("ffmpeg", ["-i", "x"], { cwd: "/tmp", spawnFn: fakeSpawnFn(child) });
    child.stderr.emitData("a".repeat(3000));
    child.stderr.emitData("b".repeat(3000));
    child.emitClose(1, null);
    const result = await handle.result;
    expect(result.stderrTail.length).toBe(4096);
    expect(result.stderrTail.endsWith("b".repeat(3000))).toBe(true);
  });

  it("stderrTail() is readable before exit too", () => {
    const child = new FakeChild();
    const handle = spawnFfmpegRun("ffmpeg", ["-i", "x"], { cwd: "/tmp", spawnFn: fakeSpawnFn(child) });
    child.stderr.emitData("in progress\n");
    expect(handle.stderrTail()).toBe("in progress\n");
  });

  it("a spawn 'error' event resolves (not rejects) with a null exit code", async () => {
    const child = new FakeChild();
    const handle = spawnFfmpegRun("ffmpeg", ["-i", "x"], { cwd: "/tmp", spawnFn: fakeSpawnFn(child) });
    child.emit("error", new Error("ENOENT"));
    const result = await handle.result;
    expect(result.exitCode).toBeNull();
  });
});

describe("spawnFfmpegRun — terminate()", () => {
  it("marks killedByUs=true and resolves once the process actually closes", async () => {
    const child = new FakeChild();
    const handle = spawnFfmpegRun("ffmpeg", ["-i", "x"], { cwd: "/tmp", spawnFn: fakeSpawnFn(child) });

    const terminatePromise = handle.terminate();
    // Simulate the process reacting to the (no-op, since pid is undefined —
    // module header) signal and exiting on its own shortly after.
    queueMicrotask(() => child.emitClose(null, "SIGTERM"));
    await terminatePromise;

    const result = await handle.result;
    expect(result.killedByUs).toBe(true);
  });

  it("is idempotent — calling it twice does not hang or double-signal", async () => {
    const child = new FakeChild();
    const handle = spawnFfmpegRun("ffmpeg", ["-i", "x"], { cwd: "/tmp", spawnFn: fakeSpawnFn(child) });
    queueMicrotask(() => child.emitClose(null, "SIGTERM"));
    await handle.terminate();
    await expect(handle.terminate()).resolves.toBeUndefined();
  });

  it("a process that has already exited on its own — terminate() still resolves cleanly", async () => {
    const child = new FakeChild();
    const handle = spawnFfmpegRun("ffmpeg", ["-i", "x"], { cwd: "/tmp", spawnFn: fakeSpawnFn(child) });
    child.emitClose(0, null);
    await expect(handle.terminate()).resolves.toBeUndefined();
    const result = await handle.result;
    // Exited cleanly on its own BEFORE terminate() was ever called —
    // killedByUs must stay false (this is the "not caused by our kill"
    // distinction binding constraint 7 depends on).
    expect(result.killedByUs).toBe(false);
  });
});

describe("spawnFfmpegRun — suspend()/resume() are safe no-ops without a real pid", () => {
  it("never throws when pid is undefined (e.g. a fake/never-spawned child)", () => {
    const child = new FakeChild();
    const handle = spawnFfmpegRun("ffmpeg", ["-i", "x"], { cwd: "/tmp", spawnFn: fakeSpawnFn(child) });
    expect(() => handle.suspend()).not.toThrow();
    expect(() => handle.resume()).not.toThrow();
  });
});
