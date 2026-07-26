// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/plugin-delivery-status.ts
//
// Lane W5b: pure, framework-free copy for the admin Plugin detail page's
// delivery-status panel (GET /admin/plugins/{id}'s additive `deliveryStatus`
// field, event-subscriber plugins only) — same register-language voice
// lib/plugin-manifest.ts's describeEventSubscriberScope already establishes
// ("the activity feed", "an anonymous id", never "webhook"/"outbox"/
// "circuit breaker"/"retention window"). Reuses lib/admin-capability-format.ts's
// formatProbeAge for relative-time strings rather than a second
// implementation of the same coarse-bucket formatting.
//
// A plugin failing every delivery attempt and a plugin with simply nothing
// new to deliver look IDENTICAL from `lastAttemptMs` alone — the same
// distinction migrations/0016_plugin_delivery_cursors.sql's column
// comments call out — so `describeDeliveryStatus` reads `lastSuccessMs`
// (not `lastAttemptMs`) for its headline, and `consecutiveFailures` is what
// actually decides whether the failure-streak warning appears.

import { formatProbeAge } from "./admin-capability-format.js";

export interface PluginDeliveryStatusLike {
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
  consecutiveFailures: number;
  deliveredBatches: number;
  deliveredEvents: number;
  gapReportedThroughMs: number | null;
}

export interface DeliveryStatusSummary {
  /** Always present — "Hasn't delivered anything yet." when this plugin has
   *  never been through the delivery loop, or has a row but zero successes
   *  yet; otherwise "Last delivered <n events> in <n batches>, <relative
   *  time> ago." */
  headline: string;
  /** Non-null iff consecutiveFailures > 0 — a plain-language failure-streak
   *  warning naming the streak length and how long ago the last (failing)
   *  attempt was, WITHOUT the word "breaker"/"circuit". */
  failureWarning: string | null;
  /** Non-null iff gapReportedThroughMs is set — explains, in register
   *  language, that some activity from before that point was skipped
   *  because the plugin was unreachable for longer than Loombre keeps a
   *  backlog, without ever using the word "retention window"/"gap". */
  gapNotice: string | null;
}

/** `null` deliveryStatus (no plugin_delivery_cursors row at all) — the
 *  panel's caller renders this exact string rather than calling
 *  describeDeliveryStatus at all when `deliveryStatus` is null; exported so
 *  the two call sites (and their tests) share one literal. */
export const NEVER_DELIVERED_HEADLINE = "Hasn't delivered anything yet.";

export function describeDeliveryStatus(status: PluginDeliveryStatusLike, nowMs: number): DeliveryStatusSummary {
  const headline =
    status.lastSuccessMs === null
      ? NEVER_DELIVERED_HEADLINE
      : `Delivered ${status.deliveredEvents} event${status.deliveredEvents === 1 ? "" : "s"} in ${status.deliveredBatches} batch${status.deliveredBatches === 1 ? "" : "es"} — last delivered ${formatProbeAge(status.lastSuccessMs, nowMs)}.`;

  const failureWarning =
    status.consecutiveFailures > 0
      ? `Hasn't been reachable for the last ${status.consecutiveFailures} attempt${status.consecutiveFailures === 1 ? "" : "s"}` +
        (status.lastAttemptMs !== null ? ` — last tried ${formatProbeAge(status.lastAttemptMs, nowMs)}.` : ".")
      : null;

  const gapNotice =
    status.gapReportedThroughMs !== null
      ? `Some activity from before ${new Date(status.gapReportedThroughMs).toLocaleString()} couldn't be delivered and was skipped — this plugin was unreachable for longer than Loombre keeps a backlog for it.`
      : null;

  return { headline, failureWarning, gapNotice };
}
