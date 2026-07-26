// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/library-permissions.test.ts

import { describe, expect, it } from "vitest";
import { diffPermissionsToSubmit } from "./library-permissions.js";

describe("diffPermissionsToSubmit", () => {
  it("returns [] when nothing changed", () => {
    const original = new Set(["u1", "u2"]);
    const current = new Set(["u1", "u2"]);
    expect(diffPermissionsToSubmit(original, current)).toEqual([]);
  });

  it("emits granted:true for a newly checked user", () => {
    const original = new Set(["u1"]);
    const current = new Set(["u1", "u2"]);
    expect(diffPermissionsToSubmit(original, current)).toEqual([{ userId: "u2", granted: true }]);
  });

  it("emits granted:false for a newly unchecked user", () => {
    const original = new Set(["u1", "u2"]);
    const current = new Set(["u1"]);
    expect(diffPermissionsToSubmit(original, current)).toEqual([{ userId: "u2", granted: false }]);
  });

  it("handles both directions in one diff", () => {
    const original = new Set(["u1", "u2"]);
    const current = new Set(["u1", "u3"]);
    const result = diffPermissionsToSubmit(original, current);
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { userId: "u3", granted: true },
        { userId: "u2", granted: false },
      ]),
    );
  });

  it("empty original + empty current -> []", () => {
    expect(diffPermissionsToSubmit(new Set(), new Set())).toEqual([]);
  });

  it("granting every user from empty original", () => {
    const result = diffPermissionsToSubmit(new Set(), new Set(["u1", "u2"]));
    expect(result.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: "u1", granted: true },
      { userId: "u2", granted: true },
    ]);
  });
});
