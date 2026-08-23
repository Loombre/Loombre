// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/source-time.ts
//
// The client half of the V8 two-timeline model (docs/PLAYBACK.md §9.1.9
// "Seek algorithm"; STATE.md "Seek model V8"). A transcode session's served
// playlist is ONE continuous presentation timeline over a NON-monotonic
// source timeline — every seek/switch restart appends a new `runN/` run at
// the tail, and §9.1.5 rule 7 stamps every segment with
// `EXT-X-PROGRAM-DATE-TIME` whose epoch IS source time (source 0 ==
// 1970-01-01T00:00:00.000Z), so hls.js's `frag.programDateTime` in ms IS
// the fragment's source start.
//
// Everything here is PURE (no hls.js import, no DOM, no clock — callers
// pass `nowMs`): the fragment list is a structural snapshot of the CURRENT
// LEVEL DETAILS. Amendment A2 is load-bearing throughout: the soft/hard
// boundary is the LISTED playlist window, never buffer state — an
// in-window-but-unbuffered target is a SOFT seek (hls.js fetches listed
// fragments locally), and classifying it hard would burn a Tier-0 ffmpeg
// restart for a position already on disk.

/** Structural mirror of the hls.js Fragment fields this module reads —
 *  declared locally so the module needs no hls.js import and unit tests
 *  need no hls.js instance. */
export interface ListedFragment {
  /** hls.js `frag.programDateTime` (ms) — under the V8 source-clock
   *  convention this IS the fragment's source start. `null` when the
   *  playlist carries no PDT (direct-play never gets here; a pre-V8
   *  server). */
  programDateTimeMs: number | null;
  /** Presentation start, seconds (hls.js `frag.start`). */
  startSec: number;
  durationSec: number;
  /** hls.js `frag.relurl` — carries the `runN/` prefix that identifies
   *  which run produced the fragment. */
  relurl: string | null;
}

/**
 * Hard-seek landing timeout — a NAMED CONSTANT, not runtime config (V8
 * ruling Q3). Sizing rationale, kept beside the constant per the spec: the
 * 4–6 s cold restart observed on the dev box (M3 Max) is NOT the sizing
 * case; the sizing case is an N100-class Tier-0 host transcoding 4K input
 * (kill + observed exit + spawn + input open + `-ss` + encoder init + one
 * full GOP), which gets the headroom.
 */
export const HARD_SEEK_LANDING_TIMEOUT_MS = 20_000;

/** The landing match window behind the clamped target: input `-ss` snaps
 *  to a keyframe AT OR BEFORE the target, so the seek run's recorded
 *  origin can overstate its first frames by up to one GOP — one nominal
 *  segment (§9.1.5 rule 7's bound). */
export const LANDING_WINDOW_BEHIND_MS = 6_000;
/** Small forward tolerance for duration rounding on the recorded origin. */
export const LANDING_WINDOW_AHEAD_MS = 1_000;

const RUN_PREFIX_RE = /(?:^|\/)run(\d+)\//;

/** The `runN/` index a served-playlist URI carries, `undefined` for
 *  anything else (init URIs resolve through the same prefix; a URI with no
 *  prefix is not a V8 served-playlist fragment at all). */
export function runIndexOfRelurl(relurl: string | null): number | undefined {
  if (!relurl) return undefined;
  const m = RUN_PREFIX_RE.exec(relurl);
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : undefined;
}

/** Whether the listed window carries the V8 source clock at all — the
 *  gate for every mapping below. False -> callers keep pre-V8 behavior
 *  (raw presentation seconds), which stays correct against an unupgraded
 *  server. */
export function hasSourceClock(fragments: readonly ListedFragment[]): boolean {
  return fragments.some((f) => f.programDateTimeMs !== null);
}

/** Highest `runN` index the window currently lists; -1 when none. The
 *  landing watch's "new run" floor. */
export function maxListedRunIndex(fragments: readonly ListedFragment[]): number {
  let max = -1;
  for (const f of fragments) {
    const idx = runIndexOfRelurl(f.relurl);
    if (idx !== undefined && idx > max) max = idx;
  }
  return max;
}

