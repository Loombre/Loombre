// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/env.spec.ts

import { describe, expect, it } from "vitest";
import { resolveIpcEnablement, resolveIpcGroupName, resolveIpcWindowsExtraGrants } from "./env.js";

describe("resolveIpcEnablement", () => {
  it("is disabled when LOOMBRE_DATA_DIR is unset", () => {
    const result = resolveIpcEnablement({});
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/LOOMBRE_DATA_DIR is not set/);
  });

  it("is disabled when LOOMBRE_DATA_DIR is only whitespace", () => {
    expect(resolveIpcEnablement({ LOOMBRE_DATA_DIR: "   " }).enabled).toBe(false);
  });

  it("is enabled when LOOMBRE_DATA_DIR is set and LOOMBRE_IPC_DISABLED is unset", () => {
    const result = resolveIpcEnablement({ LOOMBRE_DATA_DIR: "/var/lib/loombre" });
    expect(result.enabled).toBe(true);
  });

  it("is disabled when LOOMBRE_DATA_DIR is set but LOOMBRE_IPC_DISABLED=1", () => {
    const result = resolveIpcEnablement({ LOOMBRE_DATA_DIR: "/var/lib/loombre", LOOMBRE_IPC_DISABLED: "1" });
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/LOOMBRE_IPC_DISABLED/);
  });

  it("accepts true/on/yes as truthy for LOOMBRE_IPC_DISABLED", () => {
    for (const v of ["true", "TRUE", "on", "yes"]) {
      expect(resolveIpcEnablement({ LOOMBRE_DATA_DIR: "/x", LOOMBRE_IPC_DISABLED: v }).enabled).toBe(false);
    }
  });

  it("treats 0/false/empty as not-disabled", () => {
    for (const v of ["0", "false", ""]) {
      expect(resolveIpcEnablement({ LOOMBRE_DATA_DIR: "/x", LOOMBRE_IPC_DISABLED: v }).enabled).toBe(true);
    }
  });
});

describe("resolveIpcGroupName", () => {
  it("is undefined when unset", () => {
    expect(resolveIpcGroupName({})).toBeUndefined();
  });

  it("returns the trimmed value when set", () => {
    expect(resolveIpcGroupName({ LOOMBRE_IPC_GROUP: "  admin  " })).toBe("admin");
  });

  it("is undefined for an empty/whitespace-only value", () => {
    expect(resolveIpcGroupName({ LOOMBRE_IPC_GROUP: "   " })).toBeUndefined();
  });
});

describe("resolveIpcWindowsExtraGrants", () => {
  it("is an empty array when unset", () => {
    expect(resolveIpcWindowsExtraGrants({})).toEqual([]);
  });

  it("splits + trims a comma-separated list", () => {
    expect(resolveIpcWindowsExtraGrants({ LOOMBRE_IPC_WINDOWS_GRANT: " alice , BUILTIN\\Users " })).toEqual([
      "alice",
      "BUILTIN\\Users",
    ]);
  });

  it("drops empty segments", () => {
    expect(resolveIpcWindowsExtraGrants({ LOOMBRE_IPC_WINDOWS_GRANT: "alice,,bob" })).toEqual(["alice", "bob"]);
  });
});
