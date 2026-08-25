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
// and a seek moves it through `seeking`. NONE of those transitions emits a
// domain event (packages/contract/event-schemas/ has playback.started /
// .ended / .progress only), so a socket-only page renders whatever status
// happened to be true at mount and then lies until a manual reload. Until
// a status-transition event exists (see this finding's follow-up note),
// this tick is the honest floor.
//
// 10s is chosen against the throttle's own cadence (suspend at ahead > 10
// segments = 60s, resume at ahead <= 5 = 30s): fast enough that a status
// pill is never more than a tick stale, slow enough to stay a rounding
// error next to the socket traffic these pages already carry. The request
// is an admin-only keyset page read — no Tier-0 CPU work on the server
// side (docs/PLAN.md §9).
export const ADMIN_SESSIONS_REFRESH_MS = 10_000;

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
