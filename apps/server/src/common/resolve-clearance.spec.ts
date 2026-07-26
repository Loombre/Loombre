// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/resolve-clearance.spec.ts
//
// Exhaustive table-driven proof of the five-gate model (docs/PLAN.md §6.4):
// all 32 combinations of the five gate booleans collapse to
// `restrictedCleared === (g1 && g2 && g3 && g4 && g5)`, and each single-gate
// failure (holding the other four true) independently blocks clearance.

import { describe, expect, it } from "vitest";
import { computeAgeYears, resolveClearance, type ClearanceInputs } from "./resolve-clearance.js";

const NOW_MS = Date.UTC(2026, 6, 22); // 2026-07-22, matches "currentDate" convention

/** Inputs with every gate driven to `true`. */
function allTrueInputs(): ClearanceInputs {
  return {
    capabilityEnabled: true, // gate 1
    birthDate: "1988-03-14", // gate 2: comfortably over 18 as of NOW_MS
    nowMs: NOW_MS,
    majorityAgeYears: 18,
    optIn: true, // gate 3
    hasPin: true, // gate 3
    hasRestrictedLibraryPermission: true, // gate 4
    unlockedUntilMs: NOW_MS + 60_000, // gate 5: live, in the future
  };
}

/** Flips exactly gate `n` (1-indexed) of `base` to its "false" variant. */
function withGateFalse(base: ClearanceInputs, gate: 1 | 2 | 3 | 4 | 5): ClearanceInputs {
  switch (gate) {
    case 1:
      return { ...base, capabilityEnabled: false };
    case 2:
      return { ...base, birthDate: null };
    case 3:
      return { ...base, optIn: false };
    case 4:
      return { ...base, hasRestrictedLibraryPermission: false };
    case 5:
      return { ...base, unlockedUntilMs: null };
  }
}

describe("computeAgeYears", () => {
  it("computes whole years elapsed, accounting for month/day not yet reached", () => {
    expect(computeAgeYears("1988-03-14", Date.UTC(2026, 6, 22))).toBe(38);
    // Birthday is later this year (Dec) than "now" (Jul) -> one year less.
    expect(computeAgeYears("1988-12-14", Date.UTC(2026, 6, 22))).toBe(37);
    // Birthday is exactly today.
    expect(computeAgeYears("2008-07-22", Date.UTC(2026, 6, 22))).toBe(18);
    // Birthday is tomorrow -> not yet 18.
    expect(computeAgeYears("2008-07-23", Date.UTC(2026, 6, 22))).toBe(17);
  });
});

describe("resolveClearance — exhaustive 32-combination truth table", () => {
  // Enumerate every subset of {g1..g5} as a 5-bit mask; bit i set = gate
  // (i+1) forced true, unset = forced false. This proves the collapse
  // property for ALL 32 combinations, not just a hand-picked few.
  for (let mask = 0; mask < 32; mask++) {
    const wantG1 = Boolean(mask & 0b00001);
    const wantG2 = Boolean(mask & 0b00010);
    const wantG3 = Boolean(mask & 0b00100);
    const wantG4 = Boolean(mask & 0b01000);
    const wantG5 = Boolean(mask & 0b10000);

    const inputs: ClearanceInputs = {
      capabilityEnabled: wantG1,
      birthDate: wantG2 ? "1988-03-14" : null,
      nowMs: NOW_MS,
      majorityAgeYears: 18,
      optIn: wantG3,
      hasPin: wantG3,
      hasRestrictedLibraryPermission: wantG4,
      unlockedUntilMs: wantG5 ? NOW_MS + 60_000 : null,
    };

    const expectedCleared = wantG1 && wantG2 && wantG3 && wantG4 && wantG5;

    it(`mask=${mask.toString(2).padStart(5, "0")} (g1=${wantG1} g2=${wantG2} g3=${wantG3} g4=${wantG4} g5=${wantG5}) -> restrictedCleared=${expectedCleared}`, () => {
      const result = resolveClearance(inputs);
      expect(result.gates).toEqual({
        g1: wantG1,
        g2: wantG2,
        g3: wantG3,
        g4: wantG4,
        g5: wantG5,
      });
      expect(result.restrictedCleared).toBe(expectedCleared);
    });
  }
});

describe("resolveClearance — each single-gate failure independently blocks (all others true)", () => {
  const base = allTrueInputs();

  it("baseline: all five gates true -> cleared", () => {
    expect(resolveClearance(base).restrictedCleared).toBe(true);
  });

  it("gate 1 (server capability) false alone blocks clearance", () => {
    const result = resolveClearance(withGateFalse(base, 1));
    expect(result.gates.g1).toBe(false);
    expect(result.restrictedCleared).toBe(false);
  });

  it("gate 2 (age eligibility — no birth date) false alone blocks clearance", () => {
    const result = resolveClearance(withGateFalse(base, 2));
    expect(result.gates.g2).toBe(false);
    expect(result.restrictedCleared).toBe(false);
  });

  it("gate 3 (opt-in + PIN) false alone blocks clearance", () => {
    const result = resolveClearance(withGateFalse(base, 3));
    expect(result.gates.g3).toBe(false);
    expect(result.restrictedCleared).toBe(false);
  });

  it("gate 4 (library permission) false alone blocks clearance", () => {
    const result = resolveClearance(withGateFalse(base, 4));
    expect(result.gates.g4).toBe(false);
    expect(result.restrictedCleared).toBe(false);
  });

  it("gate 5 (live session unlock) false alone blocks clearance", () => {
    const result = resolveClearance(withGateFalse(base, 5));
    expect(result.gates.g5).toBe(false);
    expect(result.restrictedCleared).toBe(false);
  });
});

describe("resolveClearance — gate 2 age-eligibility edge cases", () => {
  it("under majority age with a birth date set still fails gate 2", () => {
    const result = resolveClearance({
      ...allTrueInputs(),
      birthDate: "2015-01-01", // 11 years old as of NOW_MS
    });
    expect(result.gates.g2).toBe(false);
  });

  it("exactly majority age today passes gate 2", () => {
    const result = resolveClearance({
      ...allTrueInputs(),
      birthDate: "2008-07-22", // exactly 18 as of NOW_MS (2026-07-22)
    });
    expect(result.gates.g2).toBe(true);
  });

  it("one day short of majority age fails gate 2", () => {
    const result = resolveClearance({
      ...allTrueInputs(),
      birthDate: "2008-07-23",
    });
    expect(result.gates.g2).toBe(false);
  });
});

describe("resolveClearance — gate 5 unlock-expiry edge case", () => {
  it("unlockedUntilMs exactly equal to now is NOT still-live (strict >)", () => {
    const result = resolveClearance({
      ...allTrueInputs(),
      unlockedUntilMs: NOW_MS,
    });
    expect(result.gates.g5).toBe(false);
  });

  it("unlockedUntilMs one ms in the past fails gate 5", () => {
    const result = resolveClearance({
      ...allTrueInputs(),
      unlockedUntilMs: NOW_MS - 1,
    });
    expect(result.gates.g5).toBe(false);
  });
});
