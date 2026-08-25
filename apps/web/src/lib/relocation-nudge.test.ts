// SPDX-License-Identifier: AGPL-3.0-only

// V8 hard-seek discovery-latency fix (docs/PLAYBACK.md §9.1.9, 2026-08-20):
// while a hard seek is relocating, the client forces a playlist re-read
// once per second instead of waiting out hls.js's own live-refresh cadence
// (~targetduration, up to ~6 s of pure discovery latency against a worker
// that folds the restarted run's first segment in well under a second).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HARD_SEEK_REFRESH_NUDGE_MS,
  LEVEL_LOADING_EVENT,
  pickReloadLevelIndex,
  requestPlaylistOnlyReload,
  startRelocationNudge,
  type PlaylistReloader,
} from "./relocation-nudge.js";

function makeReloader(levels: { details?: { live: boolean } }[] = []): PlaylistReloader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    levels,
    stopLoad: () => calls.push("stopLoad"),
    startLoad: (pos?: number, skip?: boolean) => calls.push(`startLoad(${pos},${skip})`),
  };
}

describe("startRelocationNudge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("nudges stopLoad-then-startLoad(-1, skipSeek) once per interval while relocating", () => {
    const hls = makeReloader();
    const stop = startRelocationNudge(() => hls, () => true);
    expect(hls.calls, "no synchronous nudge — the restarted run cannot exist yet at 202 time").toEqual([]);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS);
    expect(hls.calls).toEqual(["stopLoad", "startLoad(-1,true)"]);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS * 2);
    expect(hls.calls).toEqual(["stopLoad", "startLoad(-1,true)", "stopLoad", "startLoad(-1,true)", "stopLoad", "startLoad(-1,true)"]);
    stop();
  });

  // d3-a2: skipSeekToStartPosition=true is load-bearing after the
  // post-ENDLIST MSE rebuild (lib/post-endlist-rebuild.ts): a detach
  // resets hls.js's `_hasEnoughToStart`, so a bare startLoad(-1) would
  // override its start position with `lastCurrentTime` — the ABANDONED
  // pre-seek presentation position — and seekToStartPos would yank
  // `media.currentTime` there on the first append, fighting the landing.
  // The nudge therefore always suppresses the media-seek side effect and
  // names the reload position itself (the element's own position when the
  // caller provides it, the live edge otherwise).
  it("reloads from the caller-provided resume position (still with the media-seek side effect suppressed)", () => {
    const hls = makeReloader();
    const stop = startRelocationNudge(() => hls, () => true, () => 42.5);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS);
    expect(hls.calls).toEqual(["stopLoad", "startLoad(42.5,true)"]);
    stop();
  });

  it("a tick that is no longer relocating does nothing (landing raced the timer)", () => {
    const hls = makeReloader();
    let relocating = true;
    const stop = startRelocationNudge(() => hls, () => relocating);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS);
    expect(hls.calls).toHaveLength(2);
    relocating = false;
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS * 3);
    expect(hls.calls).toHaveLength(2);
    stop();
  });

  it("stop() ends the nudging permanently", () => {
    const hls = makeReloader();
    const stop = startRelocationNudge(() => hls, () => true);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS);
    stop();
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS * 5);
    expect(hls.calls).toHaveLength(2);
  });

  it("a vanished hls instance (detach/recovery mid-relocation) is skipped, not crashed on", () => {
    const stop = startRelocationNudge(() => null, () => true);
    expect(() => vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS * 2)).not.toThrow();
    stop();
  });

  // ── gap-F4: the post-ENDLIST hard seek (§9.1.5 rule 5 / amendment A1) ──
  // hls.js's BasePlaylistController.shouldLoadPlaylist refuses to reload a
  // level whose details are VOD (`details.live === false`, i.e. ENDLIST was
  // seen) — so on a post-ENDLIST session BOTH reload levers (the A1
  // `startLoad()` re-arm and this nudge's stopLoad/startLoad pair) are
  // inert, the un-ended playlist is never re-read, the landing watch can
  // never fire, and the seek is swallowed into the 20 s timeout. The tick
  // must first flip the frozen level(s) back to live.
  it("re-opens an ENDLIST-frozen level (details.live=false -> true) before pulling the reload lever", () => {
    const details = { live: false };
    const hls = makeReloader([{ details }]);
    const stop = startRelocationNudge(() => hls, () => true);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS);
    expect(
      details.live,
      "hls.js shouldLoadPlaylist refuses to reload a VOD (ENDLIST) level — the tick must re-open it or stopLoad/startLoad reload nothing",
    ).toBe(true);
    expect(hls.calls).toEqual(["stopLoad", "startLoad(-1,true)"]);
    stop();
  });

  it("re-opens on EVERY tick — a reload racing the worker restart returns a still-ENDLIST playlist that re-freezes the level", () => {
    const details = { live: false };
    const hls = makeReloader([{ details }]);
    const stop = startRelocationNudge(() => hls, () => true);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS);
    // The re-read landed BEFORE the worker's next control tick appended the
    // seek run: the served playlist still ends, hls.js re-parses it as VOD.
    details.live = false;
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS);
    expect(details.live, "each tick must re-open, not just the first").toBe(true);
    stop();
  });

  it("levels without details (not yet loaded) and already-live levels are left alone", () => {
    const live = { live: true };
    const hls = makeReloader([{}, { details: live }]);
    const stop = startRelocationNudge(() => hls, () => true);
    expect(() => vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS)).not.toThrow();
    expect(live.live).toBe(true);
    stop();
  });
});

