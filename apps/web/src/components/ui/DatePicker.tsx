// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/ui/DatePicker.tsx
//
// W6 (owner screenshot, Account birth date): the birth-date field used a
// dated native-looking calendar popover AND defaulted to TODAY's date —
// meaningless for a birth date, and the field this component replaces never
// even had the bug in its own state (AccountSection always seeded it from
// `user.birthDate ?? ""`); the defaulting bug lived entirely in the native
// <input type="date"> UA chrome showing today's date as a greyed-out
// starting point the moment you opened the picker with an empty value. This
// component never does that: with an empty `value` its popover opens on
// today's MONTH (a reasonable starting point to navigate away from) but no
// day is ever pre-selected, and the text field stays genuinely empty.
//
// Shape (per the review brief): a text-adjacent trigger button opens a
// custom calendar popover — month grid + month/year quick-jump dropdowns
// (using this kit's own Select.tsx) so reaching a birth year is two picks,
// not ~360 back-clicks. Manual typed entry (YYYY-MM-DD) keeps working
// alongside the popover; the two are simply two ways to reach the same
// `onChange(iso: string)` call.
//
// The calendar-math helpers below (parseIsoDate/getMonthGrid/addMonths/
// getYearRange/etc.) are pure — no DOM, no `Date` object identity leaked
// across a boundary, weekday/day-count arithmetic pinned to UTC so it's
// immune to the host's local timezone — and are exported so DatePicker.test.ts
// can cover month-grid generation, year-range bounds, and leap-year/
// month-length edge cases without a DOM harness.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays } from "lucide-react";
import { Icon } from "../icon/Icon.js";
import { TextInput } from "./Input.js";
import { Select } from "./Select.js";
import { useEscapeKey } from "./overlay-hooks.js";
import styles from "./DatePicker.module.css";

// ── Pure calendar math (no DOM) ─────────────────────────────────────────

export interface CalendarDate {
  year: number;
  month: number; // 0-11
  day: number;
}

