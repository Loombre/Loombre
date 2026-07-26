// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/crash/writer.spec.ts

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crashDirPath } from "@loombre/shared";
import { writeCrashReport } from "../../src/crash/writer.js";
import type { CrashReport } from "../../src/crash/report.js";

describe("writeCrashReport", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "loombre-crash-writer-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const report: CrashReport = {
    ts: 1700000000000,
    version: "0.9.0",
    platform: "darwin",
    kind: "error",
    error: { name: "Error", message: "boom", stack: null },
  };

  it("creates crashDirPath(dataDir) and writes a JSON file there", () => {
    expect(existsSync(crashDirPath(dataDir))).toBe(false);
    const path = writeCrashReport(dataDir, report);
    expect(existsSync(crashDirPath(dataDir))).toBe(true);
    expect(path.startsWith(crashDirPath(dataDir))).toBe(true);

    const parsed = JSON.parse(readFileSync(path, "utf8")) as CrashReport;
    expect(parsed).toEqual(report);
  });

  it("writes with 0600 permissions", () => {
    if (process.platform === "win32") return;
    const path = writeCrashReport(dataDir, report);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("two crashes in immediate succession produce two distinct files", () => {
    const first = writeCrashReport(dataDir, report);
    const second = writeCrashReport(dataDir, { ...report, ts: report.ts + 1 });
    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it("reuses an already-existing crashes directory without error", () => {
    writeCrashReport(dataDir, report);
    expect(() => writeCrashReport(dataDir, report)).not.toThrow();
  });
});
