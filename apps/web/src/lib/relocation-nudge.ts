// SPDX-License-Identifier: AGPL-3.0-only

// Loombre :: apps/web/src/lib/relocation-nudge.ts
//
// V8 hard-seek discovery-latency fix (docs/PLAYBACK.md §9.1.9, 2026-08-20).
//
// After a hard seek's 202, the server side is FAST: the worker's control
// loop ticks every 250 ms, a video-copy restart writes its first segment in
// ~0.2 s, and the fold lands it in the served playlist on the next tick —
// well under a second end to end. The client was the slow half: hls.js
// re-reads a live playlist only on its own targetduration cadence, so run
// DISCOVERY alone cost up to ~6 s of the observed seek latency. While
// relocating, force a playlist re-read once per second instead.
//
// The reload lever, in preference order (d4-a1.112):
//
// 1. PLAYLIST-ONLY (`requestPlaylistOnlyReload` below): trigger hls.js's
//    own LEVEL_LOADING event — the exact request its level-controller's
//    `loadingPlaylist()` emits — so the playlist-loader fetches the level
//    playlist and the response flows through LEVEL_LOADED into the normal
//    merge + LEVEL_UPDATED path the landing watch listens on. The
//    fragment pipeline is untouched, and the loader dedupes an in-flight
//    same-URL request, so a 1 Hz nudge can never stack requests.
//
// 2. stopLoad()/startLoad(...) as the fallback when the reloader has no
//    trigger/uri surface (older mocks; a defensive floor). This pair is
//    hls.js's fatal-network-error recovery lever, and it is a FRAGMENT
//    pipeline lever: stopLoad aborts the in-flight fragment load and
//    startLoad re-kicks loading at the reload position, so every tick
//    re-requested the fragment under the playhead — the verify-A 503
//    hammer on the doomed old-run tail, and the d4-a1.113 at-EOF
//    same-segment re-fetches (observed live at exactly the 1000 ms nudge
//    cadence). NOTE (comment corrected, d4-a1.112): on a LIVE playlist
//    `startLoad(-1)` resynchronizes to the LIVE EDGE — it resumes from
//    the element's current position only when a startPosition override
//    (lastCurrentTime) applies, which the post-rebuild skip flag
//    deliberately suppresses — which is why the nudge names its reload
//    position explicitly instead of passing -1 blind.
//
// The nudge never fires synchronously (the restarted run cannot be in the
// playlist at 202 time), checks `isRelocating` per tick so a landing that
// raced the timer goes quiet immediately, and is stopped by
// clearLandingWatch (landing, timeout, re-seek, unmount).

/** The hls.js surface the nudge drives (structural, so tests need no
 *  hls.js instance): the stopLoad/startLoad fallback lever, the level
 *  list the gap-F4 ENDLIST re-open below acts on, and — when present —
 *  the trigger/level surface the playlist-only reload uses (the real
 *  `Hls` instance carries all of it; `trigger` is the same app-facing
 *  event-injection lever the d3-a2 BUFFER_EOS watch drives). */
export interface PlaylistReloader {
  stopLoad(): void;
  startLoad(startPosition?: number, skipSeekToStartPosition?: boolean): void;
  levels: ReloaderLevel[];
  trigger?(event: string, data: LevelLoadingRequest): unknown;
  /** hls.js "level whose playlist is being loaded" — mid-relocation
   *  refreshes belong to it (d3-a1), so it is the reload target. */
  loadLevel?: number;
  currentLevel?: number;
}

/** Structural mirror of hls.js `Level` — the field the ENDLIST re-open
 *  touches plus the playlist URL the playlist-only reload fetches.
 *  `details`, `live`, and `uri` are all public in hls.js's own types. */
export interface ReloaderLevel {
  details?: ReloaderLevelDetails;
  uri?: string;
}

export interface ReloaderLevelDetails {
  /** hls.js `LevelDetails.live` — false once the parsed playlist carried
   *  `#EXT-X-ENDLIST`. */
  live: boolean;
}

/**
 * gap-F4 (§9.1.5 rule 5 / amendment A1): make an ENDLIST-frozen client
 * model reloadable again. hls.js's BasePlaylistController.
 * `shouldLoadPlaylist` refuses to reload any level whose details are VOD
 * (`!details || details.live` is its gate), so once a served playlist has
 * carried `#EXT-X-ENDLIST` BOTH reload levers — a bare `startLoad()` and
 * this module's stopLoad/startLoad pair — are inert. A post-ENDLIST hard
 * seek un-ends the playlist SERVER-side (new run, tag gone), but the
 * client would never re-read it: the landing watch could never fire and
 * the seek died into the 20 s timeout (the "swallowed hard seek" of the
 * 2026-08-20/21 QA report). Flipping `details.live` back to true is the
 * minimal public-property un-freeze: the next reload then merges the
 * un-ended playlist normally, and a reload that raced the worker restart
 * (still-ENDLIST) simply re-freezes until the next tick re-opens again.
 * Returns whether any level was re-opened.
 */
export function reopenEndedLevels(hls: Pick<PlaylistReloader, "levels">): boolean {
  let reopened = false;
  for (const level of hls.levels) {
    if (level.details && level.details.live === false) {
      level.details.live = true;
      reopened = true;
    }
  }
  return reopened;
}

