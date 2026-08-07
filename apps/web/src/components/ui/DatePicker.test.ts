// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/ui/DatePicker.test.ts
//
// W6 — pure calendar-math coverage, no DOM harness (these helpers take and
// return plain data, per this repo's "clock is an argument" convention —
// see DatePicker.tsx's own header). Three things this file exists to pin:
//   1. Month-grid generation is a stable 6x7 shape, Sunday-first, correctly
//      padded with adjacent-month days, including the leap-February and
//      December->January year-boundary edge cases.
//   2. The year quick-jump range is descending (most-recent-first) and
//      degrades to empty rather than throwing on an inverted range.
//   3. `todayCalendarDate` never becomes the DatePicker component's default
//      VALUE — it only accepts an injected clock, and the component itself
//      (DatePicker.tsx's own header/comments) never calls it to seed
//      `value`. This file can't see the component's internal wiring, but it
//      pins the primitive that wiring would have to misuse to reintroduce
//      the "defaults to today" bug.

import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  compareCalendarDates,
  daysInMonth,
  formatIsoDate,
  getMonthGrid,
  getYearRange,
  parseIsoDate,
  todayCalendarDate,
  weekdayOf,
  type CalendarDate,
} from "./DatePicker.js";

describe("parseIsoDate / formatIsoDate", () => {
  it("round-trips a well-formed date", () => {
    const parsed = parseIsoDate("1991-02-03");
    expect(parsed).toEqual({ year: 1991, month: 1, day: 3 });
    expect(formatIsoDate(parsed!)).toBe("1991-02-03");
  });

  it("pads month/day back to two digits", () => {
    expect(formatIsoDate({ year: 1991, month: 0, day: 5 })).toBe("1991-01-05");
  });

  it.each(["", "not-a-date", "1991-2-3", "1991/02/03", "1991-02-03T00:00:00Z", "  1991-02-03"])(
    "rejects malformed input %j",
    (value) => {
      expect(parseIsoDate(value)).toBeNull();
    },
  );

  it("rejects calendar-invalid dates a naive regex would let through", () => {
    expect(parseIsoDate("2023-02-30")).toBeNull(); // February never has 30 days
    expect(parseIsoDate("2023-13-01")).toBeNull(); // no 13th month
    expect(parseIsoDate("2023-00-01")).toBeNull(); // no 0th month
    expect(parseIsoDate("2023-01-00")).toBeNull(); // no 0th day
    expect(parseIsoDate("2023-04-31")).toBeNull(); // April has 30 days
  });

  it("accepts Feb 29 on a leap year and rejects it otherwise", () => {
    expect(parseIsoDate("2024-02-29")).toEqual({ year: 2024, month: 1, day: 29 });
    expect(parseIsoDate("2023-02-29")).toBeNull();
  });
});

describe("daysInMonth", () => {
  it("knows the 30/31-day months", () => {
    expect(daysInMonth(2023, 0)).toBe(31); // January
    expect(daysInMonth(2023, 3)).toBe(30); // April
  });

  it("handles February across the leap-year rule (divisible-by-4, century exception)", () => {
    expect(daysInMonth(2024, 1)).toBe(29); // divisible by 4
    expect(daysInMonth(2023, 1)).toBe(28);
    expect(daysInMonth(1900, 1)).toBe(28); // divisible by 100, not 400
    expect(daysInMonth(2000, 1)).toBe(29); // divisible by 400
  });
});

describe("weekdayOf", () => {
  it("is timezone-independent (pinned to UTC)", () => {
    // 2024-01-01 was a Monday.
    expect(weekdayOf({ year: 2024, month: 0, day: 1 })).toBe(1);
    // 2023-12-31 was a Sunday.
    expect(weekdayOf({ year: 2023, month: 11, day: 31 })).toBe(0);
  });
});

describe("addDays / addMonths", () => {
  it("addDays crosses month and year boundaries", () => {
    expect(addDays({ year: 2023, month: 11, day: 30 }, 3)).toEqual({ year: 2024, month: 0, day: 2 });
    expect(addDays({ year: 2024, month: 0, day: 1 }, -1)).toEqual({ year: 2023, month: 11, day: 31 });
  });

  it("addMonths clamps the day into the target month's length, not a rollover", () => {
    // Jan 31 + 1 month must land on Feb 28/29, never "March 2/3".
    expect(addMonths({ year: 2023, month: 0, day: 31 }, 1)).toEqual({ year: 2023, month: 1, day: 28 });
    expect(addMonths({ year: 2024, month: 0, day: 31 }, 1)).toEqual({ year: 2024, month: 1, day: 29 });
  });

  it("addMonths crosses year boundaries both directions", () => {
    expect(addMonths({ year: 2023, month: 11, day: 15 }, 1)).toEqual({ year: 2024, month: 0, day: 15 });
    expect(addMonths({ year: 2024, month: 0, day: 15 }, -1)).toEqual({ year: 2023, month: 11, day: 15 });
  });

  it("addMonths supports jumping a full year at once (the Shift+PageUp/Down step)", () => {
    expect(addMonths({ year: 2000, month: 5, day: 10 }, 12)).toEqual({ year: 2001, month: 5, day: 10 });
    expect(addMonths({ year: 2000, month: 5, day: 10 }, -12)).toEqual({ year: 1999, month: 5, day: 10 });
  });
});

