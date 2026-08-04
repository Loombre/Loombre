// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/components/notices/notice-time.ts
//
// Pure clock-skew math for system notices (STATE.md NG3). The server is
// the only clock that matters: `computeServerOffsetMs` anchors a server
// timestamp (GET /notices/active's `serverNowMs`, or a socket envelope's
// `tsMs`) to this client's own Date.now() at the moment it was received,
// and every later countdown recomputes `effectiveAtMs - (Date.now() +
// offset)` rather than trusting the local wall clock alone (N4's
// exit-gate line: "no client ever computes from its own wall clock
// alone"). No I/O, no React — kept pure and file-local so the
// skewed-clock/zero-crossing math is testable without mounting a
// component.

/** `nowMs` defaults to `Date.now()` — overridable only for tests. */
export function computeServerOffsetMs(serverAnchorMs: number, nowMs: number = Date.now()): number {
  return serverAnchorMs - nowMs;
}

/** Offset-corrected "now", per NG3's formula. */
export function correctedNowMs(offsetMs: number, nowMs: number = Date.now()): number {
  return nowMs + offsetMs;
}

/** Milliseconds remaining until `targetMs`, clamped to zero — a countdown
 *  never goes negative (N4: "at zero the banner switches to a static...
 *  state"). */
export function remainingMs(targetMs: number, offsetMs: number, nowMs: number = Date.now()): number {
  return Math.max(0, targetMs - correctedNowMs(offsetMs, nowMs));
}
