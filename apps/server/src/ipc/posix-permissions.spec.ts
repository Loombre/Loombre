// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/posix-permissions.spec.ts

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolveGroupId, IPC_FILE_MODE } from "./posix-permissions.js";

describe("IPC_FILE_MODE", () => {
  it("is 0640 — group-readable, never world-readable (orchestrator decision b)", () => {
    expect(IPC_FILE_MODE).toBe(0o640);
  });
});

describe.skipIf(process.platform === "win32")("resolveGroupId", () => {
  it("resolves the current process's own primary group name to its real gid", () => {
    const ownGroupName = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
    const ownGid = Number.parseInt(execFileSync("id", ["-g"], { encoding: "utf8" }).trim(), 10);
    expect(resolveGroupId(ownGroupName)).toBe(ownGid);
  });

  it("returns null (never throws) for a nonexistent group name", () => {
    expect(resolveGroupId("definitely-not-a-real-group-xyz123")).toBeNull();
  });
});

describe.skipIf(process.platform !== "win32")("resolveGroupId on win32", () => {
  it("always returns null", () => {
    expect(resolveGroupId("Administrators")).toBeNull();
  });
});
