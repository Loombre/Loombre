// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/test/breaker.spec.ts
//
// Pure state-machine matrix for PluginCircuitBreaker (LD8) — every
// transition driven by an explicit injected `nowMs`, no real timers
// anywhere in this file.

import { describe, expect, it } from "vitest";
import { PluginCircuitBreaker } from "../src/breaker.js";

describe("PluginCircuitBreaker", () => {
  it("starts closed and admits calls", () => {
    const breaker = new PluginCircuitBreaker();
    expect(breaker.snapshot().state).toBe("closed");
    expect(breaker.beforeCall(0).allowed).toBe(true);
  });

  it("stays closed and resets the failure count on success", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 5 });
    breaker.onFailure(0);
    breaker.onFailure(1);
    breaker.onSuccess();
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("trips open exactly on the Nth failure (default threshold 5, LD8)", () => {
    const breaker = new PluginCircuitBreaker();
    let lastOutcome;
    for (let i = 1; i <= 4; i++) {
      lastOutcome = breaker.onFailure(i);
      expect(lastOutcome.tripped, `failure #${i} should not trip yet`).toBe(false);
      expect(breaker.snapshot().state).toBe("closed");
    }
    lastOutcome = breaker.onFailure(5);
    expect(lastOutcome.tripped).toBe(true);
    expect(lastOutcome.consecutiveFailures).toBe(5);
    expect(breaker.snapshot().state).toBe("open");
  });

  it("respects a custom failureThreshold", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 2 });
    expect(breaker.onFailure(0).tripped).toBe(false);
    expect(breaker.onFailure(1).tripped).toBe(true);
  });

  it("rejects every call while open, before resetTimeoutMs elapses", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    breaker.onFailure(0);
    expect(breaker.beforeCall(0).allowed).toBe(false);
    expect(breaker.beforeCall(999).allowed).toBe(false);
  });

  it("half-opens and admits exactly one trial call once resetTimeoutMs has elapsed", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    breaker.onFailure(0); // opens at t=0
    expect(breaker.beforeCall(999).allowed).toBe(false);
    expect(breaker.beforeCall(1000).allowed).toBe(true); // elapsed -> half-open, trial admitted
    expect(breaker.snapshot().state).toBe("half-open");
    // A second concurrent call while the trial is in flight is rejected —
    // never a stampede.
    expect(breaker.beforeCall(1001).allowed).toBe(false);
  });

  it("a successful half-open trial closes the breaker", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    breaker.onFailure(0);
    breaker.beforeCall(1000); // -> half-open
    breaker.onSuccess();
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
    expect(breaker.beforeCall(1000).allowed).toBe(true);
  });

  it("a failed half-open trial reopens immediately (no additional grace)", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    breaker.onFailure(0); // opens at t=0
    breaker.beforeCall(1000); // -> half-open
    const outcome = breaker.onFailure(1000);
    expect(outcome.tripped).toBe(false); // already open before this failure — not a NEW trip
    expect(breaker.snapshot().state).toBe("open");
    expect(breaker.beforeCall(1000).allowed).toBe(false);
    expect(breaker.beforeCall(1999).allowed).toBe(false);
    expect(breaker.beforeCall(2000).allowed).toBe(true); // resetTimeoutMs measured from the NEW openedAtMs
  });

  it("reset() force-closes the breaker (LD8 manual re-enable)", () => {
    const breaker = new PluginCircuitBreaker({ failureThreshold: 1 });
    breaker.onFailure(0);
    expect(breaker.snapshot().state).toBe("open");
    breaker.reset();
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, openedAtMs: null });
  });

  it("uses the exported LPP_BREAKER_FAILURE_THRESHOLD / LPP_BREAKER_RESET_TIMEOUT_MS as defaults", async () => {
    const { LPP_BREAKER_FAILURE_THRESHOLD, LPP_BREAKER_RESET_TIMEOUT_MS } = await import("../src/timeouts.js");
    const breaker = new PluginCircuitBreaker();
    let outcome;
    for (let i = 1; i <= LPP_BREAKER_FAILURE_THRESHOLD; i++) outcome = breaker.onFailure(0);
    expect(outcome?.tripped).toBe(true);
    expect(breaker.beforeCall(LPP_BREAKER_RESET_TIMEOUT_MS - 1).allowed).toBe(false);
    expect(breaker.beforeCall(LPP_BREAKER_RESET_TIMEOUT_MS).allowed).toBe(true);
  });
});
