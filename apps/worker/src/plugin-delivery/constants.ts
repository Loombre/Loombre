// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/src/plugin-delivery/constants.ts
//
// LPP v1, Lane W4. Timeouts, response caps, and the breaker threshold live
// in @loombre/plugin-host (packages/plugin-host/src/timeouts.ts, LD8) —
// this file imports LPP_DELIVERY_TIMEOUT_MS/LPP_CAPABILITY_MAX_RESPONSE_
// BYTES from there rather than redefining them, so every capability
// integration (W3's metadata-provider, this lane's event-subscriber)
// references the SAME numbers. Everything below is this lane's OWN,
// UNPINNED decision (see the mission report's "unpinned decisions with
// rationale" section) — none of it is locked by the mission brief or the
// LD series.

export { LPP_DELIVERY_TIMEOUT_MS, LPP_CAPABILITY_MAX_RESPONSE_BYTES } from "@loombre/plugin-host";

/** Mission-locked (LPP v1 mission §3.2 "retention window"). */
export const LPP_DELIVERY_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** UNPINNED: cap on how many raw outbox rows a single delivery-loop tick
 *  reads for one plugin, per poll. */
export const LPP_DELIVERY_BATCH_MAX = 100;

/** UNPINNED: how often the delivery loop wakes up and attempts one tick
 *  for every current subscriber plugin. Chosen as a middle ground between
 *  "near real-time fanout" and "don't hammer Postgres with a poll query
 *  every plugin every few seconds" — there is no push/LISTEN wake-up in
 *  this design (the outbox has no NOTIFY trigger today), so this is a
 *  plain poll interval. 5s means a subscriber sees a new event within
 *  0-5s of it landing in the outbox under normal conditions. */
export const LPP_DELIVERY_POLL_INTERVAL_MS = 5_000;

/** UNPINNED: backoff base for a plugin with plugin_delivery_cursors.
 *  consecutive_failures > 0 (apps/worker/src/plugin-delivery/backoff.ts).
 *  Exponential with a cap, full jitter — the shape is unpinned; the
 *  mission brief only requires SOME backoff on failure. */
export const LPP_DELIVERY_BACKOFF_BASE_MS = 2_000;

/** UNPINNED: backoff ceiling — a plugin that has been failing for a long
 *  time is retried at most this often, never less frequently, so a fixed
 *  plugin is never stuck waiting hours to be tried again. */
export const LPP_DELIVERY_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * H-4 fix wave, defense in depth. The registration-time gate
 * (apps/server/src/plugins/event-taxonomy.ts's `ADMIN_ONLY_EVENT_TYPES`
 * exclusion) is what actually PREVENTS a `plugin_event_grants` row for one
 * of these eight types from ever being created — this delivery-loop copy
 * exists so the loop itself can never fan one out even if that upstream
 * gate were ever bypassed (a stale pre-fix DB row, a future bug) — LD8's
 * "no plugin can stall/leak" posture applied to this one axis too.
 * Duplicated (not imported) from apps/server for the SAME reason
 * clearance.ts's `pluginMayReceiveRestricted` is duplicated rather than
 * imported — apps/worker cannot import apps/server, the dependency graph
 * runs the other way (this file's own precedent, and clearance.ts's
 * header). Keep this list in lockstep with event-taxonomy.ts's
 * `ADMIN_ONLY_EVENT_TYPES` and ws-broadcaster.service.ts's `ADMIN_ONLY_TYPES`.
 *
 * `metadata.match-candidates` (Phosphor retheme Wave 2, Lane L2) joined
 * that upstream set for the identical reason — kept in lockstep here too.
 */
export const LPP_DELIVERY_ADMIN_ONLY_EVENT_TYPES: readonly string[] = [
  "job.updated",
  "settings.updated",
  "plugin.registered",
  "plugin.updated",
  "plugin.enabled",
  "plugin.disabled",
  "plugin.removed",
  "plugin.health-changed",
  "metadata.match-candidates",
];
