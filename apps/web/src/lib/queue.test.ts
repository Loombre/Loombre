// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { currentTrack, initialQueueState, peekNextTrack, queueReducer, type QueueTrack } from "./queue.js";

function track(entryId: string, itemId = entryId): QueueTrack {
  return { entryId, itemId, title: `Track ${entryId}`, subtitle: null, albumId: null, durationMs: 180_000, blurhash: null };
}

describe("queueReducer", () => {
  it("SET_QUEUE replaces the queue and sets currentIndex", () => {
    const state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b"), track("c")], startIndex: 1 });
    expect(state.items.map((t) => t.entryId)).toEqual(["a", "b", "c"]);
    expect(state.currentIndex).toBe(1);
    expect(currentTrack(state)?.entryId).toBe("b");
  });

  it("SET_QUEUE with an empty list clears currentIndex", () => {
    const state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [] });
    expect(state).toEqual(initialQueueState);
  });

  it("ENQUEUE appends and starts playback if nothing was current", () => {
    const state = queueReducer(initialQueueState, { type: "ENQUEUE", track: track("a") });
    expect(state.currentIndex).toBe(0);
    const state2 = queueReducer(state, { type: "ENQUEUE", track: track("b") });
    expect(state2.currentIndex).toBe(0); // unchanged — "a" is already playing
    expect(state2.items.map((t) => t.entryId)).toEqual(["a", "b"]);
  });

  it("PLAY_NOW inserts immediately after current and makes it current", () => {
    let state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b"), track("c")] });
    state = queueReducer(state, { type: "PLAY_NOW", track: track("x") });
    expect(state.items.map((t) => t.entryId)).toEqual(["a", "x", "b", "c"]);
    expect(state.currentIndex).toBe(1);
  });

  it("REMOVE of the current track clamps currentIndex into range", () => {
    let state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b")], startIndex: 1 });
    state = queueReducer(state, { type: "REMOVE", entryId: "b" });
    expect(state.items.map((t) => t.entryId)).toEqual(["a"]);
    expect(state.currentIndex).toBe(0);
  });

  it("REMOVE before the current track shifts currentIndex left", () => {
    let state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b"), track("c")], startIndex: 2 });
    state = queueReducer(state, { type: "REMOVE", entryId: "a" });
    expect(state.items.map((t) => t.entryId)).toEqual(["b", "c"]);
    expect(currentTrack(state)?.entryId).toBe("c");
  });

  it("REMOVE of the last remaining track clears currentIndex", () => {
    let state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a")] });
    state = queueReducer(state, { type: "REMOVE", entryId: "a" });
    expect(state).toEqual({ items: [], currentIndex: null });
  });

  it("REORDER moves an item and keeps currentIndex pointing at the same track", () => {
    let state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b"), track("c")], startIndex: 1 });
    state = queueReducer(state, { type: "REORDER", from: 2, to: 0 });
    expect(state.items.map((t) => t.entryId)).toEqual(["c", "a", "b"]);
    expect(currentTrack(state)?.entryId).toBe("b"); // "b" was current, follows the shift
  });

  it("REORDER moving the current track itself updates currentIndex to the destination", () => {
    let state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b"), track("c")], startIndex: 0 });
    state = queueReducer(state, { type: "REORDER", from: 0, to: 2 });
    expect(state.items.map((t) => t.entryId)).toEqual(["b", "c", "a"]);
    expect(currentTrack(state)?.entryId).toBe("a");
  });

  it("REORDER is a no-op for out-of-range or identical indices", () => {
    const state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b")] });
    expect(queueReducer(state, { type: "REORDER", from: 0, to: 0 })).toBe(state);
    expect(queueReducer(state, { type: "REORDER", from: 0, to: 5 })).toBe(state);
  });

  it("NEXT advances currentIndex, and clears it past the end", () => {
    let state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b")], startIndex: 0 });
    state = queueReducer(state, { type: "NEXT" });
    expect(state.currentIndex).toBe(1);
    expect(peekNextTrack(state)).toBeNull();
    state = queueReducer(state, { type: "NEXT" });
    expect(state.currentIndex).toBeNull();
  });

  it("PREV never goes below index 0", () => {
    let state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b")], startIndex: 0 });
    state = queueReducer(state, { type: "PREV" });
    expect(state.currentIndex).toBe(0);
  });

  it("JUMP_TO sets currentIndex to the matching entry", () => {
    const state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b"), track("c")] });
    expect(queueReducer(state, { type: "JUMP_TO", entryId: "c" }).currentIndex).toBe(2);
    expect(queueReducer(state, { type: "JUMP_TO", entryId: "missing" })).toBe(state);
  });

  it("peekNextTrack returns the track after current, or null at the end / when idle", () => {
    const state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a"), track("b")], startIndex: 0 });
    expect(peekNextTrack(state)?.entryId).toBe("b");
    expect(peekNextTrack(initialQueueState)).toBeNull();
  });

  it("CLEAR resets to the initial state", () => {
    const state = queueReducer(initialQueueState, { type: "SET_QUEUE", tracks: [track("a")] });
    expect(queueReducer(state, { type: "CLEAR" })).toEqual(initialQueueState);
  });
});
