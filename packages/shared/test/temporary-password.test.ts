// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { TEMPORARY_PASSWORD_LENGTH, generateTemporaryPassword } from "../src/temporary-password.js";

// Digits 0/1 and both cases of I/L/O deliberately excluded — see
// temporary-password.ts's header (54-character charset).
const UNAMBIGUOUS_CHARSET_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]+$/;

describe("generateTemporaryPassword", () => {
  it("defaults to TEMPORARY_PASSWORD_LENGTH (20) characters", () => {
    expect(TEMPORARY_PASSWORD_LENGTH).toBe(20);
    expect(generateTemporaryPassword()).toHaveLength(20);
  });

  it("meets the brief's ~16+ character floor", () => {
    expect(generateTemporaryPassword().length).toBeGreaterThanOrEqual(16);
  });

  it("draws only from the unambiguous charset (no 0/O, 1/I/l/L)", () => {
    for (let i = 0; i < 200; i++) {
      const password = generateTemporaryPassword();
      expect(password).toMatch(UNAMBIGUOUS_CHARSET_PATTERN);
      expect(password).not.toMatch(/[01OoIiLl]/);
    }
  });

  it("respects an explicit length override", () => {
    expect(generateTemporaryPassword(8)).toHaveLength(8);
    expect(generateTemporaryPassword(32)).toHaveLength(32);
  });

  it("generates unique values across many calls (crypto-random, not deterministic)", () => {
    const passwords = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()));
    expect(passwords.size).toBe(500);
  });

  it("uses the full charset over a large sample (no accidental narrowing)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      for (const char of generateTemporaryPassword()) seen.add(char);
    }
    // 54-character charset (23 upper + 23 lower + 8 digits — see header:
    // excludes 0/O, 1/I/l/L in both cases) — a large sample should hit a
    // substantial majority of it; this is a sanity floor, not an exact
    // count (crypto-random coverage is probabilistic).
    expect(seen.size).toBeGreaterThan(45);
  });
});
