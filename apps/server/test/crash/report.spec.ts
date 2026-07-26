// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/crash/report.spec.ts

import { describe, expect, it } from "vitest";
import { buildCrashReport } from "../../src/crash/report.js";

const DATA_DIR = "/data/loombre";

describe("buildCrashReport", () => {
  it("builds ts/version/platform/kind/error from a real Error", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at /Users/x/App/main.js:1:1";
    const report = buildCrashReport(err, { nowMs: () => 12345, version: "1.2.3", platform: "linux", dataDir: DATA_DIR });

    expect(report.ts).toBe(12345);
    expect(report.version).toBe("1.2.3");
    expect(report.platform).toBe("linux");
    expect(report.kind).toBe("error");
    expect(report.error?.name).toBe("Error");
    expect(report.error?.message).toBe("boom");
    expect(report.error?.stack).toContain("<redacted>/main.js:1:1");
  });

  it("redacts a secret embedded in the error message itself", () => {
    const err = new Error("failed: LOOMBRE_JWT_SECRET=super-secret-abc123");
    const report = buildCrashReport(err, { nowMs: () => 1, version: "0.0.0", platform: "darwin", dataDir: DATA_DIR });
    expect(report.error?.message).not.toContain("super-secret-abc123");
  });

  it("handles a non-Error rejection value (unhandledRejection can reject with anything)", () => {
    const report = buildCrashReport("a plain string rejection", { nowMs: () => 1, version: "0.0.0", platform: "win32", dataDir: DATA_DIR });
    expect(report.error?.name).toBe("NonErrorRejection");
    expect(report.error?.message).toContain("a plain string rejection");
    expect(report.error?.stack).toBeNull();
  });

  it("handles undefined/null rejection values without throwing", () => {
    expect(() => buildCrashReport(undefined, { nowMs: () => 1, version: "0.0.0", platform: "linux", dataDir: DATA_DIR })).not.toThrow();
    expect(() => buildCrashReport(null, { nowMs: () => 1, version: "0.0.0", platform: "linux", dataDir: DATA_DIR })).not.toThrow();
  });
});
