// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/transcode-admission.spec.ts
//
// Concurrency regression tests for the transcode admission gate
// (docs/PLAYBACK.md §9's "global semaphore = maxSimultaneousTranscodes").
// The bug these pin down is a check-then-act race: sessions.controller.ts
// used to COUNT active transcode sessions and only later INSERT the row,
// with DB round-trips in between, so two POST /playback/sessions requests
// arriving together both observed `activeCount < cap` and both got in.
// Every test below therefore drives the gate CONCURRENTLY (Promise.all) —
// a sequential await can never catch this.

import { describe, expect, it, vi } from "vitest";
import { TranscodeAdmissionGate } from "./transcode-admission.js";

/**
 * Stand-in for `countActiveTranscodeSessions` + `createPlaybackSession`:
 * both are async DB round-trips, and the race lives in the gap between
 * them, so both yield to the microtask queue at least once (`tick()` is the
 * cheapest faithful model of that gap — a real round-trip yields far more).
 */
function fakeSessionStore() {
  let active = 0;
  const tick = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    get active() {
      return active;
    },
    countActive: async () => {
      await tick();
      return active;
    },
    create: async () => {
      await tick();
      active += 1;
      return { id: `session-${active}` };
    },
  };
}

describe("TranscodeAdmissionGate", () => {
  it("never admits beyond the cap when requests arrive concurrently", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => gate.admit({ cap: 2, countActive: store.countActive, create: store.create })),
    );

    expect(results.filter((r) => r.admitted)).toHaveLength(2);
    expect(results.filter((r) => !r.admitted)).toHaveLength(3);
    expect(store.active).toBe(2);
  });

  it("cap of 1 (the Tier-0 default) admits exactly one of two simultaneous requests", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();

    const [first, second] = await Promise.all([
      gate.admit({ cap: 1, countActive: store.countActive, create: store.create }),
      gate.admit({ cap: 1, countActive: store.countActive, create: store.create }),
    ]);

    expect([first.admitted, second.admitted].filter(Boolean)).toHaveLength(1);
    expect(store.active).toBe(1);
  });

  it("returns the created row to the admitted caller and nothing to the refused one", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();

    const first = await gate.admit({ cap: 1, countActive: store.countActive, create: store.create });
    const second = await gate.admit({ cap: 1, countActive: store.countActive, create: store.create });

    expect(first).toEqual({ admitted: true, created: { id: "session-1" } });
    expect(second).toEqual({ admitted: false });
  });

  it("SPF-9: reclaim is never called while under the cap", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();
    const reclaim = vi.fn(async () => true);

    const result = await gate.admit({ cap: 2, countActive: store.countActive, create: store.create, reclaim });

    expect(result.admitted).toBe(true);
    expect(reclaim).not.toHaveBeenCalled();
  });

  it("SPF-9: reclaim is called at the cap, and a true result admits after a recount", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();
    // Pre-fill the store to the cap so the very next admit() attempt is
    // already at capacity.
    await store.create();
    let active = 1;
    const reclaim = vi.fn(async () => {
      active -= 1; // simulate evictStalestSuspendedTranscodeSession freeing a slot
      return true;
    });
    const countActive = async () => active;

    const result = await gate.admit({ cap: 1, countActive, create: store.create, reclaim });

    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(result.admitted).toBe(true);
  });

  it("SPF-9: a false reclaim result still refuses admission (no recount, no false positive)", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();
    await store.create(); // at cap
    const reclaim = vi.fn(async () => false);

    const result = await gate.admit({ cap: 1, countActive: store.countActive, create: store.create, reclaim });

    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(result.admitted).toBe(false);
    expect(store.active).toBe(1); // create() never called
  });

  it("SPF-9: omitting reclaim entirely preserves pre-SPF-9 behavior — refused at the cap, no crash", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();
    await store.create(); // at cap

    const result = await gate.admit({ cap: 1, countActive: store.countActive, create: store.create });

    expect(result.admitted).toBe(false);
  });

  it("SPF-9: a true reclaim that did NOT actually clear the cap (still at/over cap on recount) still refuses", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();
    // cap of 1, two already-active sessions — a single reclaimed slot still
    // isn't enough.
    await store.create();
    let active = 2;
    const reclaim = vi.fn(async () => {
      active -= 1;
      return true;
    });
    const countActive = async () => active;

    const result = await gate.admit({ cap: 1, countActive, create: store.create, reclaim });

    expect(result.admitted).toBe(false);
  });

  it("a create() that rejects releases the slot AND leaves the gate usable", async () => {
    const store = fakeSessionStore();
    const gate = new TranscodeAdmissionGate();

    const [failed, ok] = await Promise.allSettled([
      gate.admit({
        cap: 1,
        countActive: store.countActive,
        create: async () => {
          throw new Error("insert blew up");
        },
      }),
      gate.admit({ cap: 1, countActive: store.countActive, create: store.create }),
    ]);

    expect(failed.status).toBe("rejected");
    expect(ok).toMatchObject({ status: "fulfilled", value: { admitted: true } });
    expect(store.active).toBe(1);
  });
});
