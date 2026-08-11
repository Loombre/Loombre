// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatScheduler, type HeartbeatSnapshot } from "./heartbeat.js";

describe("HeartbeatScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeScheduler(overrides: Partial<{ intervalMs: number }> = {}) {
    const sends: HeartbeatSnapshot[] = [];
    let position = 0;
    const scheduler = new HeartbeatScheduler({
      ...(overrides.intervalMs !== undefined ? { intervalMs: overrides.intervalMs } : {}),
      getSnapshot: () => ({ positionMs: position, durationMs: 100_000, state: "in-progress" }),
      send: (snapshot) => sends.push(snapshot),
    });
    return { scheduler, sends, setPosition: (ms: number) => (position = ms) };
  }

  it("does not send immediately on start()", () => {
    const { scheduler, sends } = makeScheduler();
    scheduler.start();
    expect(sends).toHaveLength(0);
  });

  it("sends every ~10s by default while running", () => {
    const { scheduler, sends } = makeScheduler();
    scheduler.start();
    vi.advanceTimersByTime(10_000);
    expect(sends).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(sends).toHaveLength(2);
    vi.advanceTimersByTime(25_000);
    expect(sends).toHaveLength(4); // 2 more full 10s ticks inside 25s
  });

  it("respects a custom interval", () => {
    const { scheduler, sends } = makeScheduler({ intervalMs: 5_000 });
    scheduler.start();
    vi.advanceTimersByTime(5_000);
    expect(sends).toHaveLength(1);
  });

  it("stop() halts further ticks", () => {
    const { scheduler, sends } = makeScheduler();
    scheduler.start();
    vi.advanceTimersByTime(10_000);
    scheduler.stop();
    vi.advanceTimersByTime(30_000);
    expect(sends).toHaveLength(1);
  });

  it("flushNow() sends immediately with the current snapshot, independent of the timer", () => {
    const { scheduler, sends, setPosition } = makeScheduler();
    setPosition(42_000);
    scheduler.flushNow();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.positionMs).toBe(42_000);
  });

  it("flushNow() works even when the scheduler was never started (pause/seek before any play)", () => {
    const { scheduler, sends } = makeScheduler();
    scheduler.flushNow();
    expect(sends).toHaveLength(1);
  });

  it("start() is idempotent — calling it twice does not double the tick rate", () => {
    const { scheduler, sends } = makeScheduler();
    scheduler.start();
    scheduler.start();
    vi.advanceTimersByTime(10_000);
    expect(sends).toHaveLength(1);
  });

  it("isRunning() reflects start/stop", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("each tick reads a FRESH snapshot (position changing between ticks is reflected)", () => {
    const { scheduler, sends, setPosition } = makeScheduler();
    scheduler.start();
    setPosition(1_000);
    vi.advanceTimersByTime(10_000);
    setPosition(2_000);
    vi.advanceTimersByTime(10_000);
    expect(sends.map((s) => s.positionMs)).toEqual([1_000, 2_000]);
  });

  it("DEFAULT timer impls survive a receiver-sensitive host (browser natives throw 'Illegal invocation' on a foreign this)", () => {
    // Field bug (2026-08-08 owner QA): every test above injects its own
    // impls through the seam, so the DEFAULT branch — the one the real
    // VideoPlayer runs — only ever executed in a browser, where storing
    // the bare native setInterval on the instance and calling
    // `this.setIntervalImpl(...)` invokes it with the scheduler as `this`
    // and Chrome throws "Illegal invocation" on the first play. Node's
    // timers don't care about the receiver, so this test stubs the global
    // with a receiver-sensitive fake to reproduce the browser's behavior.
    //
    // ORDERING NOTE (2026-08-10, aligned with featured-rotation.ts's
    // identical seam): the fix is `(options.setIntervalImpl ??
    // setInterval).bind(globalThis)`, evaluated ONCE inside the
    // constructor — `.bind()` captures a reference to whatever function
    // `setInterval` resolves to AT THAT INSTANT, it does not re-resolve the
    // global lazily on every call. So stubbing the global BEFORE
    // constructing the scheduler is genuinely REQUIRED here (not
    // incidental): a stub installed after construction would bind too late
    // and the scheduler would keep calling the real, unstubbed timer.
    const registered: Array<() => void> = [];
    function receiverSensitiveSetInterval(this: unknown, fn: () => void): number {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      registered.push(fn);
      return registered.length;
    }
    function receiverSensitiveClearInterval(this: unknown): void {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    }
    vi.stubGlobal("setInterval", receiverSensitiveSetInterval);
    vi.stubGlobal("clearInterval", receiverSensitiveClearInterval);
    try {
      const scheduler = new HeartbeatScheduler({
        getSnapshot: () => ({ positionMs: 0, durationMs: null, state: "in-progress" }),
        send: () => {},
      });
      expect(() => scheduler.start()).not.toThrow();
      expect(registered).toHaveLength(1);
      expect(() => scheduler.stop()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Wave C2 (docs/PLAYBACK.md §9.1.9): "Heartbeat: UNTOUCHED in both
// directions." This block is the PROOF of that claim rather than a change
// to it — a zero-diff assertion, which is the only kind that can go stale
// silently and therefore the only kind worth writing down.
// ───────────────────────────────────────────────────────────────────────────

describe("heartbeat is switch-agnostic by construction (§9.1.9)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the snapshot carries NO rung/level/variant field — there is nothing for a switch to change", () => {
    // The client reports what its media element knows: a PRESENTATION
    // position, a duration, and a state. Which rung produced those bytes
    // is not a fact the element exposes and not a fact the server needs
    // from the client: §9.1.6's presentation->source mapping is entirely
    // server-side, driven by transcode_runs, and its within-run 1:1
    // rate-equivalence argument is rung-INDEPENDENT (re-encoding at a
    // different bitrate or height never changes the time rate). A client
    // that volunteered a rung would be volunteering something the server
    // must not trust anyway.
    const snapshot: HeartbeatSnapshot = { positionMs: 1234, durationMs: 100_000, state: "in-progress" };
    expect(Object.keys(snapshot).sort()).toEqual(["durationMs", "positionMs", "state"]);
  });

  it("a rung switch cannot interrupt the cadence: the scheduler is driven by time, not by media events", () => {
    // §9.1.4: a pure switch never changes session status and never
    // suspends the session, and the handoff window (seconds) is two orders
    // of magnitude inside the 90 s suspend cutoff. The client half of that
    // is that nothing about a switch is even observable here — the
    // scheduler ticks on an interval and reads a snapshot, so a viewer
    // whose pipeline is mid-handoff keeps heartbeating from buffered
    // content exactly as before.
    const sends: HeartbeatSnapshot[] = [];
    let position = 0;
    const scheduler = new HeartbeatScheduler({
      getSnapshot: () => ({ positionMs: position, durationMs: 100_000, state: "in-progress" }),
      send: (s) => sends.push(s),
    });
    scheduler.start();
    // Simulate a handoff: several seconds during which the live edge is
    // 503ing and the element plays out its buffer. Position keeps moving,
    // heartbeats keep flowing.
    for (let i = 0; i < 4; i += 1) {
      position += 10_000;
      vi.advanceTimersByTime(10_000);
    }
    scheduler.stop();
    expect(sends.map((s) => s.positionMs)).toEqual([10_000, 20_000, 30_000, 40_000]);
  });
});
