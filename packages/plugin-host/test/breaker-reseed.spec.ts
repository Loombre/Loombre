// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/test/breaker-reseed.spec.ts
//
// C5.1 (closes deferred LPP L-5): PluginCircuitBreaker's boot re-seed —
// see breaker.ts's header for the full rationale. This file proves the
// PURE primitive in isolation (constructing a NEW breaker instance with a
// `seed` is exactly what "restart the process" looks like from this
// class's point of view — a brand-new instance is all a restart ever
// produces); apps/server/test/plugins/plugin-registration.e2e.spec.ts's
// own "boot re-seed" describe block proves the DB-backed wiring
// (PluginHealthService.getBreaker reading plugins.consecutive_failures).

import { describe, expect, it } from "vitest";
import { PluginCircuitBreaker } from "../src/breaker.js";

describe("PluginCircuitBreaker boot re-seed (C5.1, closes deferred L-5)", () => {
  it("a fresh breaker with no seed starts at 0 (default, unchanged behavior)", () => {
    const breaker = new PluginCircuitBreaker();
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("a seeded breaker continues counting FROM the seed, not from 0 — simulated restart mid-breaker-window must NOT clear the count", () => {
    // "Before restart": 3 real failures recorded (below the threshold).
    const beforeRestart = new PluginCircuitBreaker({ failureThreshold: 5 });
    beforeRestart.onFailure(0);
    beforeRestart.onFailure(1);
    beforeRestart.onFailure(2);
    expect(beforeRestart.snapshot().consecutiveFailures).toBe(3);

    // "Restart": a BRAND NEW instance (exactly what a process restart
    // produces) — but seeded with the durable count the pre-restart
    // instance had reached, instead of the old unseeded default of 0.
    const afterRestart = new PluginCircuitBreaker({
      failureThreshold: 5,
      seed: { consecutiveFailures: 3, atMs: 100 },
    });
    expect(afterRestart.snapshot()).toEqual({ state: "closed", consecutiveFailures: 3, openedAtMs: null });

    // Exactly 2 MORE failures — not 5 more — must now trip it, proving the
    // pre-restart progress survived the restart.
    expect(afterRestart.onFailure(101).tripped).toBe(false);
    const outcome = afterRestart.onFailure(102);
    expect(outcome.tripped).toBe(true);
    expect(outcome.consecutiveFailures).toBe(5);
    expect(afterRestart.snapshot().state).toBe("open");
  });

  it("WITHOUT a seed, the same restart scenario wrongly hands back a fresh 5-strike budget (documents the pre-fix bug this closes)", () => {
    const afterRestartUnseeded = new PluginCircuitBreaker({ failureThreshold: 5 });
    // The 2 "post-restart" failures alone are nowhere near enough to trip
    // an unseeded breaker — this is the exact regression C5.1 prevents.
    afterRestartUnseeded.onFailure(101);
    const outcome = afterRestartUnseeded.onFailure(102);
    expect(outcome.tripped).toBe(false);
    expect(outcome.consecutiveFailures).toBe(2);
  });

  it("a seed that ALREADY meets the threshold starts the breaker pre-tripped (open), pinned to the seed's clock reading", () => {
    const breaker = new PluginCircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 1000,
      seed: { consecutiveFailures: 5, atMs: 500 },
    });
    expect(breaker.snapshot()).toEqual({ state: "open", consecutiveFailures: 5, openedAtMs: 500 });
    expect(breaker.beforeCall(500).allowed).toBe(false);
    expect(breaker.beforeCall(1499).allowed).toBe(false);
    // resetTimeoutMs is measured from the SEEDED openedAtMs, exactly like a
    // normal trip — the half-open transition still works post-seed.
    expect(breaker.beforeCall(1500).allowed).toBe(true);
    expect(breaker.snapshot().state).toBe("half-open");
  });

  it("a seed that EXCEEDS the threshold (durable count kept climbing while nothing watched) still just opens, never over-counts a state that doesn't exist", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 5, seed: { consecutiveFailures: 9, atMs: 0 } });
    expect(breaker.snapshot()).toEqual({ state: "open", consecutiveFailures: 9, openedAtMs: 0 });
  });

  it("a seed of 0 behaves identically to no seed at all", () => {
    const breaker = new PluginCircuitBreaker({ seed: { consecutiveFailures: 0, atMs: 12345 } });
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("a negative seed (defensive — should never happen from a real DB counter) clamps to 0 rather than corrupting the count", () => {
    const breaker = new PluginCircuitBreaker({ seed: { consecutiveFailures: -3, atMs: 0 } });
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("a success after a seeded-but-still-closed breaker resets to 0, same as any other success", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 5, seed: { consecutiveFailures: 4, atMs: 0 } });
    breaker.onSuccess();
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });
});
