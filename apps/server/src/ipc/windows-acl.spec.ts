// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/windows-acl.spec.ts

import { describe, expect, it } from "vitest";
import { applyWindowsAcl, RECOMMENDED_ICACLS_COMMAND } from "./windows-acl.js";

describe.skipIf(process.platform === "win32")("applyWindowsAcl off-Windows", () => {
  it("is a documented no-op (attempted: false) on non-win32 platforms", () => {
    const result = applyWindowsAcl("/some/path");
    expect(result).toEqual({ attempted: false, succeeded: false, detail: "not running on win32" });
  });
});

describe.skipIf(process.platform !== "win32")("applyWindowsAcl on Windows", () => {
  it("attempts icacls and reports honestly whether it succeeded", () => {
    // Not exercised on non-Windows CI runners — real coverage lives on the
    // Windows CI runner (STATE.md's per-OS runner matrix). This just
    // proves the function is at least callable without throwing.
    const result = applyWindowsAcl("C:\\definitely\\does\\not\\exist\\token");
    expect(result.attempted).toBe(true);
    expect(typeof result.succeeded).toBe("boolean");
  });
});

describe("RECOMMENDED_ICACLS_COMMAND", () => {
  it("documents the SYSTEM full-control + Administrators read-only grant", () => {
    expect(RECOMMENDED_ICACLS_COMMAND).toContain("S-1-5-18");
    expect(RECOMMENDED_ICACLS_COMMAND).toContain("S-1-5-32-544");
    expect(RECOMMENDED_ICACLS_COMMAND).toContain("/inheritance:r");
  });
});
