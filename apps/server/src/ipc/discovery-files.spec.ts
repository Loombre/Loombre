// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/discovery-files.spec.ts

import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoveryFilePath,
  tokenFilePath,
  generateIpcToken,
  detectStaleDiscoveryFile,
  writeDiscoveryFiles,
  removeDiscoveryFiles,
} from "./discovery-files.js";
import { IPC_DISCOVERY_FILENAME, IPC_TOKEN_FILENAME, IPC_LOOPBACK_HOST } from "@loombre/controller-ipc";

const dirs: string[] = [];
function makeTmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loombre-ipc-discovery-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("discoveryFilePath / tokenFilePath", () => {
  it("live directly under the data dir (no subdirectory) — matches transport.ts + the Windows client", () => {
    expect(discoveryFilePath("/data")).toBe(join("/data", IPC_DISCOVERY_FILENAME));
    expect(tokenFilePath("/data")).toBe(join("/data", IPC_TOKEN_FILENAME));
  });
});

describe("generateIpcToken", () => {
  it("produces a 64-char hex string", () => {
    const token = generateIpcToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is different on every call", () => {
    expect(generateIpcToken()).not.toBe(generateIpcToken());
  });
});

describe("detectStaleDiscoveryFile", () => {
  it("reports not-found when no discovery file exists", () => {
    const dataDir = makeTmpDataDir();
    expect(detectStaleDiscoveryFile(dataDir)).toEqual({ found: false, stale: false });
  });

  it("reports stale for a discovery file naming a definitely-dead pid", () => {
    const dataDir = makeTmpDataDir();
    // A pid essentially guaranteed not to exist; if this ever collides with
    // a real live process on the test host, that host has bigger problems.
    const deadPid = 2_147_483_647;
    writeFileSync(
      discoveryFilePath(dataDir),
      JSON.stringify({ port: 1, host: IPC_LOOPBACK_HOST, pid: deadPid, startedAtMs: 0 }),
    );
    const result = detectStaleDiscoveryFile(dataDir);
    expect(result.found).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.pid).toBe(deadPid);
  });

  it("reports NOT stale for a discovery file naming this test process's own (definitely alive) pid", () => {
    const dataDir = makeTmpDataDir();
    writeFileSync(
      discoveryFilePath(dataDir),
      JSON.stringify({ port: 1, host: IPC_LOOPBACK_HOST, pid: process.pid, startedAtMs: 0 }),
    );
    const result = detectStaleDiscoveryFile(dataDir);
    expect(result).toEqual({ found: true, stale: false, pid: process.pid });
  });

  it("reports found+stale for corrupt/unparseable JSON rather than throwing", () => {
    const dataDir = makeTmpDataDir();
    writeFileSync(discoveryFilePath(dataDir), "{ not json");
    expect(detectStaleDiscoveryFile(dataDir)).toEqual({ found: true, stale: true });
  });
});

describe("writeDiscoveryFiles", () => {
  it("writes a discovery.json matching IpcDiscoveryFile + a raw-text token file", () => {
    const dataDir = makeTmpDataDir();
    const result = writeDiscoveryFiles(dataDir, { port: 54321, pid: process.pid, startedAtMs: 1_800_000_000_000 }, {});

    const discoveryOnDisk = JSON.parse(readFileSync(discoveryFilePath(dataDir), "utf8"));
    expect(discoveryOnDisk).toEqual({
      port: 54321,
      host: IPC_LOOPBACK_HOST,
      pid: process.pid,
      startedAtMs: 1_800_000_000_000,
    });

    const tokenOnDisk = readFileSync(tokenFilePath(dataDir), "utf8");
    expect(tokenOnDisk).toBe(result.token);
    expect(tokenOnDisk).toMatch(/^[0-9a-f]{64}$/);
  });

  it.skipIf(process.platform === "win32")("writes both files 0640 on POSIX", () => {
    const dataDir = makeTmpDataDir();
    writeDiscoveryFiles(dataDir, { port: 1, pid: process.pid, startedAtMs: 0 }, {});
    for (const path of [discoveryFilePath(dataDir), tokenFilePath(dataDir)]) {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o640);
    }
  });

  it.skipIf(process.platform === "win32")(
    "resolves LOOMBRE_IPC_GROUP to the file's group when the name is valid",
    () => {
      // Use the current process's OWN primary group name — guaranteed to
      // exist and be resolvable on every POSIX test runner, without
      // depending on any specific group ("admin"/"staff"/...) existing.
      const ownGroupName = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
      const ownGid = Number.parseInt(execFileSync("id", ["-g"], { encoding: "utf8" }).trim(), 10);

      const dataDir = makeTmpDataDir();
      writeDiscoveryFiles(dataDir, { port: 1, pid: process.pid, startedAtMs: 0 }, { LOOMBRE_IPC_GROUP: ownGroupName });

      const stat = statSync(discoveryFilePath(dataDir));
      expect(stat.gid).toBe(ownGid);
    },
  );

  it.skipIf(process.platform === "win32")(
    "falls back gracefully (warns, does not throw) for an unresolvable group name",
    () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dataDir = makeTmpDataDir();
      expect(() =>
        writeDiscoveryFiles(dataDir, { port: 1, pid: process.pid, startedAtMs: 0 }, { LOOMBRE_IPC_GROUP: "definitely-not-a-real-group-xyz123" }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalled();
    },
  );

  it("never logs the token value it generates (only structural log lines elsewhere reference it)", () => {
    const dataDir = makeTmpDataDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = writeDiscoveryFiles(dataDir, { port: 1, pid: process.pid, startedAtMs: 0 }, {});
    const allLoggedText = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join(" ");
    expect(allLoggedText).not.toContain(result.token);
  });
});

describe("removeDiscoveryFiles", () => {
  it("removes both files", () => {
    const dataDir = makeTmpDataDir();
    writeDiscoveryFiles(dataDir, { port: 1, pid: process.pid, startedAtMs: 0 }, {});
    removeDiscoveryFiles(dataDir);
    expect(detectStaleDiscoveryFile(dataDir)).toEqual({ found: false, stale: false });
  });

  it("is idempotent — safe to call when the files never existed", () => {
    const dataDir = makeTmpDataDir();
    expect(() => removeDiscoveryFiles(dataDir)).not.toThrow();
  });
});
