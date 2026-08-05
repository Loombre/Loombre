// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/tunnel/cloudflared-connector-manager.spec.ts
//
// Unit tests for the state machine using an INJECTED fake child process
// (no real cloudflared) — mirrors apps/worker/test/transcode/process.spec.ts's
// FakeChild convention exactly. `remote.cloudflaredPath` points at a real,
// tiny executable file created in a scratch dir per test so
// resolveCloudflaredBinary's own real fs check is exercised rather than
// mocked away — only the actual `spawn()` call is faked. A REAL spawn
// against a tiny Node stub script, driven through the full HTTP API, is
// covered separately by apps/server/test/remote-tunnel.e2e.spec.ts (per
// this lane's mission: "e2e: getRemoteTunnelStatus/getRemoteTunnelLogs now
// surface manager truth (with the stub)").

import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsService } from "../../settings/settings.service.js";
import { CloudflaredConnectorManager, type SpawnFn } from "./cloudflared-connector-manager.js";
import type { ConnectorStartConfig } from "./connector-manager.js";

class FakeStream extends EventEmitter {
  emitData(chunk: string): void {
    this.emit("data", Buffer.from(chunk, "utf8"));
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(readonly pid: number | undefined = 4242) {
    super();
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function makeSpawnFn(children: FakeChild[]): SpawnFn {
  let i = 0;
  return ((..._args: unknown[]) => {
    const child = children[Math.min(i, children.length - 1)]!;
    i += 1;
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
}

let scratch: string;
let fakeBinaryPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loombre-cfd-mgr-"));
  fakeBinaryPath = join(scratch, "cloudflared");
  writeFileSync(fakeBinaryPath, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeBinaryPath, 0o755);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fakeSettings(cloudflaredPath: string): SettingsService {
  return {
    getEffective: (key: string) => (key === "remote.cloudflaredPath" ? { value: cloudflaredPath } : undefined),
  } as unknown as SettingsService;
}

const CONFIG: ConnectorStartConfig = { tunnelId: "tunnel-1", hostname: "media.example.com", credential: "super-secret-token" };

describe("CloudflaredConnectorManager — start -> healthy", () => {
  it("is 'starting' immediately after start(), then 'healthy' on the readiness line", async () => {
    const child = new FakeChild();
    const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), { spawnFn: makeSpawnFn([child]) });
    await mgr.start(CONFIG);
    expect(mgr.health().state).toBe("starting");

    child.stderr.emitData(
      "2026-08-04T12:00:00Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.10 location=DFW protocol=quic\n",
    );
    expect(mgr.health().state).toBe("healthy");
    expect(mgr.health().lastError).toBeNull();
    expect(mgr.health().backoffMs).toBeNull();
  });

  it("passes the credential ONLY via env, never in argv", async () => {
    const child = new FakeChild();
    let capturedArgs: string[] = [];
    let capturedEnv: Record<string, string | undefined> = {};
    const spawnFn = ((_cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
      capturedArgs = args;
      capturedEnv = opts.env ?? {};
      return child as unknown as ChildProcess;
    }) as unknown as SpawnFn;
    const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), { spawnFn });
    await mgr.start(CONFIG);

    expect(capturedArgs).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(capturedArgs.join(" ")).not.toContain(CONFIG.credential);
    expect(capturedEnv["TUNNEL_TOKEN"]).toBe(CONFIG.credential);
  });
});

describe("CloudflaredConnectorManager — connection-lost is 'unhealthy', not a restart", () => {
  it("healthy -> unhealthy on a connection-lost line without restarting; recovers on the next readiness line", async () => {
    const child = new FakeChild();
    const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), { spawnFn: makeSpawnFn([child]) });
    await mgr.start(CONFIG);
    child.stderr.emitData("Registered tunnel connection connIndex=0\n");
    expect(mgr.health().state).toBe("healthy");

    child.stderr.emitData("Unregistered tunnel connection connIndex=0 event=1\n");
    expect(mgr.health().state).toBe("unhealthy");
    expect(mgr.health().restartCount).toBe(0); // the process is still alive — no restart

    child.stderr.emitData("Registered tunnel connection connIndex=0\n");
    expect(mgr.health().state).toBe("healthy");
  });

  it("ignores connection-lost noise while merely 'starting' (not yet healthy)", async () => {
    const child = new FakeChild();
    const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), { spawnFn: makeSpawnFn([child]) });
    await mgr.start(CONFIG);
    child.stderr.emitData("Retrying connection in up to 3s\n");
    expect(mgr.health().state).toBe("starting");
  });
});

