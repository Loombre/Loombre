// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/iso-date.spec.ts
//
// api-validation-F3: the unit matrix for isValidIsoDate. The HTTP-level
// proof (PATCH /users/me 422s instead of 500ing) lives in
// apps/server/test/users-birthdate-validation.e2e.spec.ts; this file pins
// the calendar rules themselves, which are cheap to enumerate here and
// expensive to enumerate over a live database.

import { describe, expect, it } from "vitest";
import { isValidIsoDate } from "./iso-date.js";

describe("isValidIsoDate — accepts every real YYYY-MM-DD", () => {
  const ACCEPTED = [
    "1988-03-14",
    "2026-08-23",
    "0001-01-01", // Postgres' first representable date
    "9999-12-31",
    "1988-02-29", // leap year (divisible by 4)
    "2000-02-29", // leap year (divisible by 400)
    "2024-01-31",
    "2024-04-30",
  ];
  for (const value of ACCEPTED) {
    it(`accepts ${value}`, () => {
      expect(isValidIsoDate(value)).toBe(true);
    });
  }
});

describe("isValidIsoDate — rejects anything the Postgres date column would refuse or reinterpret", () => {
  const REJECTED: ReadonlyArray<readonly [label: string, value: string]> = [
    ["the cited garbage string", "not-a-date"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a leading space", " 1988-03-14"],
    ["a trailing space", "1988-03-14 "],
    ["unpadded month", "1988-3-14"],
    ["unpadded day", "1988-03-4"],
    ["a two-digit year", "88-03-14"],
    ["a five-digit year", "01988-03-14"],
    ["year zero (no such year in the proleptic Gregorian calendar)", "0000-01-01"],
    ["month 00", "1988-00-14"],
    ["month 13", "1988-13-01"],
    ["day 00", "1988-03-00"],
    ["day 32", "1988-03-32"],
    ["Feb 30", "2024-02-30"],
    ["Feb 29 in a non-leap year", "2023-02-29"],
    ["Feb 29 in a non-leap century year", "1900-02-29"],
    ["April 31", "2024-04-31"],
    ["a date-time", "1988-03-14T00:00:00Z"],
    ["a date with a time component", "1988-03-14 00:00:00"],
    ["slash separators (DateStyle-dependent in Postgres)", "03/14/1988"],
    ["dot separators", "1988.03.14"],
    ["no separators", "19880314"],
    ["a bare year", "1988"],
    ["a year-month", "1988-03"],
    ["Postgres' `now` special value", "now"],
    ["Postgres' `today` special value", "today"],
    ["Postgres' `infinity` special value", "infinity"],
    ["Postgres' `epoch` special value", "epoch"],
    ["a function call", "now()"],
    ["an embedded newline after a valid date", "1988-03-14\n"],
  ];

  for (const [label, value] of REJECTED) {
    it(`rejects ${label} (${JSON.stringify(value)})`, () => {
      expect(isValidIsoDate(value)).toBe(false);
    });
  }
});

describe("isValidIsoDate — leap-year rule agrees with the proleptic Gregorian calendar", () => {
  it("Feb 29 exists in every year divisible by 4 except non-400 century years", () => {
    for (const year of [1904, 1996, 2000, 2004, 2020, 2024, 2400]) {
      expect(isValidIsoDate(`${year}-02-29`), `${year} is a leap year`).toBe(true);
    }
    for (const year of [1900, 1901, 1999, 2001, 2023, 2100, 2200, 2300]) {
      expect(isValidIsoDate(`${year}-02-29`), `${year} is not a leap year`).toBe(false);
    }
  });

  it("every month's last day is exact", () => {
    const lastDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    lastDays.forEach((last, index) => {
      const month = String(index + 1).padStart(2, "0");
      expect(isValidIsoDate(`2023-${month}-${String(last).padStart(2, "0")}`)).toBe(true);
      expect(isValidIsoDate(`2023-${month}-${String(last + 1).padStart(2, "0")}`)).toBe(false);
    });
  });
});
