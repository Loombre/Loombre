// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-session-presence.ts
//
// "Is anyone actually on the other end of this row?" — the one answer both
// admin now-playing surfaces (components/admin/StreamsPanel and
// app/admin/sessions) render and count on.
//
// WHY THIS EXISTS (d3-e3, browser-admin-F2 follow-up): widening the admin
// query to every non-terminal status fixed the disappearing-transcode bug
// and created its mirror image. `suspended` is ONE enum value with TWO
// opposite meanings (packages/db/migrations/0012_transcode_sessions.sql):
//
//   * the worker's segment-ahead throttle parked ffmpeg because it is far
//     enough ahead of the player — the normal state of a healthy 4K stream
//     for most of its life; someone IS watching, and
//   * the sweeper suspended a session it has not heard from in 90 seconds
//     — someone WAS watching and walked away; nothing ends that row for
//     another 13.5 minutes (the 15-minute stale cutoff).
//
// Both used to render the identical "Suspended" pill and both counted
// toward "Active streams · n", so the dashboard confidently reported a
// viewer who had left. The server now sends `suspendedByThrottle` (which
// cause) and `heartbeatStale` (derived against the deployment's own
// sessions.heartbeatSuspendCutoffMs — never a clock guess made here); this
// module turns that pair into the pill and the live/not-live decision, so
// the two surfaces cannot drift apart.
//
// Both fields are additive-optional in the contract: an older server that
// omits them degrades to exactly the pre-d3-e3 behaviour (plain status
// pill, everything counted live) rather than to a wrong answer.

import { describeSessionStatus, type StatusPillInfo } from "./admin-status.js";

export interface AdminSessionPresenceInput {
  status: string;
  suspendedByThrottle?: boolean | null | undefined;
  heartbeatStale?: boolean | null | undefined;
}

export interface AdminSessionPresence extends StatusPillInfo {
  /** False = nobody is on the other end right now. The row still renders
   *  (it exists, and an admin ending it is a legitimate action) but it must
   *  not be counted as a live stream. */
  live: boolean;
}

/** Label copy for a session nothing has been heard from. Deliberately about
 *  the DEVICE going quiet, not about "abandoned" — a phone that lost Wi-Fi
 *  mid-episode is the same row. */
export const NO_HEARTBEAT_LABEL = "No heartbeat";

/** Label copy for the throttle's own park: the encoder is idle BECAUSE it
 *  is comfortably ahead, which is the opposite of a problem. */
export const BUFFERED_AHEAD_LABEL = "Buffered ahead";

export function describeSessionPresence(session: AdminSessionPresenceInput): AdminSessionPresence {
  // Staleness wins over every status: a row nobody is feeding is not live,
  // whatever the transport was last doing.
  if (session.heartbeatStale === true) {
    return { label: NO_HEARTBEAT_LABEL, tone: "neutral", live: false };
  }
  if (session.status === "suspended" && session.suspendedByThrottle === true) {
    return { label: BUFFERED_AHEAD_LABEL, tone: "info", live: true };
  }
  return { ...describeSessionStatus(session.status), live: true };
}

/** The "Active streams · n" number: rows with a live viewer behind them. */
export function countLiveSessions(sessions: readonly AdminSessionPresenceInput[]): number {
  return sessions.reduce((count, session) => (describeSessionPresence(session).live ? count + 1 : count), 0);
}
