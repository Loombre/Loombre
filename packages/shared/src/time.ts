// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Milliseconds everywhere (CLAUDE.md invariant 5). Every timestamp in the
 * system — DB columns, API payloads, plan inputs — is a BIGINT/number count
 * of milliseconds since the Unix epoch. No Date objects cross a boundary.
 */

/** Current time in epoch milliseconds. The only place `Date.now()` should be
 * called from application code — pass the result down as data from here. */
export function nowMs(): number {
  return Date.now();
}

export function msToSeconds(ms: number): number {
  return ms / 1000;
}

export function secondsToMs(seconds: number): number {
  return seconds * 1000;
}

export function addMs(baseMs: number, deltaMs: number): number {
  return baseMs + deltaMs;
}

export function diffMs(laterMs: number, earlierMs: number): number {
  return laterMs - earlierMs;
}

export function isBeforeMs(aMs: number, bMs: number): boolean {
  return aMs < bMs;
}
