// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-live-refresh.ts
//
// How often the admin now-playing surfaces (components/admin/StreamsPanel
// and app/admin/sessions) re-poll GET /admin/sessions on top of their
// playback.started/playback.ended socket subscriptions.
//
// WHY A TICK AT ALL (browser-admin-F2): a session's status changes several
// times during ONE uninterrupted stream — the segment-ahead throttle
// (apps/worker/src/transcode/throttle.ts, docs/PLAYBACK.md §9) flips a
// steady-state transcode suspended <-> active every few tens of seconds,
// and a seek moves it through `seeking`. When this tick was written NONE of
// those transitions emitted a domain event (packages/contract/
// event-schemas/ had playback.started/.ended/.progress only), so a
// socket-only page rendered whatever status happened to be true at mount and
// then lied until a manual reload — and a 10s poll was the honest floor.
//
// WHY IT IS NO LONGER THE PRIMARY PATH (d3-e5): that event now exists.
// `playback.session-status-changed` (admin-only delivery) fires on every
// suspend/resume/seek/pipeline transition, and both surfaces patch the
// affected row from it immediately (lib/admin-session-status-live.ts). This
// tick stays as the FALLBACK — deliberately not deleted — because it is
// still the only thing that corrects the two facts an event cannot carry:
//   * `heartbeatStale`, derived per REQUEST against the deployment's own
//     sessions.heartbeatSuspendCutoffMs (lib/admin-session-presence.ts) —
//     nothing transitions when a client simply stops sending heartbeats, so
//     no event will ever announce it;
//   * a row that ended, started, or changed on a page this client missed
//     (a dropped socket, a restricted item whose ITEM_ONLY_TYPES
//     playback.started never reached this admin).
//
// 30s is chosen for that fallback role: the throttle's own cadence
// (suspend at ahead > 10 segments = 60s, resume at ahead <= 5 = 30s) no
// longer sets the floor now that those flips arrive as events, so the poll
// only has to bound how long a HEARTBEAT-derived fact can be stale — and
// the sweeper's own suspend cutoff is 90s, three of these ticks. Tripling
// the interval cuts the standing request rate of an idle open dashboard to
// a third. The request is an admin-only keyset page read — no Tier-0 CPU
// work on the server side (docs/PLAN.md §9).
export const ADMIN_SESSIONS_REFRESH_MS = 30_000;

/**
 * Start the tick for one admin now-playing surface; returns its cleanup.
 *
 * d3-e4: the bare `setInterval` both surfaces used kept polling at the full
 * cadence with the tab in the background (verified: exactly 10s while
 * hidden) — a request every ten seconds, forever, for a screen nobody is
 * looking at. A hidden tab now skips its ticks entirely and takes ONE
 * refresh the moment it becomes visible again, so coming back to the tab
 * shows current data immediately instead of up-to-a-tick-old data (which is
 * what a plain pause, with no wake-up refresh, would have made worse).
 *
 * `document` is guarded because these modules are imported during Next's
 * server render; the interval alone is still correct there (it simply never
 * fires before the effect's cleanup runs).
 */
export function startAdminSessionsRefresh(refresh: () => void): () => void {
  const timer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    refresh();
  }, ADMIN_SESSIONS_REFRESH_MS);

  if (typeof document === "undefined") return () => clearInterval(timer);

  const onVisibilityChange = (): void => {
    if (!document.hidden) refresh();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
