// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/iso-date.ts
//
// api-validation-F3 (QA 2026-08-21, P1): the format check for every
// request field the contract declares as `format: date` — an RFC 3339
// `full-date` (`YYYY-MM-DD`), which is exactly the set of values a
// Postgres `date` column (users.birth_date today) stores losslessly.
//
// Why a hand-rolled check rather than a cast-and-catch: Postgres' date
// input is DELIBERATELY permissive, and letting a raw string reach it is
// wrong in BOTH directions.
//   * It THROWS on real garbage — 22007/22008 out of the driver, uncaught
//     through the query layer, rendered by ProblemJsonExceptionFilter's
//     generic `@Catch()` as `urn:loombre:problem:internal` 500. That is
//     the cited defect: a client typo crashed PATCH /users/me.
//   * It SILENTLY ACCEPTS a much larger set than the contract does, which
//     is the quieter half of the same bug and was found while reproducing
//     it: `now()`/`today` resolve to the server's current date, and
//     DateStyle decides what `03/14/1988` means. Those return 200 having
//     stored a date the caller never sent — a wrong birth_date silently
//     moves a user across resolve-clearance.ts's gate 2 (the age check
//     that unlocks restricted content), so "accept and normalize" is not
//     a safe posture for this column in particular.
// Validating the caller's own string first answers both with the 422 the
// contract already declares, and nothing malformed ever reaches the cast.
//
// Pure date-component arithmetic, never `new Date(value)`: the same
// rationale resolve-clearance.ts's computeAgeYears documents (a DATE-only
// value must never pick up an ambient time zone), plus `Date` parsing is
// itself lenient — `new Date("2024-02-30")` happily rolls over to March 1
// and would defeat the point of this function.

/** Proleptic-Gregorian leap year — the same calendar Postgres' `date`
 *  type uses, so this agrees with the column for every year it accepts. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1]!;
}

/**
 * True iff `value` is a strict RFC 3339 `full-date`: exactly
 * `YYYY-MM-DD`, zero-padded, naming a date that really exists.
 *
 * Rejects, among others: any surrounding or embedded whitespace, unpadded
 * components (`1988-3-14`), a date-TIME (`1988-03-14T00:00:00Z`), a
 * non-existent calendar day (`2024-02-30`, `1900-02-29`), and year `0000`
 * — which the proleptic Gregorian calendar and Postgres both lack (year 1
 * BC is `0001-01-01 BC`, never `0000-01-01`), so accepting it would hand
 * the column a value it rejects.
 */
export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}
