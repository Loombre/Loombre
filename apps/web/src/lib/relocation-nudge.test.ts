// SPDX-License-Identifier: AGPL-3.0-only

// V8 hard-seek discovery-latency fix (docs/PLAYBACK.md §9.1.9, 2026-08-20):
// while a hard seek is relocating, the client forces a playlist re-read
// once per second instead of waiting out hls.js's own live-refresh cadence
// (~targetduration, up to ~6 s of pure discovery latency against a worker
// that folds the restarted run's first segment in well under a second).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARD_SEEK_REFRESH_NUDGE_MS, startRelocationNudge, type PlaylistReloader } from "./relocation-nudge.js";

function makeReloader(levels: { details?: { live: boolean } }[] = []): PlaylistReloader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    levels,
    stopLoad: () => calls.push("stopLoad"),
    startLoad: (pos?: number) => calls.push(`startLoad(${pos})`),
  };
}

describe("startRelocationNudge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("nudges stopLoad-then-startLoad(-1) once per interval while relocating", () => {
    const hls = makeReloader();
    const stop = startRelocationNudge(() => hls, () => true);
    expect(hls.calls, "no synchronous nudge — the restarted run cannot exist yet at 202 time").toEqual([]);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS);
    expect(hls.calls).toEqual(["stopLoad", "startLoad(-1)"]);
    vi.advanceTimersByTime(HARD_SEEK_REFRESH_NUDGE_MS * 2);
    expect(hls.calls).toEqual(["stopLoad", "startLoad(-1)", "stopLoad", "startLoad(-1)", "stopLoad", "startLoad(-1)"]);
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
    expect(hls.calls).toEqual(["stopLoad", "startLoad(-1)"]);
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