describe("CloudflaredConnectorManager — crash -> backoff -> restart", () => {
  it("schedules a restart with growing full-jitter backoff on repeated crashes, resets restartCount on success", async () => {
    vi.useFakeTimers();
    try {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      const child3 = new FakeChild();
      const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), {
        spawnFn: makeSpawnFn([child1, child2, child3]),
        random: () => 1, // deterministic ceiling
      });
      await mgr.start(CONFIG);

      child1.emitExit(1, null);
      expect(mgr.health().state).toBe("backoff");
      expect(mgr.health().restartCount).toBe(1);
      expect(mgr.health().backoffMs).toBe(1_000);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mgr.health().state).toBe("starting");

      child2.emitExit(1, null);
      expect(mgr.health().restartCount).toBe(2);
      expect(mgr.health().backoffMs).toBe(2_000);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(mgr.health().state).toBe("starting");

      child3.stderr.emitData("Registered tunnel connection connIndex=0\n");
      expect(mgr.health().state).toBe("healthy");
      expect(mgr.health().restartCount).toBe(0);
      expect(mgr.health().backoffMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a spawn 'error' event is treated the same as a crash", async () => {
    vi.useFakeTimers();
    try {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), {
        spawnFn: makeSpawnFn([child1, child2]),
        random: () => 1,
      });
      await mgr.start(CONFIG);
      child1.emit("error", new Error("ENOENT"));
      expect(mgr.health().state).toBe("backoff");
      expect(mgr.health().lastError).toContain("ENOENT");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mgr.health().state).toBe("starting");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CloudflaredConnectorManager — binary resolution failure", () => {
  it("start() never throws when cloudflared cannot be resolved — folds into the same backoff loop as a crash", async () => {
    const mgr = new CloudflaredConnectorManager(fakeSettings(join(scratch, "does-not-exist")), {
      spawnFn: makeSpawnFn([new FakeChild()]),
      random: () => 1,
    });
    await expect(mgr.start(CONFIG)).resolves.toBeUndefined();
    expect(mgr.health().state).toBe("backoff");
    expect(mgr.health().lastError).toContain("not an executable file");
    expect(mgr.health().restartCount).toBe(1);
  });
});

describe("CloudflaredConnectorManager — stop()", () => {
  it("is a safe no-op on a never-started manager", async () => {
    const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath));
    await expect(mgr.stop()).resolves.toBeUndefined();
    expect(mgr.health().state).toBe("stopped");
    expect(mgr.health().lastError).toBeNull();
  });

  it("during backoff cancels the pending restart timer — no further spawn ever happens", async () => {
    vi.useFakeTimers();
    try {
      const child1 = new FakeChild();
      let spawnCount = 0;
      const spawnFn = ((..._args: unknown[]) => {
        spawnCount += 1;
        return (spawnCount === 1 ? child1 : new FakeChild()) as unknown as ChildProcess;
      }) as unknown as SpawnFn;
      const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), { spawnFn, random: () => 1 });
      await mgr.start(CONFIG);
      child1.emitExit(1, null);
      expect(mgr.health().state).toBe("backoff");
      expect(spawnCount).toBe(1);

      await mgr.stop();
      expect(mgr.health().state).toBe("stopped");

      await vi.advanceTimersByTimeAsync(10_000); // well past the scheduled backoff
      expect(spawnCount).toBe(1); // never respawned
    } finally {
      vi.useRealTimers();
    }
  });

  it("SIGTERMs a live child, then SIGKILLs after the grace timeout if it ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const sentSignals: NodeJS.Signals[] = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal: NodeJS.Signals) => {
      sentSignals.push(signal);
      return true;
    }) as typeof process.kill);
    try {
      const child = new FakeChild(4242);
      const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), {
        spawnFn: makeSpawnFn([child]),
        stopGraceTimeoutMs: 5_000,
      });
      await mgr.start(CONFIG);
      child.stderr.emitData("Registered tunnel connection\n");

      const stopPromise = mgr.stop();
      // The fake child never reacts to the signal on its own — advance past
      // the grace window so the SIGKILL escalation fires.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sentSignals).toContain("SIGTERM");
      expect(sentSignals).toContain("SIGKILL");
      // Only NOW simulate the OS finally reaping the (SIGKILLed) process.
      child.emitExit(null, "SIGKILL");
      await stopPromise;

      expect(mgr.health().state).toBe("stopped");
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("resolves immediately for a child that already exited on its own", async () => {
    const child = new FakeChild();
    const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), { spawnFn: makeSpawnFn([child]) });
    await mgr.start(CONFIG);
    child.emitExit(1, null); // crash -> backoff, but we stop before any restart
    await mgr.stop();
    expect(mgr.health().state).toBe("stopped");
  });
});

describe("CloudflaredConnectorManager — start() replaces an already-running session", () => {
  it("tears down the old child before spawning the replacement", async () => {
    const child1 = new FakeChild(111);
    const child2 = new FakeChild(222);
    const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), { spawnFn: makeSpawnFn([child1, child2]) });
    await mgr.start(CONFIG);
    child1.stderr.emitData("Registered tunnel connection\n");
    expect(mgr.health().state).toBe("healthy");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") queueMicrotask(() => child1.emitExit(0, "SIGTERM"));
      return true;
    }) as typeof process.kill);
    try {
      await mgr.start({ ...CONFIG, hostname: "media2.example.com" });
    } finally {
      killSpy.mockRestore();
    }

    expect(mgr.health().state).toBe("starting");
    child2.stderr.emitData("Registered tunnel connection\n");
    expect(mgr.health().state).toBe("healthy");
  });
});

describe("CloudflaredConnectorManager — logsTail", () => {
  it("surfaces lines from both stdout and stderr, bounded", async () => {
    const child = new FakeChild();
    const mgr = new CloudflaredConnectorManager(fakeSettings(fakeBinaryPath), { spawnFn: makeSpawnFn([child]) });
    await mgr.start(CONFIG);
    child.stdout.emitData("stdout line 1\n");
    child.stderr.emitData("stderr line 1\n");
    expect(mgr.logsTail(10)).toEqual(["stdout line 1", "stderr line 1"]);
    expect(mgr.logsTail(1)).toEqual(["stderr line 1"]);
  });
});
