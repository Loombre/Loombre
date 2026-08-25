// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-session-status-live.ts
//
// Folding one `playback.session-status-changed` event into an admin
// now-playing list — the low-latency counterpart to lib/
// admin-session-merge.ts (which applies a whole fetched page 1) and lib/
// admin-live-refresh.ts (which decides how often that happens).
//
// WHY (d3-e5, browser-admin-F2 follow-up): a session's status changes
// several times inside ONE uninterrupted stream — the segment-ahead throttle
// parks and resumes a transcode every few tens of seconds, a seek moves it
// through `seeking` — and NONE of that used to emit anything. Both admin
// surfaces therefore re-polled GET /admin/sessions every 10 seconds purely
// to keep a status pill honest. The transition now has its own admin-only
// domain event (packages/contract/event-schemas/
// playback.session-status-changed.schema.json), so the pill updates the
// moment the worker writes the row and the poll drops back to a fallback
// cadence.
//
// WHAT MAY BE PATCHED, and why the answer is "almost nothing":
// StreamsPanel.tsx's header states the rule this module obeys — only the
// server's listActiveSessionsAdmin applies the P2.8 redaction contract, so
// the client must never synthesize a row or re-derive a field it did not
// fetch (U9: never fabricate). This payload is deliberately transport-only
// (see the schema's `description`): sessionId, both sides of the status
// move, and the throttle flag. Those two facts, plus updatedAtMs, are
// exactly what gets written into the row — everything else is left as
// fetched, and an unknown session id is handed back to the caller as a
// refetch rather than invented.
//
// PlaybackSessionStatusChangedPayload is hand-mirrored from the event
// schema for the same reason lib/admin-jobs-live.ts's JobUpdatedPayload is:
// event-schema payloads are not part of the openapi.yaml-derived
// @loombre/sdk types, so there is no generated type to import.

/** Mirrors packages/contract/event-schemas/playback.session-status-changed.schema.json. */
export interface PlaybackSessionStatusChangedPayload {
  sessionId: string;
  previousStatus: string;
  status: string;
  suspendedByThrottle: boolean;
  reason: string;
  changedAtMs: number;
}

/** The subset of an AdminSession this patch touches (structural, so the SDK
 *  type and any test fixture both satisfy it). */
export interface PatchableAdminSession {
  id: string;
  status: string;
  suspendedByThrottle?: boolean;
  updatedAtMs: number;
}

/**
 * Folds one transition into the list, in place.
 *
 * Returns `null` — meaning "I could not apply this, do whatever you do
 * normally" — in the two cases where patching would be wrong rather than
 * merely unnecessary:
 *
 *   - the session is not on screen. It may be brand new, or it may live on a
 *     page the admin has not loaded; either way the row's other fields (and
 *     its redaction) can only come from the server, so the caller refetches.
 *   - the row already says exactly this. A duplicate delivery, or a
 *     transition the last poll already picked up, must not push a new array
 *     identity through React for nothing.
 *
 * `heartbeatStale` is pointedly NOT touched. It is derived per REQUEST from
 * the deployment's own sessions.heartbeatSuspendCutoffMs (see lib/
 * admin-session-presence.ts), and a worker-side pipeline transition says
 * nothing about whether the CLIENT is still there — the fallback poll is
 * what corrects it, within one cadence.
 */
export function mergeSessionStatusChange<T extends PatchableAdminSession>(
  sessions: readonly T[],
  update: PlaybackSessionStatusChangedPayload,
): T[] | null {
  const index = sessions.findIndex((session) => session.id === update.sessionId);
  if (index === -1) return null;

  const existing = sessions[index]!;
  if (existing.status === update.status && (existing.suspendedByThrottle ?? false) === update.suspendedByThrottle) {
    return null;
  }

  const next = sessions.slice();
  next[index] = {
    ...existing,
    status: update.status,
    suspendedByThrottle: update.suspendedByThrottle,
    updatedAtMs: update.changedAtMs,
  };
  return next;
}