/** Once per second: fast enough that discovery adds ≤1 s to a seek that
 *  the server completes in well under a second, slow enough that the tiny
 *  playlist GET (a few KB, same origin) is negligible even over the 20 s
 *  landing timeout's worst case (docs/PLAYBACK.md §9.1.9). */
export const HARD_SEEK_REFRESH_NUDGE_MS = 1_000;

/** hls.js `Events.LEVEL_LOADING` — pinned as a literal so this module
 *  stays hls.js-import-free; the test suite asserts it against the real
 *  enum, so a dependency bump that renames it fails loudly in CI. */
export const LEVEL_LOADING_EVENT = "hlsLevelLoading";

/** The LEVEL_LOADING payload `loadingPlaylist()` itself emits (hls.js
 *  level-controller.ts): the playlist-loader destructures exactly these
 *  members. `levelInfo` must be the level's own object — level-controller
 *  merges the response only into the identical instance, and the loader's
 *  in-flight dedupe compares it by identity. */
export interface LevelLoadingRequest {
  url: string;
  level: number;
  levelInfo: ReloaderLevel;
  /** Deprecated hls.js level urlId — always 0, as the real emit sends. */
  id: number;
  deliveryDirectives: null;
}

/** Which level index the playlist-only reload should address: the level
 *  being LOADED first (mid-relocation refreshes belong to it — d3-a1's
 *  landing follows whichever level refreshed), the current level next,
 *  then any uri-bearing level (pre-first-frame both indices are -1);
 *  -1 when nothing is addressable. */
export function pickReloadLevelIndex(
  hls: Pick<PlaylistReloader, "levels" | "loadLevel" | "currentLevel">,
): number {
  const addressable = (index: number | undefined): boolean => {
    if (index === undefined || index < 0) return false;
    const uri = hls.levels[index]?.uri;
    return typeof uri === "string" && uri.length > 0;
  };
  if (addressable(hls.loadLevel)) return hls.loadLevel!;
  if (addressable(hls.currentLevel)) return hls.currentLevel!;
  return hls.levels.findIndex((level) => typeof level.uri === "string" && level.uri.length > 0);
}

/**
 * The playlist-only reload (d4-a1.112): re-read the level playlist NOW
 * without touching the fragment pipeline. Triggering LEVEL_LOADING drives
 * hls.js's playlist-loader directly (bypassing shouldLoadPlaylist's
 * schedule — though the caller still re-opens ENDLIST-frozen levels so
 * the MERGE path treats the refresh as live); the response flows through
 * LEVEL_LOADED into both controllers' normal merge/LEVEL_UPDATED path.
 * Returns false — caller falls back to the stopLoad/startLoad lever —
 * when the reloader exposes no trigger surface or no level has a uri.
 */
export function requestPlaylistOnlyReload(hls: PlaylistReloader): boolean {
  if (typeof hls.trigger !== "function") return false;
  const index = pickReloadLevelIndex(hls);
  if (index < 0) return false;
  const level = hls.levels[index]!;
  hls.trigger(LEVEL_LOADING_EVENT, {
    url: level.uri!,
    level: index,
    levelInfo: level,
    id: 0,
    deliveryDirectives: null,
  });
  return true;
}

/** Starts the relocation nudge loop. Returns the stop function.
 *
 *  d3-a2: every reload passes `skipSeekToStartPosition` — after the
 *  post-ENDLIST MSE rebuild (lib/post-endlist-rebuild.ts) hls.js's
 *  `_hasEnoughToStart` is false again, so a bare `startLoad(-1)` would
 *  override its start position with `lastCurrentTime` (the ABANDONED
 *  pre-seek presentation position) and `seekToStartPos` would yank
 *  `media.currentTime` there on the first append, fighting the landing's
 *  own assignment. The nudge names the reload position itself instead:
 *  the element's current position when the caller provides it (identical
 *  load behavior to the old lastCurrentTime override on an untouched
 *  attach), the live edge otherwise — and never the media-seek side
 *  effect. */
export function startRelocationNudge(
  getReloader: () => PlaylistReloader | null,
  isRelocating: () => boolean,
  getResumePositionSec?: () => number,
  intervalMs: number = HARD_SEEK_REFRESH_NUDGE_MS,
): () => void {
  const timer = setInterval(() => {
    if (!isRelocating()) return;
    const hls = getReloader();
    if (!hls) return;
    // EVERY tick, not just the first: a re-read that raced the worker
    // restart returns a still-ENDLIST playlist, which re-freezes the
    // level (parsed live:false) — see reopenEndedLevels above.
    reopenEndedLevels(hls);
    // d4-a1.113: the playlist-only lever first — a stopLoad/startLoad
    // tick aborts and re-kicks the fragment pipeline, re-requesting the
    // fragment under the playhead once per second for the whole
    // relocation (the at-EOF same-segment re-fetch loop, observed live
    // at exactly this cadence; the verify-A 503 hammer). The fallback
    // remains for reloaders without the trigger/uri surface.
    if (!requestPlaylistOnlyReload(hls)) {
      hls.stopLoad();
      hls.startLoad(getResumePositionSec ? getResumePositionSec() : -1, true);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