/**
 * PRESENTATION seconds -> SOURCE ms, via the containing fragment's PDT.
 * `null` — never a guess — when the position is outside the listed window
 * or its fragment carries no PDT. Within a run, presentation and source
 * advance 1:1 (§9.1.6), so the intra-fragment remainder carries through
 * unchanged.
 */
export function presentationToSourceMs(fragments: readonly ListedFragment[], presentationSec: number): number | null {
  for (let i = 0; i < fragments.length; i += 1) {
    const f = fragments[i]!;
    const end = f.startSec + f.durationSec;
    const isLast = i === fragments.length - 1;
    if (presentationSec >= f.startSec && (presentationSec < end || (isLast && presentationSec <= end))) {
      if (f.programDateTimeMs === null) return null;
      return Math.round(f.programDateTimeMs + (presentationSec - f.startSec) * 1000);
    }
  }
  return null;
}

/**
 * SOURCE ms -> PRESENTATION seconds — the SOFT-seek mapping (A2: LISTED,
 * not loaded; buffer state plays no part). `null` when no listed fragment
 * covers the source position — the HARD-seek trigger.
 */
export function sourceToPresentationSec(fragments: readonly ListedFragment[], sourceMs: number): number | null {
  for (let i = 0; i < fragments.length; i += 1) {
    const f = fragments[i]!;
    if (f.programDateTimeMs === null) continue;
    const endMs = f.programDateTimeMs + f.durationSec * 1000;
    const isLast = i === fragments.length - 1;
    if (sourceMs >= f.programDateTimeMs && (sourceMs < endMs || (isLast && sourceMs <= endMs))) {
      return f.startSec + (sourceMs - f.programDateTimeMs) / 1000;
    }
  }
  return null;
}

/** Presentation-axis buffered ranges -> source axis, for the scrubber's
 *  buffered bars. Ranges (or parts) that don't map are dropped rather than
 *  guessed — a wrong bar is worse than a missing one. */
export function bufferedRangesToSource(
  fragments: readonly ListedFragment[],
  ranges: readonly { startMs: number; endMs: number }[],
): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  for (const range of ranges) {
    const startSource = presentationToSourceMs(fragments, range.startMs / 1000);
    const endSource = presentationToSourceMs(fragments, range.endMs / 1000);
    if (startSource !== null && endSource !== null && endSource >= startSource) {
      out.push({ startMs: startSource, endMs: endSource });
    }
  }
  return out;
}

/**
 * The hard-seek landing watch (§9.1.9). Armed after the 202 with the
 * CLAMPED target and the window's current max run index; every playlist
 * refresh calls `findLandingFragment` until the seek-spawned run shows up.
 * Re-arming (a re-seek before landing) simply replaces the watch — the
 * newest clamped target wins, earlier seek runs are dead runs the client
 * never lands on (server-side absorption already de-duplicated the
 * column).
 */
export interface LandingWatch {
  clampedTargetMs: number;
  /** Runs at or below this index predate the seek — the landing fragment
   *  must come from a STRICTLY newer run. */
  minRunIndexExclusive: number;
  armedAtMs: number;
}

export function armLandingWatch(
  fragments: readonly ListedFragment[] | null,
  clampedTargetMs: number,
  nowMs: number,
): LandingWatch {
  return {
    clampedTargetMs,
    minRunIndexExclusive: fragments ? maxListedRunIndex(fragments) : -1,
    armedAtMs: nowMs,
  };
}

/**
 * The landing match — BOTH conditions required (§9.1.9): the fragment's
 * `runN/` prefix must EXCEED the highest run index seen when the watch was
 * armed (the prefix alone could be a §9.1.4 handoff run… but only a NEWER
 * run can be the seek's), AND its PDT must fall within
 * `[clampedTarget − one GOP, clampedTarget + ε]` (the PDT alone could
 * false-positive on in-window content near the target). Returns the
 * EARLIEST matching fragment in presentation order — where the new run's
 * content begins.
 */
