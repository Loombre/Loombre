// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/src/timeouts.ts
//
// LD8: named, exported constants — every outbound plugin call carries a
// hard timeout budget (C6/C7: "no plugin can stall anything"), and the
// breaker threshold that auto-disables a plugin after repeated failures.
// These are DEFAULTS every caller may override per-call (callPlugin.ts's
// options accept an explicit `timeoutMs`) — named here so every capability
// integration (W3/W4) and this lane's own health checks reference the SAME
// numbers rather than re-deriving them.

/** GET /lpp/manifest (registration + re-fetch). */
export const LPP_MANIFEST_TIMEOUT_MS = 10_000;

/** POST <endpoints.search>. */
export const LPP_SEARCH_TIMEOUT_MS = 10_000;

/** POST <endpoints.details>. */
export const LPP_DETAILS_TIMEOUT_MS = 10_000;

/** POST <endpoints.images> — longer budget: an images response can
 *  legitimately enumerate more entries than a search/details call. */
export const LPP_IMAGES_TIMEOUT_MS = 20_000;

/** POST <delivery.endpoint> (event-subscriber batch delivery). */
export const LPP_DELIVERY_TIMEOUT_MS = 10_000;

/** Manifest response size cap while streaming (LD5) — a manifest is a
 *  small, bounded document; 256 KiB is generous headroom over any
 *  legitimate manifest while still making a runaway/malicious response a
 *  bounded-memory failure rather than an unbounded one. */
export const LPP_MANIFEST_MAX_BYTES = 256 * 1024;

/** Response size cap for search/details/images/delivery capability calls
 *  (LD5 "make caps arguments" — every hardenedFetch/callPlugin caller
 *  supplies one; the mission text pins ONLY the manifest cap by number,
 *  this one is a lane decision, not a rail). 2 MiB is generous headroom
 *  over any legitimate metadata-provider search/details response or event
 *  batch while still bounding worst-case memory per call. */
export const LPP_CAPABILITY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** LD8: consecutive call FAILURES (timeout or network-level error — see
 *  call-plugin.ts's header for exactly which HardenedFetchError reasons
 *  count) before the host auto-disables a plugin. This is the THRESHOLD
 *  packages/db/migrations/0014_plugins.sql's plugins.consecutive_failures
 *  column is compared against by apps/server/src/plugins's health/breaker
 *  service — that DB column is the durable, cross-process count; this
 *  package's PluginCircuitBreaker (breaker.ts) is the in-process fast-path
 *  gate over the same signal, not a second source of truth. */
export const LPP_BREAKER_FAILURE_THRESHOLD = 5;

/** Not pinned by the mission rails (documented lane decision, see this
 *  lane's final report): how long an OPEN breaker waits before allowing one
 *  half-open trial call through. 60s balances "don't hammer a plugin that
 *  just tripped the breaker" against "don't leave a recovered plugin gated
 *  for an unreasonably long time" — no other numeric hint exists anywhere
 *  in the mission text or spec for this constant. */
export const LPP_BREAKER_RESET_TIMEOUT_MS = 60_000;
