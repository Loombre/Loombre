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
 *
 * d3-a1 (A/gap-F4) boundary preference: the scan runs BACKWARD, so a
 * position covered by BOTH sides of a fragment boundary maps through the
 * LATER fragment. Within a run the two candidates agree to within PDT
 * quantization, but at a RUN boundary they are different timelines — and
 * overlap genuinely happens there: once the old run's fragments have been
 * buffered, hls.js corrects their start/duration from real media PTS
 * while the seek-spawned run's parse-time values stay nominal, so the old
 * tail's recorded end can overstep the new run's recorded start by the
 * EXTINF-vs-real-media slop. A landed hard seek parks the element exactly
 * on that boundary; mapping it through the OLD fragment put the previous
 * run's tail on the paused clock (and, via the resolver, re-anchored the
 * source clock there). The NEW run wins.
 */
export function presentationToSourceMs(fragments: readonly ListedFragment[], presentationSec: number): number | null {
  for (let i = fragments.length - 1; i >= 0; i -= 1) {
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

/**
 * d3-a1 (verify-A): the hard cap on a landing lifecycle that keeps
 * EXTENDING its window across ABR rung switches. A switch mid-landing
 * means the session is demonstrably still working — the pipeline hands
 * off rungs, playlists refresh on the new rung's cadence — so failing the
 * seek at the flat 20 s produced a FALSE 'Seek timed out' toast for a
 * landing that then completed ~40 s in (live verify-A, Thor 4-rung
 * ladder). Each switch re-arms one more timeout window, but never past
 * this total: the §9.1.9 bounded-lifecycle invariant (never an indefinite
 * pin) survives, it just tolerates handoffs.
 */
export const HARD_SEEK_LANDING_MAX_TOTAL_MS = 60_000;

/**
 * How long the re-armed landing timer may run from `nowMs`: one more full
 * timeout window, clipped to whatever remains of the lifecycle's hard
 * cap. `null` — no extension left — once the cap is spent; the caller
 * leaves the currently-armed timer to fire.
 */
export function landingExtensionDelayMs(
  lifecycleStartedAtMs: number,
  nowMs: number,
  timeoutMs: number = HARD_SEEK_LANDING_TIMEOUT_MS,
  maxTotalMs: number = HARD_SEEK_LANDING_MAX_TOTAL_MS,
): number | null {
  const remaining = maxTotalMs - (nowMs - lifecycleStartedAtMs);
  if (remaining <= 0) return null;
  return Math.min(timeoutMs, remaining);
}

/**
 * d3-a1 (A/v8-requal): which hls.js level index the player should read
 * its LISTED WINDOW from. `currentLevel` (the level actually playing)
 * stays authoritative whenever it exists — including when its details are
 * momentarily missing, where callers HOLD rather than borrow another
 * level's axis (browser-player-F6). But before any frame has PLAYED,
 * `currentLevel` is -1 — and the old "fall back to level 0" read a level
 * that never loads: `resolveStartLevel` (lib/hls-js-config.ts) starts
 * hls.js on the server's encoding rung, the TOP of the ladder, so on any
 * multi-rung session only THAT level has details until playback begins.
 * Live consequence: a pre-first-frame hard seek (the v8-requal Start-over
 * on the resume prompt) had a fully parsed window listing its absorbed
 * target and could not read it — the clock pinned at the target for the
 * full 20 s timeout. Fall back to the level being LOADED, then to any
 * level whose details exist.
 */
export function pickReadableLevelIndex(
  currentLevel: number,
  loadLevel: number,
  levelHasDetails: readonly boolean[],
): number {
  if (currentLevel >= 0) return currentLevel;
  if (loadLevel >= 0 && levelHasDetails[loadLevel] === true) return loadLevel;
  const firstWithDetails = levelHasDetails.indexOf(true);
  if (firstWithDetails >= 0) return firstWithDetails;
  return levelHasDetails.length > 0 ? 0 : -1;
}

/**
 * gap-F6 round 3 — the landing `findLandingFragment` can never see: the
 * seek-spawned run EXISTS (fragments strictly newer than the watch's
 * floor are listed) but its coverage has already moved PAST the clamped
 * target — on a fast-completing file the restarted run races to ENDLIST
 * and retention prunes its head before any playlist refresh lists the
 * target's own fragment (live verify refutation: Start-over to 0 froze
 * for the full 20 s while run1's survivors started at ~7:34). The closest
 * position that still exists is the new run's EARLIEST surviving listed
 * fragment; landing there is the same honesty as the tail-only fresh
 * mount, and strictly better than a frozen scrubber and a timeout toast.
 *
 * Returns that earliest fragment ONLY when the relocation has provably
 * overshot: every new-run fragment's PDT starts past the target's own
 * landing window (`> clampedTarget + LANDING_WINDOW_AHEAD_MS`). While any
 * new-run fragment could still BE the landing, or the run's forward
 * growth has not reached a forward target yet, it returns `null` and the
 * watch keeps waiting (a backward-restarted run growing TOWARD a forward
 * target must not land early at its origin).
 */
export function findRelocatedLandingStart(fragments: readonly ListedFragment[], watch: LandingWatch): ListedFragment | null {
  let earliest: ListedFragment | null = null;
  for (const f of fragments) {
    const runIdx = runIndexOfRelurl(f.relurl);
    if (runIdx === undefined || runIdx <= watch.minRunIndexExclusive) continue;
    if (f.programDateTimeMs === null) continue;
    if (f.programDateTimeMs <= watch.clampedTargetMs + LANDING_WINDOW_AHEAD_MS) return null;
    if (earliest === null || f.startSec < earliest.startSec) earliest = f;
  }
  return earliest;
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

/** d4-a1.126 detector C: how far short of the KNOWN item duration an
 *  hls.js 'ended' may map on the source axis and still be believed. An
 *  honest end lands within probe slop of the duration (≤273 ms observed
 *  live; one nominal segment at worst), and the endlist-eos-watch already
 *  repairs precise listed-edge shortfalls when it is armed — this bound
 *  only has to separate those from the stale-endList EOS lie, which parks
 *  'ended' MID-FILM (live 2026-08-25: source ≈ target + 42 s of a
 *  118-minute item, millions of ms short). A full minute keeps every
 *  plausible probe-vs-stream slop honest while catching the lie by three
 *  orders of magnitude. */
export const EARLY_EOS_SHORTFALL_MS = 60_000;

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
