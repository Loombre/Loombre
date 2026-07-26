// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { isUuid, uuidv7 } from "../src/ids.js";

describe("uuidv7", () => {
  it("produces a well-formed UUID", () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
  });

  it("encodes version 7 and the RFC 4122 variant", () => {
    const id = uuidv7();
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("is lexicographically time-ordered for increasing timestamps", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });

  it("generates unique ids across many calls", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => uuidv7()));
    expect(ids.size).toBe(2000);
  });
});

describe("isUuid", () => {
  it("accepts generated ids", () => {
    expect(isUuid(uuidv7())).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
  });

  it("rejects an all-zero string (invalid version/variant nibbles)", () => {
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
