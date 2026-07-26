// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/renewal.ts
//
// Renewal window math (P4.4: "renew inside 30-day window") kept as pure
// functions of (notAfterMs, nowMs, windowDays) — no Date.now() calls
// baked in anywhere here, so every case is fake-clock testable without
// real sleeps (same discipline packages/playback-engine's clock-as-argument
// rule enforces, applied here even though this package sits outside that
// engine's purity boundary).
//
// The scheduler wrapper (startRenewalScheduler) is the one place real
// timers get involved — it exists to run the daily check in a live
// process, and accepts injectable timer functions + an injectable clock
// so its OWN test can still avoid real sleeps (vi.useFakeTimers).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_RENEW_WINDOW_DAYS = 30;
export const DEFAULT_RENEW_CHECK_INTERVAL_MS = MS_PER_DAY;

/** True once `nowMs` has entered the renewal window before `notAfterMs`
 *  (inclusive of the boundary instant itself). A cert that has ALREADY
 *  expired (nowMs > notAfterMs) is also "within the window" — renewal is
 *  still the correct action, just an overdue one. */
export function isWithinRenewalWindow(
  notAfterMs: number,
  nowMs: number,
  windowDays: number = DEFAULT_RENEW_WINDOW_DAYS,
): boolean {
  const windowMs = windowDays * MS_PER_DAY;
  return nowMs >= notAfterMs - windowMs;
}

/** Milliseconds until the renewal window opens; 0 if already inside it
 *  (never negative — "due" and "overdue" both read as 0, the caller's
 *  daily poll loop doesn't need to distinguish them). */
export function msUntilRenewalDue(
  notAfterMs: number,
  nowMs: number,
  windowDays: number = DEFAULT_RENEW_WINDOW_DAYS,
): number {
  const windowMs = windowDays * MS_PER_DAY;
  return Math.max(0, notAfterMs - windowMs - nowMs);
}

export interface RenewalSchedulerOptions {
  checkIntervalMs?: number;
  /** Injectable for tests; production leaves these as the real timer
   *  globals. Typed loosely (not NodeJS.Timeout-specific) so both Node's
   *  timer handle and a test double satisfy it. */
  setIntervalFn?: (handler: () => void, timeoutMs: number) => { unref?: () => void };
  clearIntervalFn?: (handle: { unref?: () => void }) => void;
  onError?: (err: unknown) => void;
}

/** Starts a recurring "check whether renewal is due, and if so renew"
 *  loop. Returns a stop function. The interval timer is `.unref()`'d
 *  (when the handle supports it — real Node timers do) so a lone renewal
 *  timer never keeps the process alive by itself; graceful shutdown paths
 *  should still call the returned stop function directly rather than
 *  relying on unref. Errors from `checkAndRenew` are caught and routed to
 *  `onError` (default: swallow-and-log) so one failed renewal attempt
 *  never crashes the interval loop — the next daily tick tries again. */
export function startRenewalScheduler(
  checkAndRenew: () => Promise<void>,
  opts: RenewalSchedulerOptions = {},
): () => void {
  const intervalMs = opts.checkIntervalMs ?? DEFAULT_RENEW_CHECK_INTERVAL_MS;
  const setIntervalFn = opts.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  const onError = opts.onError ?? ((err) => console.error("[tls/renewal] renewal check failed:", err));

  const handle = setIntervalFn(() => {
    checkAndRenew().catch(onError);
  }, intervalMs);
  handle.unref?.();

  return () => clearIntervalFn(handle);
}
