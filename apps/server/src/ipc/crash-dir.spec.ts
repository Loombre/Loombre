// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/crash-dir.spec.ts

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCrashFiles, resolveCrashDir } from "./crash-dir.js";

const dirs: string[] = [];
function makeTmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loombre-ipc-crashdir-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCrashDir", () => {
  it("is a 'crashes' subdirectory of the data dir", () => {
    expect(resolveCrashDir("/var/lib/loombre")).toBe(join("/var/lib/loombre", "crashes"));
  });
});

describe("listCrashFiles", () => {
  it("returns an empty list when the crashes directory does not exist", () => {
    const dataDir = makeTmpDataDir();
    expect(listCrashFiles(dataDir)).toEqual([]);
  });

  it("lists files with path + mtimeMs, sorted most-recent-first", () => {
    const dataDir = makeTmpDataDir();
    const crashDir = resolveCrashDir(dataDir);
    mkdirSync(crashDir, { recursive: true });

    const older = join(crashDir, "server-old.log");
    const newer = join(crashDir, "server-new.log");
    writeFileSync(older, "old crash");
    writeFileSync(newer, "new crash");

    const oldTime = new Date(Date.now() - 60_000);
    const newTime = new Date();
    utimesSync(older, oldTime, oldTime);
    utimesSync(newer, newTime, newTime);

    const files = listCrashFiles(dataDir);
    expect(files).toHaveLength(2);
    expect(files[0]?.path).toBe(newer);
    expect(files[1]?.path).toBe(older);
    expect(files[0]?.mtimeMs).toBeGreaterThan(files[1]?.mtimeMs ?? 0);
  });

  it("excludes subdirectories, only listing files", () => {
    const dataDir = makeTmpDataDir();
    const crashDir = resolveCrashDir(dataDir);
    mkdirSync(join(crashDir, "a-subdir"), { recursive: true });
    writeFileSync(join(crashDir, "server-x.log"), "x");

    const files = listCrashFiles(dataDir);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(join(crashDir, "server-x.log"));
  });

  it("every entry has an integer mtimeMs (contract schema requires integer)", () => {
    const dataDir = makeTmpDataDir();
    const crashDir = resolveCrashDir(dataDir);
    mkdirSync(crashDir, { recursive: true });
    writeFileSync(join(crashDir, "server-y.log"), "y");

    const files = listCrashFiles(dataDir);
    expect(Number.isInteger(files[0]?.mtimeMs)).toBe(true);
  });
});
