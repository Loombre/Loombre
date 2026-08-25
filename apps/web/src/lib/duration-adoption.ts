// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/duration-adoption.ts
//
// d3-a4 (A/gap-F10-adjacent, P2): the element-duration adoption rule,
// extracted pure from VideoPlayer's loadedmetadata/durationchange handler.
//
// History of the rule (each clause is a pinned regression):
//   - GROWTH-ONLY on non-direct-play (2026-08-08 owner QA): an in-progress
//     HLS EVENT playlist's element duration is only the extent produced so
//     far (~24s of a 2-hour movie); unconditional adoption clobbered the
//     probed session.media.durationMs and pinned the timeline.
//   - DIRECT-PLAY UNCONDITIONAL (Opus review Finding F, 2026-08-10): no
//     playlist exists — the element demuxes the actual file, strictly more
//     authoritative than an over-long ffprobe artifact; shrinkage included.
//   - SOURCE-AXIS AUTHORITY (gap-F6 round 3): once the session has shown
//     the V8 source clock, the element duration is the served playlist's
//     cumulative PRESENTATION extent — the wrong axis for a source-axis
//     scrubber by construction; the probed duration governs.
//   - d3-a4 adds the last two holes observed live:
//       INTEGER MS — the adopted value was hls.js's float duration*1000
//       (773347.5), and persisting it made every subsequent heartbeat 422
//       ('durationMs must be an integer or null').
//       PLAUSIBILITY BOUND — a RELOCATED playlist (segment numbering
//       continuing past nominal EOF) grows its presentation extent PAST
//       the real file duration before any source clock is seen (the 586s
//       Idol adopted 1810859ms). Growth on non-direct-play is only
//       plausible up to the probed duration plus quantization slack; the
//       probe governs beyond that.

/**
 * How far (ms) a non-direct-play element duration may top the session's
 * probed duration and still be believed. Sized like the landing window's
 * LANDING_WINDOW_BEHIND_MS: one nominal segment — the cumulative
 * EXTINF-vs-real-media slop of a complete playlist stays within a
 * segment's worth, while a relocated playlist's runaway extent blows
 * through it immediately (observed: 3x the probe).
 */
export const DURATION_PLAUSIBILITY_SLACK_MS = 6_000;

export interface DurationAdoptionContext {
  /** The duration the player currently holds (probed at session create,
   *  possibly already adopted-from-element), ms, or null. */
  currentMs: number | null;
  /** docs/PLAYBACK.md §9 discriminator: session.manifestUrl === null. */
  isDirectPlay: boolean;
  /** Sticky source-clock flag (lib/source-clock.ts) — the session has
   *  displayed V8 source-axis positions at least once. */
  sawSourceClock: boolean;
  /** The session's ffprobe duration (session.media.durationMs), ms — the
   *  item's KNOWN duration, never overwritten by adoption. */
  probedDurationMs: number | null;
}

/**
 * The integer ms duration to adopt for the element's reported
 * `video.duration` (seconds), or `null` = keep what the player holds.
 */
export function adoptableDurationMs(candidateSec: number, context: DurationAdoptionContext): number | null {
  if (!Number.isFinite(candidateSec)) return null;
  const candidateMs = Math.round(candidateSec * 1000);
  if (context.isDirectPlay) return candidateMs;
  if (context.sawSourceClock) return null;
  if (context.probedDurationMs !== null && candidateMs > context.probedDurationMs + DURATION_PLAUSIBILITY_SLACK_MS) {
    return null;
  }
  if (context.currentMs !== null && candidateMs <= context.currentMs) return null;
  return candidateMs;
}
