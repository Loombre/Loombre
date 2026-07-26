// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/crash/handlers.spec.ts
//
// Both installCrashHandlers and installGracefulShutdown register REAL
// process.on() listeners — this suite always removes what it added
// (afterEach) so one test's fake process-level handler can never leak into
// another test file's real process. The genuine "does this survive an
// actual OS signal / an actual uncaught throw in a real child process"
// proof lives in test/crash/forced-crash.integration.spec.ts, which spawns
// a real Node child rather than driving these in-process.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crashDirPath } from "@loombre/shared";
import { installCrashHandlers, installGracefulShutdown } from "../../src/crash/handlers.js";

function removeAllTestListeners(event: string): void {
  process.removeAllListeners(event);
}

describe("installCrashHandlers", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "loombre-crash-handlers-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    removeAllTestListeners("uncaughtException");
    removeAllTestListeners("unhandledRejection");
  });

  it("uncaughtException writes a redacted crash file and calls exit(1)", () => {
    const exit = vi.fn();
    const log = vi.fn();
    installCrashHandlers({ dataDir, version: "9.9.9", platform: "linux", log, exit });

    const err = new Error("synthetic crash");
    process.emit("uncaughtException", err);

    expect(exit).toHaveBeenCalledWith(1);
    expect(existsSync(crashDirPath(dataDir))).toBe(true);
    const files = readdirSync(crashDirPath(dataDir));
    expect(files.length).toBe(1);
    expect(log.mock.calls.some((call) => String(call[0]).includes("synthetic crash"))).toBe(true);
  });

  it("unhandledRejection with a non-Error value still produces a crash file and exits", () => {
    const exit = vi.fn();
    const log = vi.fn();
    installCrashHandlers({ dataDir, version: "9.9.9", platform: "linux", log, exit });

    process.emit("unhandledRejection", "a rejected string" as unknown as Error, Promise.resolve());

    expect(exit).toHaveBeenCalledWith(1);
    expect(readdirSync(crashDirPath(dataDir)).length).toBe(1);
  });

  it("never writes a crash file containing the raw dataDir path outside itself (self-consistency: dataDir-relative paths in the message survive, foreign ones don't)", () => {
    const exit = vi.fn();
    installCrashHandlers({ dataDir, version: "1.0.0", platform: "linux", exit, log: () => {} });

    process.emit("uncaughtException", new Error("failed: open '/some/other/machine/secret.env'"));

    const files = readdirSync(crashDirPath(dataDir));
    const content = readFileSync(join(crashDirPath(dataDir), files[0]!), "utf8");
    expect(content).not.toContain("/some/other/machine");
    expect(content).toContain("<redacted>/secret.env");
  });
});

describe("installGracefulShutdown", () => {
  afterEach(() => {
    removeAllTestListeners("SIGTERM");
    removeAllTestListeners("SIGINT");
    removeAllTestListeners("SIGBREAK");
  });

  it("SIGTERM triggers onShutdown and exits 0 on success", async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    installGracefulShutdown({ onShutdown, exit, log: () => {}, platform: "linux" });

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onShutdown).toHaveBeenCalledWith("SIGTERM");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("a second signal while shutdown is in flight is ignored (no double-invocation)", async () => {
    let resolveShutdown: (() => void) | undefined;
    const onShutdown = vi.fn().mockImplementation(() => new Promise<void>((resolve) => (resolveShutdown = resolve)));
    const exit = vi.fn();
    installGracefulShutdown({ onShutdown, exit, log: () => {}, platform: "linux" });

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    process.emit("SIGINT");
    resolveShutdown?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("a hung onShutdown exceeding timeoutMs exits 1 anyway", async () => {
    const onShutdown = vi.fn().mockImplementation(() => new Promise<void>(() => {})); // never resolves
    const exit = vi.fn();
    installGracefulShutdown({ onShutdown, exit, log: () => {}, platform: "linux", timeoutMs: 5 });

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("onShutdown rejecting exits 1", async () => {
    const onShutdown = vi.fn().mockRejectedValue(new Error("close failed"));
    const exit = vi.fn();
    installGracefulShutdown({ onShutdown, exit, log: () => {}, platform: "linux" });

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("SIGBREAK is registered on win32 only", async () => {
    const onShutdownWin = vi.fn().mockResolvedValue(undefined);
    installGracefulShutdown({ onShutdown: onShutdownWin, exit: vi.fn(), log: () => {}, platform: "win32" });
    expect(process.listenerCount("SIGBREAK")).toBeGreaterThan(0);
    removeAllTestListeners("SIGBREAK");
    removeAllTestListeners("SIGTERM");
    removeAllTestListeners("SIGINT");

    const onShutdownPosix = vi.fn().mockResolvedValue(undefined);
    installGracefulShutdown({ onShutdown: onShutdownPosix, exit: vi.fn(), log: () => {}, platform: "linux" });
    expect(process.listenerCount("SIGBREAK")).toBe(0);
  });
});
