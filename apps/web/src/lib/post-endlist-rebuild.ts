// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/lib/post-endlist-rebuild.ts
//
// d3-a2 (post-ENDLIST seek family, QA verify 2026-08-20/21): once an
// hls.js session has parsed an ENDLIST playlist, two pieces of hls.js
// state the app cannot reach poison EVERY later hard seek:
//
//   1. MediaSource truncation. `_streamEnded` -> BUFFER_EOS ->
//      `mediaSource.endOfStream()` fixes the MediaSource duration at the
//      buffered end and parks the stream controller in State.ENDED. A
//      later hard seek spawns a run whose presentation start sits AT/PAST
//      that duration: the landing's `currentTime` assignment clamps short
//      (often to the exact current position, so no `seeking` event ever
//      leaves State.ENDED) and hls.js never fetches the seek run's
//      segments — the live evidence was requested_segment stuck at 28
//      while the worker produced 39 (browser-player-F4-residual), and the
//      99.5% seek that fired 'ended' instantly with 0 s watched
//      (verify/gap-F4). LEVEL_UPDATED cannot revive the duration either:
//      BufferController.getDurationAndRange refuses any update while
//      `mediaSource.readyState !== 'open'`.
//
//   2. The stale endList tracker entity. When the fragment that closed a
//      playlist (`frag.endList`) buffers, hls.js's FragmentTracker
//      records it in `endListFragments` — and NOTHING removes it when a
//      later hard seek un-ends the playlist (`removeFragmentsInRange` on
//      seeking passes withGapOnly). A later seek whose new run ALSO
//      reaches ENDLIST then satisfies `isEndListAppended` via the STALE
//      entity the moment the new details merge live:false — BUFFER_EOS
//      fires with only the new run's FIRST segment buffered: the element
//      played 6 s of a 26.5 s tail, fired 'ended' ~20 s early, and
//      run3/s000068-71 were never requested (verify/browser-player-F4,
//      .playwright-mcp/qa-evidence/verify-F4-playlist-195.txt).
//
// The ONE public lever that clears both is a media re-attach:
// `detachMedia()` runs the tracker's `removeAllFragments()` and tears the
// MediaSource down; `attachMedia()` builds a fresh one whose duration
// follows the level details again. It is exactly the lever hls.js's own
// `recoverMediaError()` uses — minus its `startLoad(currentTime)` tail,
// which would re-arm `seekToStartPos` at the ABANDONED pre-seek position
// (after a detach `_hasEnoughToStart` is false again, so the first append
// would yank `media.currentTime` back there, fighting the V8 landing).
// Loading restarts with `skipSeekToStartPosition` instead, at the listed
// window's tail — the presentation position where the seek-spawned run
// will append (§9.1.5: runs append at the served playlist's tail).
//
// VideoPlayer pulls this lever on a hard-seek 202 when the session has
// parsed ENDLIST since the last rebuild (its `endlistSeenRef`); the cost
// (dropping the buffer, re-fetching an init segment) lands only on the
// rare post-ENDLIST seek, whose buffer is abandoned content anyway.

import { reopenEndedLevels, type ReloaderLevel } from "./relocation-nudge.js";
import type { ListedFragment } from "./source-time.js";

/** The hls.js surface the rebuild drives — structural, so unit tests need
 *  no hls.js instance and the real `Hls` satisfies it as-is
 *  (`RebuildableHls<HTMLMediaElement>`: its `attachMedia` accepts the
 *  element directly). */
export interface RebuildableHls<M = RebuildableMedia> {
  detachMedia(): void;
  attachMedia(media: M): void;
  startLoad(startPosition?: number, skipSeekToStartPosition?: boolean): void;
  levels: ReloaderLevel[];
}

/** The media-element surface: the play-state snapshot plus the
 *  default-start assignment (setting `currentTime` at readyState
 *  HAVE_NOTHING sets the element's default playback start position —
 *  no seek, no exception). */
export interface RebuildableMedia {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  play(): Promise<void>;
}

/**
 * The listed window's presentation end — where a seek-spawned run will
 * append (§9.1.5: every restart appends `runN/` at the served playlist's
 * tail). `null` when no window is readable; callers fall back to the
 * live edge (-1).
 */
export function listedWindowEndSec(fragments: readonly ListedFragment[] | null): number | null {
  if (!fragments || fragments.length === 0) return null;
  const last = fragments[fragments.length - 1]!;
  return last.startSec + last.durationSec;
}

/**
 * The rebuild sequence itself. Order is load-bearing: `startLoad` against
 * a torn-down attach is dropped by hls.js, and `attachMedia` on a
 * still-attached instance warns and detaches internally.
 *
 * Play-state contract: the re-attach empties the element (which pauses
 * it), so the pre-detach intent is captured and RETURNED as
 * `resumePlay` — a PLAYING viewer keeps playing, a seek from the
 * fully-ENDED state PLAYS (the residual finding's acceptance; note
 * Chrome's natural EOF fires 'pause' before 'ended', so `ended` must be
 * consulted, not just `paused`), and only a deliberate mid-stream pause
 * stays paused, exactly like a non-rebuilt hard seek. The CALLER issues
 * the `play()` at landing-assignment time, not here: a play() fired
 * inside the rebuild is aborted by hls.js's own attach flow (the fresh
 * src assignment is a new load request, which rejects any pending play
 * — observed live: the post-rebuild 50% landing sat paused at the
 * target), while by the time the landing assigns the element the attach
 * has long settled.
 */
export function rebuildMsePipelineForHardSeek<M extends RebuildableMedia>(
  hls: RebuildableHls<M>,
  media: M,
  windowTailSec: number | null,
): { resumePlay: boolean } {
  const resumePlay = !media.paused || media.ended;
  hls.detachMedia();
  hls.attachMedia(media);
  // The frozen level(s) must be re-opened or shouldLoadPlaylist refuses
  // every reload of the un-ended playlist (same rule the relocation
  // nudge applies per tick — gap-F4 / amendment A1).
  reopenEndedLevels(hls);
  hls.startLoad(windowTailSec ?? -1, true);
  if (windowTailSec !== null) {
    // Default playback start position: pre-landing loads and the first
    // displayable frame happen where the new run appends, not at 0. The
    // landing's own assignment refines this the moment the run is
    // discovered.
    media.currentTime = windowTailSec;
  }
  return { resumePlay };
}
