// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/lib/seek-toast.ts
//
// SPF-7 Phase B: the two hard-seek failure toasts VideoPlayer.tsx shows
// (the 20 s landing timeout, and the seek POST itself failing) used to
// carry no code at all — just prose. Every other playback failure surface
// (UnavailableScreen's reason rows, docs/user-guide/playback-errors.md)
// now names a specific kebab code beside its copy; these two toasts get
// the same treatment. Pure formatters (no Toast/DOM dependency) so the
// exact strings are pinned by a plain unit test, the same pattern
// seek-coalesce.ts and relocation-nudge.ts already use for this file's
// neighbors.

/** `armLandingTimer`'s 20 s timeout: the worker never produced the
 *  clamped seek target in time. */
export const SEEK_LANDING_TIMEOUT_CODE = "seek-landing-timeout";

/** The `POST /playback/sessions/{id}/seek` call itself failed (network
 *  error, or a non-2xx response). */
export const SEEK_REQUEST_FAILED_CODE = "seek-request-failed";

export function formatSeekTimedOutToast(): string {
  return `Seek timed out (${SEEK_LANDING_TIMEOUT_CODE}) — the transcoder did not restart in time. Try seeking again.`;
}

/** `status` is the failed request's HTTP status when known (a
 *  `LoombreApiError`'s `.status`) — `null` for a network-layer rejection
 *  that never got a response at all (fetch throwing, offline). */
export function formatSeekFailedToast(status: number | null): string {
  return `Seek failed (${SEEK_REQUEST_FAILED_CODE} · HTTP ${status ?? "?"}) — check the connection and try again.`;
}