// ── d4-a1.112: the playlist-only reload lever ────────────────────────────
// stopLoad()/startLoad() is a FRAGMENT-pipeline lever: every tick aborts
// the in-flight fragment load and re-kicks loading at the reload position,
// which re-requests the fragment under the playhead once per second for
// the whole relocation (the verify-A 503 hammer on the abandoned old-run
// tail; the d4-a1.113 at-EOF same-segment re-fetches, observed live at
// exactly the 1000 ms nudge cadence). A playlist re-read needs none of
// that: triggering hls.js's own LEVEL_LOADING event drives its
// playlist-loader directly — the exact request its level-controller's
// loadingPlaylist() emits — and the response flows through LEVEL_LOADED
// into the normal merge + LEVEL_UPDATED path the landing watch listens
// on, leaving the fragment pipeline untouched. The loader also dedupes an
// in-flight same-URL request, so a 1 Hz nudge can never stack requests.
describe("requestPlaylistOnlyReload (d4-a1.112)", () => {
  function makeTriggerReloader(overrides: Partial<PlaylistReloader> = {}): PlaylistReloader & {
    calls: string[];
    triggered: { event: string; data: unknown }[];
  } {
    const calls: string[] = [];
    const triggered: { event: string; data: unknown }[] = [];
    return {
      calls,
      triggered,
      levels: [{ details: { live: true }, uri: "http://localhost:3001/hls/v0/media.m3u8" }],
      loadLevel: 0,
      currentLevel: 0,
      stopLoad: () => calls.push("stopLoad"),
      startLoad: (pos?: number, skip?: boolean) => calls.push(`startLoad(${pos},${skip})`),
      trigger: (event: string, data: unknown) => {
        calls.push(`trigger(${event})`);
        triggered.push({ event, data });
      },
      ...overrides,
    };
  }

  it("triggers LEVEL_LOADING with the level's own uri/levelInfo — the payload loadingPlaylist() itself emits", () => {
    const hls = makeTriggerReloader();
    expect(requestPlaylistOnlyReload(hls)).toBe(true);
    expect(hls.triggered).toHaveLength(1);
    expect(hls.triggered[0]!.event).toBe(LEVEL_LOADING_EVENT);
    expect(hls.triggered[0]!.data).toEqual({
      url: "http://localhost:3001/hls/v0/media.m3u8",
      level: 0,
      levelInfo: hls.levels[0],
      id: 0,
      deliveryDirectives: null,
    });
    expect(hls.calls.filter((c) => c === "stopLoad" || c.startsWith("startLoad")), "the playlist-only lever must not touch the fragment pipeline").toEqual([]);
  });

  it("returns false (caller falls back to the stop/start lever) when the reloader has no trigger surface", () => {
    const full = makeTriggerReloader();
    const withoutTrigger = Object.fromEntries(Object.entries(full).filter(([key]) => key !== "trigger")) as typeof full;
    expect(requestPlaylistOnlyReload(withoutTrigger)).toBe(false);
    expect(withoutTrigger.triggered).toHaveLength(0);
  });

  it("returns false when no level carries a playlist uri (nothing addressable to reload)", () => {
    const hls = makeTriggerReloader({ levels: [{ details: { live: true } }] });
    expect(requestPlaylistOnlyReload(hls)).toBe(false);
  });

  // The event name is hls.js public API (Events.LEVEL_LOADING) — pin the
  // literal against the real enum so a dependency bump that renames it
  // fails HERE, not silently in the field.
  it("LEVEL_LOADING_EVENT matches the real hls.js Events enum", async () => {
    const { default: Hls } = await import("hls.js");
    expect(LEVEL_LOADING_EVENT).toBe(Hls.Events.LEVEL_LOADING);
  });
});

describe("pickReloadLevelIndex (d4-a1.112)", () => {
  const withUri = { details: { live: true }, uri: "u" };
  const noUri = { details: { live: true } };

  it("prefers the LOADING level — mid-relocation refreshes belong to it (d3-a1), so that is the playlist to re-read", () => {
    expect(pickReloadLevelIndex({ levels: [withUri, withUri], loadLevel: 1, currentLevel: 0 })).toBe(1);
  });

  it("falls back to the current level when the load level has no uri", () => {
    expect(pickReloadLevelIndex({ levels: [withUri, noUri], loadLevel: 1, currentLevel: 0 })).toBe(0);
  });

  it("falls back to the first uri-bearing level before any frame has played (both indices -1)", () => {
    expect(pickReloadLevelIndex({ levels: [noUri, withUri], loadLevel: -1, currentLevel: -1 })).toBe(1);
  });

  it("-1 when nothing is addressable", () => {
    expect(pickReloadLevelIndex({ levels: [noUri], loadLevel: -1, currentLevel: -1 })).toBe(-1);
    expect(pickReloadLevelIndex({ levels: [], loadLevel: 0, currentLevel: 0 })).toBe(-1);
  });
});
