// SPDX-License-Identifier: AGPL-3.0-only

// V8 hard-seek discovery-latency fix (docs/PLAYBACK.md §9.1.9, 2026-08-20):
// while a hard seek is relocating, the client forces a playlist re-read
// once per second instead of waiting out hls.js's own live-refresh cadence
// (~targetduration, up to ~6 s of pure discovery latency against a worker
// that folds the restarted run's first segment in well under a second).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARD_SEEK_REFRESH_NUDGE_MS, startRelocationNudge, type PlaylistReloader } from "./relocation-nudge.js";

function makeReloader(): PlaylistReloader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
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
});
