// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/track-load-failure.ts
//
// The one line of copy the music mini player shows when a queued track
// can't be loaded (components/music/MusicPlayerProvider.tsx's
// `failTrackLoad`). Music has no dedicated unavailable-state surface — the
// video player's UnavailableScreen is its own deliverable — so the whole
// surface is a single danger toast, and it has to say three things in one
// breath: WHICH track failed, WHY, and what happens next.
//
// Pure and I/O-free on purpose: the provider owns the session/queue
// lifecycle, this owns only the wording, so the wording is unit-testable
// without rendering the provider or faking a session.

export interface TrackLoadFailure {
  /** Title of the track that couldn't be loaded, as it appears in the queue. */
  title: string;
  /** Why it failed, in the user's language — an RFC 9457 problem `detail`
   *  by way of lib/api-error-message.ts, or a plan reason's title from
   *  lib/playback-reasons.ts. Null/blank when nothing specific is known,
   *  which is a real case (a bare network drop). */
  reason?: string | null;
  /** Whether there is another track after this one. Drives the tail: a
   *  skip only gets announced when a skip actually happens. */
  hasNext: boolean;
}

/** Trailing sentence punctuation is stripped so the composed message ends
 *  in exactly one period regardless of whether the server's `detail`
 *  brought its own. */
function normalizeReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim().replace(/[.!\s]+$/u, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Single-line failure copy for the mini player's toast, e.g.
 * `Can't play "Low Water" — The file for this track is missing. Skipping to
 * the next track.` The toast pill uppercases and wraps it
 * (components/ui/Toast.module.css), so this stays sentence-cased and does
 * not budget for a line length.
 */
export function trackLoadFailureMessage({ title, reason, hasNext }: TrackLoadFailure): string {
  const trimmedTitle = title.trim();
  const name = trimmedTitle.length > 0 ? `"${trimmedTitle}"` : "this track";
  const why = normalizeReason(reason);
  const tail = hasNext ? "Skipping to the next track." : "Nothing else in the queue.";
  return why === null ? `Can't play ${name}. ${tail}` : `Can't play ${name} — ${why}. ${tail}`;
}
