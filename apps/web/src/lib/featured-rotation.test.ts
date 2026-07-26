// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeaturedRotationScheduler, type FeaturedRotationSnapshot } from "./featured-rotation.js";

describe("FeaturedRotationScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeScheduler(overrides: Partial<{ poolLength: number; dwellMs: number; crossfadeMs: number }> = {}) {
    const snapshots: FeaturedRotationSnapshot[] = [];
    const scheduler = new FeaturedRotationScheduler({
      poolLength: overrides.poolLength ?? 5,
      ...(overrides.dwellMs !== undefined ? { dwellMs: overrides.dwellMs } : {}),
      ...(overrides.crossfadeMs !== undefined ? { crossfadeMs: overrides.crossfadeMs } : {}),
      onChange: (s) => snapshots.push(s),
    });
    return { scheduler, snapshots };
  }

  describe("dwell (auto-advance)", () => {
    it("does not advance before start()", () => {
      const { scheduler, snapshots } = makeScheduler();
      vi.advanceTimersByTime(7000);
      expect(snapshots).toHaveLength(0);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
    });

    it("advances to the next index every 7s by default", () => {
      const { scheduler, snapshots } = makeScheduler();
      scheduler.start();
      vi.advanceTimersByTime(7000);
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
      vi.advanceTimersByTime(7000);
      expect(scheduler.getSnapshot().activeIndex).toBe(2);
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
    });

    it("wraps around at the end of the pool", () => {
      const { scheduler } = makeScheduler({ poolLength: 3 });
      scheduler.start();
      vi.advanceTimersByTime(7000 * 3);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
    });

    it("respects a custom dwell time", () => {
      const { scheduler } = makeScheduler({ dwellMs: 1000 });
      scheduler.start();
      vi.advanceTimersByTime(1000);
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
    });

    it("stop() halts further auto-advance", () => {
      const { scheduler } = makeScheduler();
      scheduler.start();
      vi.advanceTimersByTime(7000);
      scheduler.stop();
      vi.advanceTimersByTime(7000 * 5);
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
    });

    it("never auto-advances with a pool of one item, and hides the control cluster", () => {
      const { scheduler } = makeScheduler({ poolLength: 1 });
      scheduler.start();
      vi.advanceTimersByTime(7000 * 10);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
      expect(scheduler.isControlClusterVisible()).toBe(false);
    });

    it("shows the control cluster once the pool has more than one item", () => {
      const { scheduler } = makeScheduler({ poolLength: 2 });
      expect(scheduler.isControlClusterVisible()).toBe(true);
    });
  });

  describe("crossfade (two stacked layers)", () => {
    it("sets previousIndex + crossfading on advance, then only crossfading clears after crossfadeMs", () => {
      const { scheduler } = makeScheduler({ crossfadeMs: 260 });
      scheduler.start();
      vi.advanceTimersByTime(7000);
      expect(scheduler.getSnapshot()).toEqual({ activeIndex: 1, previousIndex: 0, crossfading: true });
      vi.advanceTimersByTime(260);
      // previousIndex is deliberately NOT reset to null (see the type's own
      // doc comment) — it stays put as the stable "outgoing layer" content
      // key; only `crossfading` (its visibility) clears.
      expect(scheduler.getSnapshot()).toEqual({ activeIndex: 1, previousIndex: 0, crossfading: false });
    });

    it("jumpTo() also crossfades", () => {
      const { scheduler } = makeScheduler();
      scheduler.jumpTo(3);
      expect(scheduler.getSnapshot()).toMatchObject({ activeIndex: 3, previousIndex: 0, crossfading: true });
      vi.advanceTimersByTime(260);
      expect(scheduler.getSnapshot().crossfading).toBe(false);
    });

    it("jumping to the already-active index is a no-op (no crossfade, no snapshot emitted)", () => {
      const { scheduler, snapshots } = makeScheduler();
      scheduler.jumpTo(0);
      expect(snapshots).toHaveLength(0);
    });
  });

  describe("pause conditions (README: hover, overlay-open, reduced-motion)", () => {
    it("pauses the dwell timer on hover and resumes on release", () => {
      const { scheduler } = makeScheduler();
      scheduler.start();
      scheduler.setHoverPaused(true);
      vi.advanceTimersByTime(7000 * 3);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
      scheduler.setHoverPaused(false);
      vi.advanceTimersByTime(7000);
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
    });

    it("pauses while an overlay is open (e.g. the music queue drawer) and resumes on close", () => {
      const { scheduler } = makeScheduler();
      scheduler.start();
      scheduler.setOverlayPaused(true);
      vi.advanceTimersByTime(7000 * 2);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
      scheduler.setOverlayPaused(false);
      vi.advanceTimersByTime(7000);
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
    });

    it("reduced motion disables auto-advance entirely", () => {
      const { scheduler } = makeScheduler();
      scheduler.setReducedMotion(true);
      scheduler.start();
      vi.advanceTimersByTime(7000 * 10);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
    });

    it("reduced motion still allows manual dot navigation, without a crossfade animation", () => {
      const { scheduler } = makeScheduler();
      scheduler.setReducedMotion(true);
      scheduler.jumpTo(2);
      expect(scheduler.getSnapshot()).toEqual({ activeIndex: 2, previousIndex: 0, crossfading: false });
    });

    it("manual next()/prev()/jumpTo() reset the dwell timer (README: 'interacting resets the dwell timer')", () => {
      const { scheduler } = makeScheduler();
      scheduler.start();
      vi.advanceTimersByTime(6000); // 1s away from an auto-advance
      scheduler.next(); // -> index 1, and a FRESH 7s dwell period starts
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
      vi.advanceTimersByTime(6000); // would have double-advanced if the timer weren't reset
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(scheduler.getSnapshot().activeIndex).toBe(2);
    });

    it("multiple simultaneous pause reasons all have to clear before dwell resumes", () => {
      const { scheduler } = makeScheduler();
      scheduler.start();
      scheduler.setHoverPaused(true);
      scheduler.setOverlayPaused(true);
      scheduler.setHoverPaused(false); // overlay still open
      vi.advanceTimersByTime(7000 * 3);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
      scheduler.setOverlayPaused(false);
      vi.advanceTimersByTime(7000);
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
    });
  });

  describe("setPoolLength", () => {
    it("resets to index 0 if the pool shrinks below the current active index", () => {
      const { scheduler } = makeScheduler({ poolLength: 5 });
      scheduler.jumpTo(4);
      scheduler.setPoolLength(2);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
    });

    it("re-evaluates dwell suppression (e.g. pool 1 -> 3 while started begins auto-advancing)", () => {
      const { scheduler } = makeScheduler({ poolLength: 1 });
      scheduler.start();
      vi.advanceTimersByTime(7000 * 2);
      expect(scheduler.getSnapshot().activeIndex).toBe(0);
      scheduler.setPoolLength(3);
      vi.advanceTimersByTime(7000);
      expect(scheduler.getSnapshot().activeIndex).toBe(1);
    });
  });

  // Phosphor W3 fidelity-audit finding (fix wave FX1): the DEFAULT
  // `setTimeoutImpl`/`clearTimeoutImpl` used to store the BARE
  // `setTimeout`/`clearTimeout` identifiers (`options.setTimeoutImpl ??
  // setTimeout`, no `.bind`). Storing a bare function on an object
  // property and later invoking it as `this.setTimeoutImpl(...)` calls it
  // with the SCHEDULER INSTANCE as `this` (ordinary JS method-call
  // semantics), not `window`. A real browser's `window.setTimeout`/
  // `window.clearTimeout` are native functions that require their
  // receiver to be a Window-branded object — called with any other
  // receiver, they throw `TypeError: Illegal invocation`. jsdom's fake
  // timer implementation (used by every OTHER test in this file, via
  // `vi.useFakeTimers()`) doesn't enforce that receiver check at all, so
  // all 48 pre-existing tests here passed even with the bug in place —
  // this is exactly why the bug shipped unnoticed until browser
  // ground-truthing caught it. The fix (`.bind(globalThis)` at
  // construction, see the constructor) must hold for BOTH the default
  // path AND any caller-supplied impl.
  //
  // Two independent proofs below, per the task's documented approaches:
  // (a) spy on the REAL global timers and assert the recorded `this`
  //     context of each call is `globalThis`, never the scheduler
  //     instance — exercises the true default (no options override) path
  //     that shipped the bug; (b) hand the scheduler a plain (non-arrow)
  //     function as the impl that itself asserts `this` is not the
  //     scheduler instance, simulating a browser-strictness check inline
  //     at the call site.
  describe("timer binding (browser-strictness regression guard)", () => {
    it("REGRESSION GUARD (a): the default setTimeout/clearTimeout are invoked with globalThis as `this`, never the scheduler instance", () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const { scheduler } = makeScheduler({ poolLength: 3 });
      scheduler.start(); // schedules a dwell timer -> exercises setTimeoutImpl
      expect(setTimeoutSpy).toHaveBeenCalled();
      expect(setTimeoutSpy.mock.contexts[0]).toBe(globalThis);
      expect(setTimeoutSpy.mock.contexts[0]).not.toBe(scheduler);

      scheduler.stop(); // exercises clearTimeoutImpl
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(clearTimeoutSpy.mock.contexts[0]).toBe(globalThis);
      expect(clearTimeoutSpy.mock.contexts[0]).not.toBe(scheduler);

      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });

    it("REGRESSION GUARD (b): a caller-supplied impl that asserts its own `this` is never invoked with the scheduler instance as the receiver", () => {
      // Direct `this === ...` comparisons ONLY (never aliased to a bare
      // variable — @typescript-eslint/no-this-alias) so each tracker just
      // records which receiver hypothesis held.
      let setTimeoutCalledOnScheduler: boolean | null = null;
      let setTimeoutCalledOnGlobalThis: boolean | null = null;
      let clearTimeoutCalledOnScheduler: boolean | null = null;
      let clearTimeoutCalledOnGlobalThis: boolean | null = null;

      // Deliberately plain `function`s (not arrows) so each has its own
      // `this` determined by how it's CALLED, exactly like the real
      // `window.setTimeout`/`window.clearTimeout` this bug mis-invoked.
      function trackingSetTimeout(this: unknown, ...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> {
        setTimeoutCalledOnScheduler = this === scheduler;
        setTimeoutCalledOnGlobalThis = this === globalThis;
        return setTimeout(...args);
      }
      function trackingClearTimeout(this: unknown, ...args: Parameters<typeof clearTimeout>): void {
        clearTimeoutCalledOnScheduler = this === scheduler;
        clearTimeoutCalledOnGlobalThis = this === globalThis;
        clearTimeout(...args);
      }

      const scheduler = new FeaturedRotationScheduler({
        poolLength: 3,
        onChange: () => {},
        setTimeoutImpl: trackingSetTimeout as typeof setTimeout,
        clearTimeoutImpl: trackingClearTimeout as typeof clearTimeout,
      });

      scheduler.start();
      expect(setTimeoutCalledOnScheduler).toBe(false);
      expect(setTimeoutCalledOnGlobalThis).toBe(true);

      scheduler.stop();
      expect(clearTimeoutCalledOnScheduler).toBe(false);
      expect(clearTimeoutCalledOnGlobalThis).toBe(true);
    });
  });
});
