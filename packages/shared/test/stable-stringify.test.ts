// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/stable-stringify.js";

describe("stableStringify", () => {
  it("sorts object keys recursively regardless of insertion order", () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array element order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("produces deterministic output for nested structures", () => {
    const value = { z: [{ y: 1, x: 2 }], a: null };
    expect(stableStringify(value)).toBe('{"a":null,"z":[{"x":2,"y":1}]}');
  });

  it("drops undefined values like JSON.stringify does", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});
