// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/backoff.ts
//
// UNPINNED decision (see constants.ts's header): exponential backoff with
// a hard cap and full jitter, keyed off plugin_delivery_cursors.
// consecutive_failures (persisted — survives a worker restart, unlike
// @loombre/plugin-host's in-memory PluginCircuitBreaker). Pure function,
// no I/O, easy to property-test. Deliberately independent of that
// package's breaker/reset-timeout math — this is retry PACING for the
// delivery loop's own poll cadence, not circuit-breaker admission.

import { LPP_DELIVERY_BACKOFF_BASE_MS, LPP_DELIVERY_BACKOFF_MAX_MS } from "./constants.js";

/**
 * `consecutiveFailures` of 0 means "not currently backing off" (delivery
 * should be attempted immediately, subject to the normal poll interval) —
 * this function still returns a defined (zero) value for that input so
 * callers never need a special case.
 */
export function computeBackoffMs(consecutiveFailures: number, random: () => number = Math.random): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(consecutiveFailures - 1, 30); // guard against overflow at absurd counts
  const capped = Math.min(LPP_DELIVERY_BACKOFF_BASE_MS * 2 ** exponent, LPP_DELIVERY_BACKOFF_MAX_MS);
  // Full jitter (0..capped) avoids every failing plugin retrying in lockstep.
  return Math.floor(capped * random());
}

/** True when enough time has elapsed since `lastAttemptMs` for a retry to
 *  be due, given `consecutiveFailures`' backoff window. A plugin with no
 *  prior attempt (`lastAttemptMs` null) is always due. */
export function isRetryDue(
  consecutiveFailures: number,
  lastAttemptMs: number | null,
  nowMs: number,
  random: () => number = Math.random,
): boolean {
  if (lastAttemptMs === null) return true;
  const backoffMs = computeBackoffMs(consecutiveFailures, random);
  return nowMs - lastAttemptMs >= backoffMs;
}
