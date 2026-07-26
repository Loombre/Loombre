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
});
