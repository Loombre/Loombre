// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Loombre :: apps/web/src/components/shell/use-scan-status.ts
//
// THE shared "is a library scan running right now" flag for the shell
// chrome — A1 (run UIFIX-2026-08-29). It is the scan.started/scan.completed
// subscription Sidebar.tsx used to hold privately (its `useScanBadge`),
// LIFTED here unchanged in behaviour so the desktop topbar's new left flank
// (Topbar.tsx) and the sidebar's Dashboard pill read the SAME state instead
// of two components each opening their own listener pair and tracking their
// own job-id set. Two independent sets would also be free to disagree: the
// events socket delivers each frame to every listener, but a consumer that
// mounts mid-scan starts from an empty set and would show "no scan running"
// while its sibling shows one.
//
// Shape deliberately mirrors lib/watchlist-id-store.ts (browser-items-F9) —
// module-level state + useSyncExternalStore + attach-on-first-listener /
// detach-on-last: N consumers share exactly ONE pair of getEventsSocket()
// subscriptions, however many mount, including under dev StrictMode's
// double-invoked effects. That file is the repo's precedent for this
// discipline; this one is its smaller sibling (no fetch to share — a scan
// flag is live-events-only, see below).
//
// Live for the session only, never seeded: scan.started/scan.completed
// (packages/contract/event-schemas/scan.{started,completed}.schema.json) are
// the only source, and there is no "is anything scanning" endpoint to seed
// from — so a client that connects mid-scan reports "not scanning" until the
// next event, exactly as the sidebar badge always has. That is the honest
// answer (U9: never fabricate), not a regression introduced by the lift.
//
// `enabled` is the caller's isAdmin: a non-admin never subscribes at all
// (same gate the private hook had), so the flag stays false and no listener
// is attached for a viewer who has no scan surface to see it on.

import { useSyncExternalStore } from "react";
import { getEventsSocket, type EventEnvelope } from "../../lib/events-socket.js";

interface ScanJobPayload {
  jobId: string;
}

/** Tracked by jobId (not a bare counter) so overlapping scans across
 *  libraries can't clear the flag early — the exact rule Sidebar.tsx's
 *  header documented for the badge before the lift. */
const activeJobIds = new Set<string>();
const listeners = new Set<() => void>();
let socketUnsubscribers: Array<() => void> = [];
let scanning = false;

function emit(): void {
  const next = activeJobIds.size > 0;
  if (next === scanning) return;
  scanning = next;
  for (const listener of listeners) listener();
}

function attachSocket(): void {
  if (socketUnsubscribers.length > 0) return;
  const socket = getEventsSocket();
  socketUnsubscribers = [
    socket.subscribe<ScanJobPayload>("scan.started", (e: EventEnvelope<ScanJobPayload>) => {
      activeJobIds.add(e.payload.jobId);
      emit();
    }),
    socket.subscribe<ScanJobPayload>("scan.completed", (e: EventEnvelope<ScanJobPayload>) => {
      activeJobIds.delete(e.payload.jobId);
      emit();
    }),
  ];
}

function detachSocket(): void {
  for (const unsub of socketUnsubscribers) unsub();
  socketUnsubscribers = [];
}

/** useSyncExternalStore subscribe: the FIRST consumer attaches the one
 *  shared listener pair, every later one joins the same snapshot, and the
 *  LAST to leave detaches and drops the tracked jobs (nothing is cached past
 *  the lifetime of the consumers — the same rule watchlist-id-store.ts's
 *  reset() follows, for the same reason: a set of unknown age is worse than
 *  no set). */
export function subscribeScanStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) attachSocket();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    detachSocket();
    activeJobIds.clear();
    scanning = false;
  };
}

export function getScanStatusSnapshot(): boolean {
  return scanning;
}

/** SSR/hydration: the server render knows nothing about this client's live
 *  socket, so it is always "not scanning" (same posture as
 *  getWatchlistIdsServerSnapshot). */
export function getScanStatusServerSnapshot(): boolean {
  return false;
}

/** Stable no-op subscription for a disabled (non-admin) consumer — a
 *  module-level constant rather than an inline closure so useSyncExternalStore
 *  doesn't re-subscribe on every render. */
function subscribeNever(): () => void {
  return () => {};
}

/** React hook: true while at least one scan job is running, for callers that
 *  are allowed to see scan state at all (`enabled` = isAdmin). Consumed by
 *  Sidebar's Dashboard pill and Topbar's left flank; both read this one
 *  store, so they can never disagree. */
export function useScanStatus(enabled: boolean): boolean {
  return useSyncExternalStore(
    enabled ? subscribeScanStatus : subscribeNever,
    enabled ? getScanStatusSnapshot : getScanStatusServerSnapshot,
    getScanStatusServerSnapshot,
  );
}

/** Test-only escape hatch (same convention as events-socket.ts's
 *  __setEventsSocketForTests / watchlist-id-store.ts's own reset): drop every
 *  listener and subscription and return the module to its idle state. */
export function __resetScanStatusForTests(): void {
  listeners.clear();
  detachSocket();
  activeJobIds.clear();
  scanning = false;
}