export function findLandingFragment(fragments: readonly ListedFragment[], watch: LandingWatch): ListedFragment | null {
  let best: ListedFragment | null = null;
  for (const f of fragments) {
    const runIdx = runIndexOfRelurl(f.relurl);
    if (runIdx === undefined || runIdx <= watch.minRunIndexExclusive) continue;
    if (f.programDateTimeMs === null) continue;
    if (
      f.programDateTimeMs < watch.clampedTargetMs - LANDING_WINDOW_BEHIND_MS ||
      f.programDateTimeMs > watch.clampedTargetMs + LANDING_WINDOW_AHEAD_MS
    ) {
      continue;
    }
    if (best === null || f.startSec < best.startSec) best = f;
  }
  return best;
}

export function landingWatchExpired(watch: LandingWatch, nowMs: number, timeoutMs = HARD_SEEK_LANDING_TIMEOUT_MS): boolean {
  return nowMs - watch.armedAtMs >= timeoutMs;
}

// ── Post-landing resume evidence (browser-player-F4) ─────────────────────
// The LEVEL_UPDATED fragment match ends run DISCOVERY, not the seek: the
// element still has to fetch/append data at the landed position before
// anything is watchable, and a seek at/near EOF can land on a run with
// nothing displayable in it (the QA 2026-08-20/21 wedge). The hard-seek
// lifecycle therefore stays open — timer running, position pinned — until
// one of the events that can mean "the landed position is displayable"
// (`seeked`/`canplay`/`playing`/`timeupdate`) passes this predicate, or
// `ended` fires, or the 20 s timeout surfaces the toast.

/** W3C HAVE_CURRENT_DATA — the `readyState` floor at which the element can
 *  actually display its current position. A literal, not the global
 *  `HTMLMediaElement.HAVE_CURRENT_DATA`, for the same jsdom reason as
 *  VideoPlayer's MEDIA_ERR_* literals (the test environment defines no
 *  media constants). */
const HAVE_CURRENT_DATA = 2;

/** Backward tolerance on the landed presentation position for the
 *  NO-SOURCE-CLOCK fallback below (the native coarse path) — float slop
 *  only: the landing ASSIGNS currentTime, and the seek algorithm reports
 *  the set position back exactly. */
export const LANDING_RESUME_EPSILON_SEC = 0.01;

/** How far PAST the landed target the source-mapped position may already
 *  be and still count as this seek's own resume (the element can play a
 *  little of the landed run between the data arriving and the next
 *  `timeupdate`/`canplay` we observe — and the clean at-EOF playout ends
 *  within one clamped-back nominal segment of the target). Generous is
 *  fine: the failure this predicate rejects sits THOUSANDS of seconds
 *  away on the source axis, not tens. */
export const LANDING_RESUME_FORWARD_TOLERANCE_MS = 30_000;

/**
 * Whether the element state proves the LANDED hard seek actually became
 * watchable — a displayable frame (`readyState`) showing content from the
 * TARGET's own source region.
 *
 * The comparison runs on the SOURCE axis whenever the window carries the
 * V8 clock: presentation positions cannot discriminate here, because the
 * failure shape (browser-player-F4 live QA) is a seek the UA CLAMPED onto
 * the OLD content's tail — a presentation position within MILLISECONDS of
 * the landed run's start (the gap is only nominal-EXTINF-vs-real-media
 * slop) whose source position is thousands of seconds from the target.
 * Mapping `currentTime` through the listed window answers the real
 * question — "is the viewer looking at what they seeked to?" — with the
 * same behind-window the landing match itself uses. Without a source
 * clock (native coarse landing) the presentation fallback stands.
 */
export function isLandingResumeEvidence(
  landed: { startSec: number; targetMs: number },
  currentTimeSec: number,
  readyState: number,
  fragments: readonly ListedFragment[] | null,
): boolean {
  if (readyState < HAVE_CURRENT_DATA) return false;
  if (fragments && hasSourceClock(fragments)) {
    const mappedMs = presentationToSourceMs(fragments, currentTimeSec);
    return (
      mappedMs !== null &&
      mappedMs >= landed.targetMs - LANDING_WINDOW_BEHIND_MS &&
      mappedMs <= landed.targetMs + LANDING_RESUME_FORWARD_TOLERANCE_MS
    );
  }
  return currentTimeSec >= landed.startSec - LANDING_RESUME_EPSILON_SEC;
}
