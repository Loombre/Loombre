// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/stash-path-mappings.test.ts

import { describe, expect, it } from "vitest";
import {
  addMappingRow,
  completeMappingsOnly,
  draftFromMappings,
  mappingsAreDirty,
  mappingsAreValid,
  moveMappingRow,
  moveMappingRowDown,
  moveMappingRowUp,
  removeMappingRowAt,
  toWireMappings,
  updateMappingRowField,
} from "./stash-path-mappings.js";

describe("draftFromMappings", () => {
  it("preserves server order and gives every row a distinct key", () => {
    const draft = draftFromMappings([
      { stashPrefix: "/data/scenes", loombrePrefix: "/media/movies" },
      { stashPrefix: "/data/scenes", loombrePrefix: "/media/movies" },
    ]);
    expect(draft.map((r) => [r.stashPrefix, r.loombrePrefix])).toEqual([
      ["/data/scenes", "/media/movies"],
      ["/data/scenes", "/media/movies"],
    ]);
    expect(draft[0]?.key).not.toBe(draft[1]?.key);
  });
});

describe("addMappingRow / removeMappingRowAt", () => {
  it("appends an empty row", () => {
    const next = addMappingRow([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ stashPrefix: "", loombrePrefix: "" });
  });

  it("removes the row at the given index", () => {
    const rows = draftFromMappings([
      { stashPrefix: "a", loombrePrefix: "1" },
      { stashPrefix: "b", loombrePrefix: "2" },
    ]);
    const next = removeMappingRowAt(rows, 0);
    expect(next).toHaveLength(1);
    expect(next[0]?.stashPrefix).toBe("b");
  });

  it("removeMappingRowAt on an out-of-range index is a no-op (new array, same content)", () => {
    const rows = draftFromMappings([{ stashPrefix: "a", loombrePrefix: "1" }]);
    const next = removeMappingRowAt(rows, 5);
    expect(next).toEqual(rows);
    expect(next).not.toBe(rows);
  });
});

describe("moveMappingRow / moveMappingRowUp / moveMappingRowDown", () => {
  const rows = draftFromMappings([
    { stashPrefix: "a", loombrePrefix: "1" },
    { stashPrefix: "b", loombrePrefix: "2" },
    { stashPrefix: "c", loombrePrefix: "3" },
  ]);

  it("moves an entry from one index to another", () => {
    const next = moveMappingRow(rows, 0, 2);
    expect(next.map((r) => r.stashPrefix)).toEqual(["b", "c", "a"]);
  });

  it("moving the first row up is a no-op", () => {
    const next = moveMappingRowUp(rows, 0);
    expect(next.map((r) => r.stashPrefix)).toEqual(["a", "b", "c"]);
  });

  it("moving the last row down is a no-op", () => {
    const next = moveMappingRowDown(rows, 2);
    expect(next.map((r) => r.stashPrefix)).toEqual(["a", "b", "c"]);
  });

  it("moveMappingRowUp/Down shift by exactly one slot", () => {
    expect(moveMappingRowUp(rows, 1).map((r) => r.stashPrefix)).toEqual(["b", "a", "c"]);
    expect(moveMappingRowDown(rows, 1).map((r) => r.stashPrefix)).toEqual(["a", "c", "b"]);
  });
});

describe("updateMappingRowField", () => {
  it("updates only the targeted row's targeted field", () => {
    const rows = draftFromMappings([
      { stashPrefix: "a", loombrePrefix: "1" },
      { stashPrefix: "b", loombrePrefix: "2" },
    ]);
    const next = updateMappingRowField(rows, 1, "loombrePrefix", "changed");
    expect(next[0]?.loombrePrefix).toBe("1");
    expect(next[1]?.loombrePrefix).toBe("changed");
  });
});

describe("mappingsAreValid", () => {
  it("is true for an empty table", () => {
    expect(mappingsAreValid([])).toBe(true);
  });

  it("is true when every row has both prefixes filled", () => {
    expect(mappingsAreValid(draftFromMappings([{ stashPrefix: "a", loombrePrefix: "1" }]))).toBe(true);
  });

  it("is false when any row is missing a prefix (whitespace-only counts as missing)", () => {
    expect(mappingsAreValid(draftFromMappings([{ stashPrefix: "a", loombrePrefix: "  " }]))).toBe(false);
    expect(mappingsAreValid(addMappingRow([]))).toBe(false);
  });
});

describe("completeMappingsOnly", () => {
  it("drops rows missing either prefix, keeps the rest wire-shaped", () => {
    let rows = draftFromMappings([{ stashPrefix: "a", loombrePrefix: "1" }]);
    rows = addMappingRow(rows);
    rows = updateMappingRowField(rows, 1, "stashPrefix", "b");
    // row 1 has stashPrefix but no loombrePrefix yet — still incomplete.
    expect(completeMappingsOnly(rows)).toEqual([{ stashPrefix: "a", loombrePrefix: "1" }]);
  });
});

describe("toWireMappings / mappingsAreDirty", () => {
  it("toWireMappings strips the local key", () => {
    const rows = draftFromMappings([{ stashPrefix: "a", loombrePrefix: "1" }]);
    expect(toWireMappings(rows)).toEqual([{ stashPrefix: "a", loombrePrefix: "1" }]);
  });

  it("is not dirty when the wire shape is unchanged, even if row identity/order of internal state churned", () => {
    const original = draftFromMappings([{ stashPrefix: "a", loombrePrefix: "1" }]);
    const current = draftFromMappings([{ stashPrefix: "a", loombrePrefix: "1" }]);
    expect(mappingsAreDirty(original, current)).toBe(false);
  });

  it("is dirty when a field changes", () => {
    const original = draftFromMappings([{ stashPrefix: "a", loombrePrefix: "1" }]);
    const current = updateMappingRowField(original, 0, "loombrePrefix", "2");
    expect(mappingsAreDirty(original, current)).toBe(true);
  });

  it("is dirty when a row is added or removed", () => {
    const original = draftFromMappings([{ stashPrefix: "a", loombrePrefix: "1" }]);
    expect(mappingsAreDirty(original, addMappingRow(original))).toBe(true);
    expect(mappingsAreDirty(original, removeMappingRowAt(original, 0))).toBe(true);
  });
});
