// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { gaplessReducer, initialGaplessState, otherSlot, shouldPreload } from "./gapless.js";

describe("otherSlot", () => {
  it("flips A<->B", () => {
    expect(otherSlot("A")).toBe("B");
    expect(otherSlot("B")).toBe("A");
  });
});

describe("shouldPreload", () => {
  it("is false with no known duration", () => {
    expect(shouldPreload(10_000, null)).toBe(false);
  });

  it("is false at the very start of a track", () => {
    expect(shouldPreload(0, 180_000)).toBe(false);
  });

  it("is false while comfortably before the threshold", () => {
    expect(shouldPreload(100_000, 180_000)).toBe(false);
  });

  it("is true once inside the default 3s threshold", () => {
    expect(shouldPreload(177_500, 180_000)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(shouldPreload(170_000, 180_000, 15_000)).toBe(true);
    expect(shouldPreload(160_000, 180_000, 15_000)).toBe(false);
  });
});

describe("gaplessReducer", () => {
  it("LOAD_ACTIVE assigns the track to the active slot and clears preloadPending", () => {
    const state = gaplessReducer(initialGaplessState, { type: "LOAD_ACTIVE", trackId: "t1" });
    expect(state).toEqual({ active: "A", loaded: { A: "t1" }, preloadPending: false });
  });

  it("PRELOAD_NEXT assigns the track to the OTHER slot and sets preloadPending", () => {
    const loaded = gaplessReducer(initialGaplessState, { type: "LOAD_ACTIVE", trackId: "t1" });
    const preloaded = gaplessReducer(loaded, { type: "PRELOAD_NEXT", trackId: "t2" });
    expect(preloaded).toEqual({ active: "A", loaded: { A: "t1", B: "t2" }, preloadPending: true });
  });

  it("TRACK_ENDED flips the active slot and clears preloadPending, keeping `loaded` as-is", () => {
    let state = gaplessReducer(initialGaplessState, { type: "LOAD_ACTIVE", trackId: "t1" });
    state = gaplessReducer(state, { type: "PRELOAD_NEXT", trackId: "t2" });
    state = gaplessReducer(state, { type: "TRACK_ENDED" });
    expect(state).toEqual({ active: "B", loaded: { A: "t1", B: "t2" }, preloadPending: false });
  });

  it("a full two-track gapless cycle ends with the machine pointed at the right slot/track", () => {
    let state = initialGaplessState;
    state = gaplessReducer(state, { type: "LOAD_ACTIVE", trackId: "t1" });
    state = gaplessReducer(state, { type: "PRELOAD_NEXT", trackId: "t2" });
    state = gaplessReducer(state, { type: "TRACK_ENDED" }); // now playing t2 in slot B
    expect(state.active).toBe("B");
    expect(state.loaded[state.active]).toBe("t2");

    state = gaplessReducer(state, { type: "PRELOAD_NEXT", trackId: "t3" }); // preload t3 into A
    expect(state.loaded.A).toBe("t3");
    state = gaplessReducer(state, { type: "TRACK_ENDED" }); // now playing t3 in slot A
    expect(state.active).toBe("A");
    expect(state.loaded[state.active]).toBe("t3");
  });

  it("CLEAR_PRELOAD removes only the non-active slot's loaded entry", () => {
    let state = gaplessReducer(initialGaplessState, { type: "LOAD_ACTIVE", trackId: "t1" });
    state = gaplessReducer(state, { type: "PRELOAD_NEXT", trackId: "t2" });
    state = gaplessReducer(state, { type: "CLEAR_PRELOAD" });
    expect(state).toEqual({ active: "A", loaded: { A: "t1" }, preloadPending: false });
  });

  it("RESET returns to the initial state", () => {
    let state = gaplessReducer(initialGaplessState, { type: "LOAD_ACTIVE", trackId: "t1" });
    state = gaplessReducer(state, { type: "RESET" });
    expect(state).toEqual(initialGaplessState);
  });

  it("TRACK_ENDED with nothing preloaded still flips active (the DOM layer falls back to a fresh, non-gapless load)", () => {
    let state = gaplessReducer(initialGaplessState, { type: "LOAD_ACTIVE", trackId: "t1" });
    state = gaplessReducer(state, { type: "TRACK_ENDED" });
    expect(state.active).toBe("B");
    expect(state.loaded.B).toBeUndefined();
  });
});
