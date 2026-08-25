// SPDX-License-Identifier: AGPL-3.0-only

// d3-a2 follow-up (REOPEN round 1): the second-ENDLIST honest-end watch.
// hls.js only records "the closing fragment is appended" when the appended
// fragment itself carried `endList` at parse time, so a live→VOD
// transition can end DISHONESTLY in either polarity: 'ended' never fires
// (closing fragment buffered before the ENDLIST parse — the tracker never
// learns, endOfStream is never issued, the element wedges "playing" at
// the EOF label) or 'ended' fires EARLY (a stale endList entity from the
// pre-seek run satisfies `isEndListAppended` with only part of the new
// run buffered). This watch observes the element from every ENDLIST
// parse and repairs whichever polarity manifests: it injects the missing
// BUFFER_EOS once the closing fragment's midpoint is buffered, and it
// hands an ended-short-of-the-edge element to the caller's tail-recovery
// rebuild. See endlist-eos-watch.ts for the hls.js line-level mechanism.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENDLIST_EOS_WATCH_INTERVAL_MS,
  eosShortfallThresholdSec,
  isBufferedAtSec,
  startEndlistEosWatch,
  type EosWatchMedia,
  type TimeRangesLike,
} from "./endlist-eos-watch.js";

function ranges(pairs: [number, number][]): TimeRangesLike {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i]![0],
    end: (i: number) => pairs[i]![1],
  };
}

interface FakeMedia extends EosWatchMedia {
  ended: boolean;
  currentTime: number;
  buffered: TimeRangesLike;
}

function makeMedia(overrides: Partial<FakeMedia> = {}): FakeMedia {
  return { ended: false, currentTime: 0, buffered: ranges([]), ...overrides };
}

interface Harness {
  media: FakeMedia | null;
  suppressed: boolean;
  eosFires: number;
  repairs: number[];
  stop: () => void;
}

function arm(options: { media: FakeMedia | null; edgeSec: number; closingFragmentDurationSec: number; suppressed?: boolean }): Harness {
  const harness: Harness = {
    media: options.media,
    suppressed: options.suppressed ?? false,
    eosFires: 0,
    repairs: [],
    stop: () => undefined,
  };
  harness.stop = startEndlistEosWatch({
    getMedia: () => harness.media,
    isSuppressed: () => harness.suppressed,
    edgeSec: options.edgeSec,
    closingFragmentDurationSec: options.closingFragmentDurationSec,
    fireEos: () => {
      harness.eosFires += 1;
    },
    repairShortfall: (endedAtSec: number) => {
      harness.repairs.push(endedAtSec);
    },
  });
  return harness;
}

const TICK = ENDLIST_EOS_WATCH_INTERVAL_MS;

describe("isBufferedAtSec", () => {
  it("finds a position inside any range and rejects one in a gap", () => {
    const b = ranges([
      [0, 10],
      [20, 30],
    ]);
    expect(isBufferedAtSec(b, 5)).toBe(true);
    expect(isBufferedAtSec(b, 25)).toBe(true);
    expect(isBufferedAtSec(b, 15)).toBe(false);
    expect(isBufferedAtSec(b, 30)).toBe(false); // end-exclusive, hls.js's own isBuffered idiom
  });
});

describe("eosShortfallThresholdSec", () => {
  it("is half the closing fragment, floored at 1s (an honest EOS lands within frames of the edge; observed 66ms)", () => {
    expect(eosShortfallThresholdSec(6)).toBe(3);
    expect(eosShortfallThresholdSec(0.5)).toBe(1);
  });
});

describe("startEndlistEosWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polarity W: injects BUFFER_EOS exactly once, only after the closing fragment's midpoint is buffered", () => {
    const media = makeMedia({ buffered: ranges([[0, 10]]) });
    const h = arm({ media, edgeSec: 20, closingFragmentDurationSec: 6 }); // midpoint 17
    vi.advanceTimersByTime(TICK * 3);
    expect(h.eosFires, "fired with the closing fragment un-buffered — that would truncate content still loading").toBe(0);
    media.buffered = ranges([[0, 19.94]]); // covers 17; a hair short of the edge, like the live wedge
    vi.advanceTimersByTime(TICK);
    expect(h.eosFires, "the never-ended wedge: nothing injected the EOS hls.js cannot produce").toBe(1);
    vi.advanceTimersByTime(TICK * 4);
    expect(h.eosFires, "re-fired every tick — the injection must be once per watch").toBe(1);
    h.stop();
  });

  it("polarity W then honest end: 'ended' at the edge stops the watch without a repair", () => {
    const media = makeMedia({ buffered: ranges([[0, 19.94]]) });
    const h = arm({ media, edgeSec: 20, closingFragmentDurationSec: 6 });
    vi.advanceTimersByTime(TICK);
    expect(h.eosFires).toBe(1);
    media.ended = true;
    media.currentTime = 19.94; // truncated duration — frames short of the edge is honest
    vi.advanceTimersByTime(TICK * 2);
    expect(h.repairs, "an honest end (within the shortfall threshold) must not trigger a tail-recovery rebuild").toEqual([]);
    h.stop();
  });

  it("polarity E: 'ended' short of the edge hands the ended position to the repair, once, and the watch stops", () => {
    const media = makeMedia({ buffered: ranges([[0, 12]]), ended: true, currentTime: 12 });
    const h = arm({ media, edgeSec: 20, closingFragmentDurationSec: 6 }); // threshold 3, shortfall 8
    vi.advanceTimersByTime(TICK);
    expect(h.repairs, "the early-'ended' truncation was never repaired — the viewer silently lost the tail").toEqual([12]);
    vi.advanceTimersByTime(TICK * 4);
    expect(h.repairs, "the watch must stop itself after handing off the repair").toEqual([12]);
    expect(h.eosFires).toBe(0);
    h.stop();
  });

  it("suppressed ticks are inert (a still-ENDLIST re-read mid-relocation must not truncate the fresh pipeline)", () => {
    const media = makeMedia({ buffered: ranges([[0, 19.94]]) });
    const h = arm({ media, edgeSec: 20, closingFragmentDurationSec: 6, suppressed: true });
    vi.advanceTimersByTime(TICK * 4);
    expect(h.eosFires).toBe(0);
    media.ended = true;
    media.currentTime = 12;
    vi.advanceTimersByTime(TICK * 2);
    expect(h.repairs).toEqual([]);
    h.suppressed = false;
    vi.advanceTimersByTime(TICK);
    expect(h.repairs, "lifting suppression must let the watch act on what it sees").toEqual([12]);
    h.stop();
  });

  it("a null media tick is inert; stop() halts the watch for good", () => {
    const h = arm({ media: null, edgeSec: 20, closingFragmentDurationSec: 6 });
    vi.advanceTimersByTime(TICK * 3);
    expect(h.eosFires).toBe(0);
    h.media = makeMedia({ buffered: ranges([[0, 19.94]]) });
    h.stop();
    vi.advanceTimersByTime(TICK * 3);
    expect(h.eosFires, "a stopped watch kept ticking").toBe(0);
  });
});
