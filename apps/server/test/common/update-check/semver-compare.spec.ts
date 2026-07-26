// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compareSemver, maxSemver } from "../../../src/common/update-check/semver-compare.js";

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("1.1.2", "1.1.1")).toBe(1);
    expect(compareSemver("1.1.1", "1.1.1")).toBe(0);
    expect(compareSemver("0.9.0", "0.9.1")).toBe(-1);
  });

  it("a release version has higher precedence than any prerelease of the same core", () => {
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });

  it("prerelease identifiers compare numerically-then-lexically per semver.org §11", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1); // fewer fields = lower precedence
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1); // numeric < alphanumeric
    expect(compareSemver("1.0.0-alpha.beta", "1.0.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1); // numeric compare, not lexical
  });

  it("ignores build metadata entirely", () => {
    expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });
});

describe("maxSemver", () => {
  it("returns null for an empty list", () => {
    expect(maxSemver([])).toBeNull();
  });

  it("returns the single element for a singleton list", () => {
    expect(maxSemver(["1.2.3"])).toBe("1.2.3");
  });

  it("picks the highest-precedence version out of a mixed list", () => {
    expect(maxSemver(["0.9.0", "1.0.0", "0.10.0", "1.0.0-rc.1"])).toBe("1.0.0");
  });
});