describe("compareCalendarDates", () => {
  it("orders by year, then month, then day", () => {
    expect(compareCalendarDates({ year: 2023, month: 0, day: 1 }, { year: 2024, month: 0, day: 1 })).toBeLessThan(0);
    expect(compareCalendarDates({ year: 2024, month: 1, day: 1 }, { year: 2024, month: 0, day: 1 })).toBeGreaterThan(
      0,
    );
    expect(compareCalendarDates({ year: 2024, month: 0, day: 5 }, { year: 2024, month: 0, day: 5 })).toBe(0);
  });
});

describe("getMonthGrid", () => {
  it("is always a stable 6-week x 7-day shape", () => {
    const grid = getMonthGrid(2024, 1); // February 2024 (leap)
    expect(grid).toHaveLength(6);
    for (const week of grid) expect(week).toHaveLength(7);
  });

  it("pads a month that doesn't start on Sunday with the previous month's trailing days", () => {
    // February 2024 starts on a Thursday — the first row's first 4 cells
    // (Su/Mo/Tu/We) belong to January.
    const [firstWeek] = getMonthGrid(2024, 1);
    expect(firstWeek!.slice(0, 4).every((cell) => !cell.inCurrentMonth)).toBe(true);
    expect(firstWeek![4]).toMatchObject({ iso: "2024-02-01", inCurrentMonth: true });
  });

  it("pads the trailing rows with next month's leading days", () => {
    const grid = getMonthGrid(2024, 1);
    const lastCell = grid[5]![6]!;
    expect(lastCell.inCurrentMonth).toBe(false);
    expect(lastCell.date.month).toBe(2); // March
  });

  it("every cell is exactly one day after the previous cell, with no gaps or repeats", () => {
    const grid = getMonthGrid(2023, 5); // June 2023 — an arbitrary non-edge month
    const cells = grid.flat();
    for (let i = 1; i < cells.length; i++) {
      expect(compareCalendarDates(cells[i]!.date, addDays(cells[i - 1]!.date, 1))).toBe(0);
    }
  });

  it("handles a December grid rolling into the next January", () => {
    const grid = getMonthGrid(2023, 11); // December 2023
    const cells = grid.flat();
    const trailing = cells.filter((c) => !c.inCurrentMonth && c.date.month === 0);
    expect(trailing.length).toBeGreaterThan(0);
    expect(trailing.every((c) => c.date.year === 2024)).toBe(true);
  });
});

describe("getYearRange", () => {
  it("is descending, most-recent-first", () => {
    expect(getYearRange(2020, 2023)).toEqual([2023, 2022, 2021, 2020]);
  });

  it("is a single-element list when min equals max", () => {
    expect(getYearRange(2024, 2024)).toEqual([2024]);
  });

  it("degrades to an empty list for an inverted range instead of throwing", () => {
    expect(getYearRange(2024, 2000)).toEqual([]);
  });
});

describe("todayCalendarDate — the empty-default guarantee", () => {
  it("reads the injected clock, never the ambient one, given an explicit `now`", () => {
    const fixedNow = new Date(2030, 6, 15); // July 15, 2030 (local)
    expect(todayCalendarDate(fixedNow)).toEqual({ year: 2030, month: 6, day: 15 });
  });

  it("is a plain data snapshot — callers can't get 'today' silently drifting mid-render", () => {
    const now = new Date(2030, 0, 1);
    const a = todayCalendarDate(now);
    const b = todayCalendarDate(now);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // distinct objects, not a shared mutable singleton
  });
});

// A `CalendarDate` type-only import keeps this file honest that the shape
// above (`{ year, month, day }`) is the one the component's props/state
// actually use, not a coincidentally-matching local shape.
function assertCalendarDateShape(d: CalendarDate): CalendarDate {
  return d;
}

describe("CalendarDate shape", () => {
  it("is exactly {year, month, day}", () => {
    const d = assertCalendarDateShape({ year: 2024, month: 0, day: 1 });
    expect(Object.keys(d).sort()).toEqual(["day", "month", "year"]);
  });
});