export interface CalendarCell {
  date: CalendarDate;
  iso: string;
  inCurrentMonth: boolean;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The number of days in `month` (0-11) of `year` — day 0 of the FOLLOWING
 *  month is always the last day of THIS one, including leap Februaries.
 *  Computed via `Date.UTC` purely for its calendar arithmetic; the instant
 *  it produces is never read back as a timestamp. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function isValidCalendarDate({ year, month, day }: CalendarDate): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 0 || month > 11 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/** Strict `YYYY-MM-DD` parse — rejects malformed shapes AND calendar
 *  nonsense (`2023-02-30`), so a partially-typed or fat-fingered value in
 *  the text field never silently becomes "the nearest real date". */
export function parseIsoDate(value: string): CalendarDate | null {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const date: CalendarDate = { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
  return isValidCalendarDate(date) ? date : null;
}

export function formatIsoDate({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 0 (Sunday) – 6 (Saturday), pinned to UTC so it never drifts with the
 *  host's local timezone — the same calendar day must grid the same way
 *  regardless of where this runs. */
export function weekdayOf({ year, month, day }: CalendarDate): number {
  return new Date(Date.UTC(year, month, day)).getUTCDay();
}

export function addDays({ year, month, day }: CalendarDate, delta: number): CalendarDate {
  const d = new Date(Date.UTC(year, month, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

/** Adds calendar months, clamping the day into the target month's length
 *  (Jan 31 + 1 month -> Feb 28/29, never "rolls over" into March). */
export function addMonths({ year, month, day }: CalendarDate, delta: number): CalendarDate {
  const total = year * 12 + month + delta;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return { year: y, month: m, day: Math.min(day, daysInMonth(y, m)) };
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

/** A stable 6-week (42-cell) grid for `year`/`month` (0-11), Sunday-first,
 *  padded with the trailing/leading days of the adjacent months so every
 *  caller renders exactly 6 rows of 7 cells — no conditional row count for
 *  short months. */
export function getMonthGrid(year: number, month: number): CalendarCell[][] {
  const firstOfMonth: CalendarDate = { year, month, day: 1 };
  const gridStart = addDays(firstOfMonth, -weekdayOf(firstOfMonth));

  const weeks: CalendarCell[][] = [];
  for (let week = 0; week < 6; week++) {
    const row: CalendarCell[] = [];
    for (let day = 0; day < 7; day++) {
      const date = addDays(gridStart, week * 7 + day);
      row.push({ date, iso: formatIsoDate(date), inCurrentMonth: date.month === month && date.year === year });
    }
    weeks.push(row);
  }
  return weeks;
}

/** Descending (most-recent-first) year list spanning `[minYear, maxYear]` —
 *  matches a birth-date picker's likeliest use (jumping toward the past is
 *  far more common than toward the present). Empty if the range is
 *  inverted rather than throwing, so a caller-supplied `minDate > maxDate`
 *  degrades to "no years" instead of crashing the popover. */
export function getYearRange(minYear: number, maxYear: number): number[] {
  const years: number[] = [];
  for (let y = maxYear; y >= minYear; y--) years.push(y);
  return years;
}

/** `now`, defaulted to the real clock but accepted as a parameter so the
 *  "empty default" behavior (this component NEVER seeds a value from this)
 *  is exercised deterministically in tests. */
export function todayCalendarDate(now: Date = new Date()): CalendarDate {
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

// ── Component ────────────────────────────────────────────────────────────

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** How far back the year quick-jump reaches when the caller gives no
 *  `minDate` — generous enough for any real birth date without an
 *  unbounded (and useless) dropdown. */
const DEFAULT_YEAR_SPAN_BACK = 120;

export interface DatePickerProps {
  id?: string;
  /** ISO `YYYY-MM-DD`, or `""` for "no date set". Never defaults to
   *  today's date internally — an empty `value` stays empty until the
   *  caller or the user picks something. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Inclusive ISO bounds — dates outside the range are disabled in the
   *  grid, rejected from typed entry, and clamp the year quick-jump. */
  minDate?: string;
  maxDate?: string;
  disabled?: boolean;
  required?: boolean;
}

export function DatePicker({
  id,
  value,
  onChange,
  placeholder = "YYYY-MM-DD",
  minDate,
  maxDate,
  disabled = false,
  required = false,
}: DatePickerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const dialogId = useId();

  const minCal = minDate ? parseIsoDate(minDate) : null;
  const maxCal = maxDate ? parseIsoDate(maxDate) : null;
  const today = useMemo(() => todayCalendarDate(), []);
  const fallbackView = parseIsoDate(value) ?? maxCal ?? today;

  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [view, setView] = useState<CalendarDate>(fallbackView);
  const [focusedIso, setFocusedIso] = useState<string>(formatIsoDate(fallbackView));

  // External value changes (initial load, a save round-trip, a reset) keep
  // the typed text and the popover's month in sync — but ONLY when the new
  // value is non-empty; clearing externally must not resurrect a "today"
  // view (see this file's header — no path here ever seeds from `today`
  // except as an empty popover's navigational starting point).
  useEffect(() => {
    setText(value);
    const parsed = parseIsoDate(value);
    if (parsed) {
      setView(parsed);
      setFocusedIso(value);
    }
  }, [value]);

  useEscapeKey(open, () => {
    setOpen(false);
    triggerRef.current?.focus();
  });

  // Roving tabindex: move real DOM focus onto whichever day is logically
  // "current" whenever it changes while the grid is visible (arrow-key
  // navigation, or the popover just opened).
  useEffect(() => {
    if (!open) return;
    dayRefs.current.get(focusedIso)?.focus();
  }, [open, focusedIso]);

  function isDisabledDate(date: CalendarDate): boolean {
    if (minCal && compareCalendarDates(date, minCal) < 0) return true;
    if (maxCal && compareCalendarDates(date, maxCal) > 0) return true;
    return false;
  }

  const minYear = minCal?.year ?? (maxCal?.year ?? today.year) - DEFAULT_YEAR_SPAN_BACK;
  const maxYear = maxCal?.year ?? today.year;
  const years = useMemo(() => getYearRange(minYear, maxYear), [minYear, maxYear]);
  const weeks = useMemo(() => getMonthGrid(view.year, view.month), [view.year, view.month]);

  // Non-modal popover: closing on focus leaving the whole widget (button,
  // grid, and the two quick-jump selects all live under `rootRef`) covers
  // both mouse clicks elsewhere and Tab/Shift+Tab moving out, without a
  // separate document-level click listener.
  function handleRootBlur(event: React.FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    setOpen(false);
  }

  function commit(date: CalendarDate): void {
    const iso = formatIsoDate(date);
    setText(iso);
    setView(date);
    setFocusedIso(iso);
    onChange(iso);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function openPopover(): void {
    if (disabled) return;
    const base = parseIsoDate(value) ?? maxCal ?? today;
    setView(base);
    setFocusedIso(formatIsoDate(base));
    setOpen(true);
  }

  function handleTriggerClick(): void {
    if (open) {
      setOpen(false);
    } else {
      openPopover();
    }
  }

  function handleTextChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const next = event.target.value;
    setText(next);
    if (next === "") {
      onChange("");
      return;
    }
    // Only a FULLY valid, in-range date ever reaches the caller — a
    // mid-typing string ("1991-02-") must never briefly become the
    // committed birth date (this is the same "no garbage on the wire"
    // guarantee the old `<input type="date">` got for free from the UA).
    const parsed = parseIsoDate(next);
    if (parsed && !isDisabledDate(parsed)) {
      onChange(next);
      setView(parsed);
      setFocusedIso(next);
    }
  }

  function handleTextBlur(): void {
    if (text === "") return;
    const parsed = parseIsoDate(text);
    if (!parsed || isDisabledDate(parsed)) setText(value);
  }

  function handleTextKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      openPopover();
    }
  }

  // Never move the roving-tabindex focus onto a disabled (out-of-range)
  // day: a disabled <button> silently ignores `.focus()`, which would
  // otherwise leave real DOM focus stranded on the last enabled cell while
  // `focusedIso` state raced ahead onto a date with no visual focus ring —
  // arrow keys would then look like they'd "stopped working" right at a
  // min/maxDate boundary.
  function setFocusIfEnabled(next: CalendarDate): void {
    if (isDisabledDate(next)) return;
    setFocusedIso(formatIsoDate(next));
    if (next.month !== view.month || next.year !== view.year) setView({ ...next, day: 1 });
  }

  function moveFocusedBy(delta: number): void {
    const current = parseIsoDate(focusedIso) ?? view;
    setFocusIfEnabled(addDays(current, delta));
  }

  function jumpFocusedByMonth(delta: number): void {
    const current = parseIsoDate(focusedIso) ?? view;
    setFocusIfEnabled(addMonths(current, delta));
  }

  // WAI-ARIA APG grid/date-picker keyboard conventions: arrows move by
  // day/week, Home/End snap to the visible week's edges, Page Up/Down step
  // a month (Shift+ a year), Enter/Space commit the focused day.
  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveFocusedBy(1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        moveFocusedBy(-1);
        return;
      case "ArrowDown":
        event.preventDefault();
        moveFocusedBy(7);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveFocusedBy(-7);
        return;
      case "PageUp":
        event.preventDefault();
        jumpFocusedByMonth(event.shiftKey ? -12 : -1);
        return;
      case "PageDown":
        event.preventDefault();
        jumpFocusedByMonth(event.shiftKey ? 12 : 1);
        return;
      case "Home": {
        event.preventDefault();
        const current = parseIsoDate(focusedIso) ?? view;
        setFocusIfEnabled(addDays(current, -weekdayOf(current)));
        return;
      }
      case "End": {
        event.preventDefault();
        const current = parseIsoDate(focusedIso) ?? view;
        setFocusIfEnabled(addDays(current, 6 - weekdayOf(current)));
        return;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        const current = parseIsoDate(focusedIso);
        if (current && !isDisabledDate(current)) commit(current);
        return;
      }
      default:
    }
  }

  const todayIso = formatIsoDate(today);

  return (
    <div className={styles.root} ref={rootRef} onBlur={handleRootBlur}>
      <div className={styles.inputRow}>
        <TextInput
          id={id}
          className={styles.textInput}
          value={text}
          placeholder={placeholder}
          onChange={handleTextChange}
          onBlur={handleTextBlur}
          onKeyDown={handleTextKeyDown}
          disabled={disabled}
          required={required}
          inputMode="numeric"
          autoComplete="off"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? dialogId : undefined}
        />
        <button
          type="button"
          ref={triggerRef}
          className={styles.trigger}
          onClick={handleTriggerClick}
          disabled={disabled}
          aria-label="Choose date"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <Icon icon={CalendarDays} size="dense" />
        </button>
      </div>
      {open && (
        <div id={dialogId} className={styles.popover} role="dialog" aria-modal="false" aria-label="Choose date">
          {/* Month/year QUICK-JUMP only — no separate prev/next-month
              buttons. The locked requirement this satisfies is reaching a
              birth year in a couple of picks instead of ~360 back-clicks;
              these two selects already do that in the minimum number of
              interactions, and PageUp/PageDown (month) / Shift+PageUp/Down
              (year) cover the same step-by-one motion from the keyboard
              (handleGridKeyDown below) — a second, redundant pair of 44px
              icon buttons would only fight the popover's width for room. */}
          <div className={styles.header}>
            <Select
              aria-label="Month"
              className={styles.monthSelect}
              value={String(view.month)}
              onChange={(e) => setView((v) => ({ ...v, month: Number(e.target.value) }))}
              options={MONTH_LABELS.map((label, index) => ({ value: String(index), label }))}
            />
            <Select
              aria-label="Year"
              className={styles.yearSelect}
              value={String(view.year)}
              onChange={(e) => setView((v) => ({ ...v, year: Number(e.target.value) }))}
              options={years.map((y) => ({ value: String(y), label: String(y) }))}
            />
          </div>
          <div className={styles.weekdays} aria-hidden="true">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <div
            className={styles.grid}
            role="grid"
            aria-label={`${MONTH_LABELS[view.month]} ${view.year}`}
            onKeyDown={handleGridKeyDown}
          >
            {weeks.map((week, weekIndex) => (
              <div className={styles.week} role="row" key={weekIndex}>
                {week.map((cell) => {
                  const isSelected = cell.iso === value;
                  const isFocusable = cell.iso === focusedIso;
                  const isToday = cell.iso === todayIso;
                  const isDayDisabled = isDisabledDate(cell.date);
                  return (
                    <button
                      key={cell.iso}
                      type="button"
                      role="gridcell"
                      ref={(el) => {
                        if (el) dayRefs.current.set(cell.iso, el);
                        else dayRefs.current.delete(cell.iso);
                      }}
                      tabIndex={isFocusable ? 0 : -1}
                      className={styles.day}
                      data-outside={!cell.inCurrentMonth || undefined}
                      data-selected={isSelected || undefined}
                      data-today={isToday || undefined}
                      aria-selected={isSelected}
                      aria-current={isToday ? "date" : undefined}
                      disabled={isDayDisabled}
                      onClick={() => commit(cell.date)}
                      onFocus={() => setFocusedIso(cell.iso)}
                    >
                      {cell.date.day}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
