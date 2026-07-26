// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/tls/renewal.spec.ts
//
// Renewal window math (deliverable 3's "renewal window math") + the
// scheduler wrapper, entirely fake-clock/fake-timer driven — no real
// sleeps anywhere in this file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWithinRenewalWindow, msUntilRenewalDue, startRenewalScheduler } from "./renewal.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_AFTER = Date.UTC(2026, 6, 24, 0, 0, 0); // 2026-07-24T00:00:00Z

describe("isWithinRenewalWindow", () => {
  it("is false well before the window (60 days out, 30-day window)", () => {
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER - 60 * DAY_MS, 30)).toBe(false);
  });

  it("is false one millisecond before the window opens", () => {
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER - 30 * DAY_MS - 1, 30)).toBe(false);
  });

  it("is true exactly at the window boundary (inclusive)", () => {
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER - 30 * DAY_MS, 30)).toBe(true);
  });

  it("is true inside the window (10 days out)", () => {
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER - 10 * DAY_MS, 30)).toBe(true);
  });

  it("is true exactly at expiry", () => {
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER, 30)).toBe(true);
  });

  it("is true after expiry (overdue renewal)", () => {
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER + DAY_MS, 30)).toBe(true);
  });

  it("defaults windowDays to 30 when omitted", () => {
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER - 29 * DAY_MS)).toBe(true);
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER - 31 * DAY_MS)).toBe(false);
  });

  it("honors a custom window (e.g. pebble's short-lived test certs)", () => {
    // pebble issues 5-day certs by default; a 1-day renewal window is a
    // realistic test-tuned value.
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER - 2 * DAY_MS, 1)).toBe(false);
    expect(isWithinRenewalWindow(NOT_AFTER, NOT_AFTER - 12 * 60 * 60 * 1000, 1)).toBe(true);
  });
});

describe("msUntilRenewalDue", () => {
  it("counts down to the window boundary, never negative", () => {
    expect(msUntilRenewalDue(NOT_AFTER, NOT_AFTER - 40 * DAY_MS, 30)).toBe(10 * DAY_MS);
    expect(msUntilRenewalDue(NOT_AFTER, NOT_AFTER - 30 * DAY_MS, 30)).toBe(0);
    expect(msUntilRenewalDue(NOT_AFTER, NOT_AFTER - 10 * DAY_MS, 30)).toBe(0);
    expect(msUntilRenewalDue(NOT_AFTER, NOT_AFTER + DAY_MS, 30)).toBe(0);
  });
});

describe("startRenewalScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes checkAndRenew on every tick of the configured interval", async () => {
    const checkAndRenew = vi.fn().mockResolvedValue(undefined);
    const stop = startRenewalScheduler(checkAndRenew, { checkIntervalMs: 1000 });

    expect(checkAndRenew).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(checkAndRenew).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(checkAndRenew).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(checkAndRenew).toHaveBeenCalledTimes(3);
  });

  it("defaults to a 24h interval", async () => {
    const checkAndRenew = vi.fn().mockResolvedValue(undefined);
    const stop = startRenewalScheduler(checkAndRenew);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 1);
    expect(checkAndRenew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(checkAndRenew).toHaveBeenCalledTimes(1);
    stop();
  });

  it("routes a rejected checkAndRenew to onError instead of crashing the loop", async () => {
    const err = new Error("renewal failed");
    const checkAndRenew = vi.fn().mockRejectedValue(err);
    const onError = vi.fn();
    const stop = startRenewalScheduler(checkAndRenew, { checkIntervalMs: 1000, onError });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith(err);

    // the loop keeps running after a failure
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkAndRenew).toHaveBeenCalledTimes(2);
    stop();
  });

  it("swallows-and-logs by default when no onError is provided", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const checkAndRenew = vi.fn().mockRejectedValue(new Error("boom"));
    const stop = startRenewalScheduler(checkAndRenew, { checkIntervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(errorSpy).toHaveBeenCalled();
    stop();
    errorSpy.mockRestore();
  });
});
