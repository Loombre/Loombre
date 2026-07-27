// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  LANGUAGE_CODES,
  LANGUAGE_EQUIVALENCE_PAIRS,
  isKnownLanguageCode,
  languageMatches,
} from "../src/language-codes.js";

describe("LANGUAGE_CODES", () => {
  it("every code is exactly 3 lowercase ASCII letters (the contract's pattern)", () => {
    for (const { code } of LANGUAGE_CODES) {
      expect(code).toMatch(/^[a-z]{3}$/);
    }
  });

  it("has no duplicate codes", () => {
    const codes = LANGUAGE_CODES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("every entry has a non-empty English display name", () => {
    for (const { name } of LANGUAGE_CODES) {
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("excludes the special non-language codes (und/mul/mis/zxx/art)", () => {
    const codes = new Set(LANGUAGE_CODES.map((l) => l.code));
    for (const excluded of ["und", "mul", "mis", "zxx", "art"]) {
      expect(codes.has(excluded)).toBe(false);
    }
  });

  it("excludes collective/family codes (e.g. gem, sla, afa)", () => {
    const codes = new Set(LANGUAGE_CODES.map((l) => l.code));
    for (const excluded of ["gem", "sla", "afa", "map", "ine"]) {
      expect(codes.has(excluded)).toBe(false);
    }
  });

  it("includes common real-world languages", () => {
    const codes = new Set(LANGUAGE_CODES.map((l) => l.code));
    for (const expected of ["eng", "fra", "deu", "jpn", "spa", "zho", "kor", "hin", "ara", "rus"]) {
      expect(codes.has(expected)).toBe(true);
    }
  });
});

describe("isKnownLanguageCode", () => {
  it("accepts a known code", () => {
    expect(isKnownLanguageCode("eng")).toBe(true);
    expect(isKnownLanguageCode("fra")).toBe(true);
  });

  it("rejects an unknown 3-letter string", () => {
    expect(isKnownLanguageCode("xxx")).toBe(false);
    expect(isKnownLanguageCode("zzz")).toBe(false);
  });

  it("rejects the excluded special/collective codes", () => {
    expect(isKnownLanguageCode("und")).toBe(false);
    expect(isKnownLanguageCode("gem")).toBe(false);
  });
});

describe("LANGUAGE_EQUIVALENCE_PAIRS", () => {
  it("has exactly the ~20 documented B/T pairs, both codes present in LANGUAGE_CODES", () => {
    expect(LANGUAGE_EQUIVALENCE_PAIRS.length).toBe(20);
    const codes = new Set(LANGUAGE_CODES.map((l) => l.code));
    for (const [b, t] of LANGUAGE_EQUIVALENCE_PAIRS) {
      expect(codes.has(b), `missing B code ${b}`).toBe(true);
      expect(codes.has(t), `missing T code ${t}`).toBe(true);
    }
  });

  it("each pair shares the same display name in LANGUAGE_CODES", () => {
    const nameByCode = new Map(LANGUAGE_CODES.map((l) => [l.code, l.name]));
    for (const [b, t] of LANGUAGE_EQUIVALENCE_PAIRS) {
      expect(nameByCode.get(b)).toBe(nameByCode.get(t));
    }
  });
});

describe("languageMatches", () => {
  it("matches identical codes", () => {
    expect(languageMatches("eng", "eng")).toBe(true);
  });

  it("matches a bibliographic/terminologic pair in either direction", () => {
    expect(languageMatches("fre", "fra")).toBe(true);
    expect(languageMatches("fra", "fre")).toBe(true);
    expect(languageMatches("ger", "deu")).toBe(true);
    expect(languageMatches("deu", "ger")).toBe(true);
  });

  it("does not match unrelated languages", () => {
    expect(languageMatches("eng", "fra")).toBe(false);
  });

  it("never matches when either side is null, undefined, or empty", () => {
    expect(languageMatches(null, "eng")).toBe(false);
    expect(languageMatches("eng", null)).toBe(false);
    expect(languageMatches(undefined, undefined)).toBe(false);
    expect(languageMatches("", "")).toBe(false);
    expect(languageMatches(null, null)).toBe(false);
  });
});
