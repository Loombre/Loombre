// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/plugin-host/src/breaker.ts
//
// LD2/LD8: a PURE circuit-breaker state machine — no timers, no I/O, the
// clock is always an argument (mirrors CLAUDE.md invariant 2's
// playback-engine purity rule, applied here to a much smaller state
// machine). One instance gates ONE plugin's outbound calls; the owning
// caller (apps/server/src/plugins, per-plugin, in-memory) is responsible
// for construction/lifetime — this class holds no reference to a plugin id
// or any Loombre infrastructure.
//
// Three states, classic breaker shape:
//   closed    -> calls flow through normally.
//   open      -> calls are rejected outright (beforeCall returns
//                { allowed: false }) until resetTimeoutMs has elapsed since
//                the breaker opened.
//   half-open -> exactly ONE trial call is admitted once resetTimeoutMs has
//                elapsed; a further beforeCall() while that trial is still
//                in flight is rejected (never a stampede of trial calls).
//                Success closes the breaker; failure reopens it
//                immediately (no additional grace).
//
// This is the in-PROCESS fast-path gate over a failure signal — it is
// deliberately NOT the durable, cross-process count: that is
// packages/db/migrations/0014_plugins.sql's plugins.consecutive_failures
// column, written by apps/server/src/plugins's health/breaker service
// alongside this class's own bookkeeping (see that service's header for how
// the two stay in step).
//
// C5.1 fix wave (closes deferred LPP L-5): a process restart used to reset
// this class to `closed` with zero consecutive failures regardless of what
// the DB column said — a plugin already at 4 consecutive DB-recorded
// failures got a fresh 5-strike budget after a Loombre restart, so a
// crash-looping plugin could reset its own breaker for free just by the
// host bouncing (or, worse: the NEXT failure after a restart would
// overwrite the durable `consecutive_failures` column back down from its
// true value, since `PluginHealthService.runHealthCheck` persists
// `breaker.snapshot().consecutiveFailures` verbatim — so an un-reseeded
// breaker didn't just forget locally, it corrupted the durable counter on
// its very next write). Fixed: the constructor accepts an optional `seed`
// (typically `plugins.consecutive_failures` read once at first
// construction, i.e. effectively "at boot" for a lazily-constructed
// per-plugin breaker — see PluginHealthService.getBreaker) and continues
// counting FROM that value rather than from zero. If the seed alone already
// meets/exceeds `failureThreshold` (the durable count crossed the line
// while nothing was watching, e.g. mid-restart), the breaker starts
// pre-tripped `open` as of `seed.atMs` — the clock is still an injected
// argument even in this edge case, never `Date.now()` internally, matching
// this class's existing pure/no-I-O contract.
import { LPP_BREAKER_FAILURE_THRESHOLD, LPP_BREAKER_RESET_TIMEOUT_MS } from "./timeouts.js";

export type PluginBreakerState = "closed" | "open" | "half-open";

export interface PluginBreakerSnapshot {
  state: PluginBreakerState;
  consecutiveFailures: number;
  openedAtMs: number | null;
}

export interface PluginBreakerSeed {
  /** A durable consecutive-failure count read from elsewhere (typically
   *  `plugins.consecutive_failures`) to continue counting from, instead of
   *  starting a brand-new breaker at 0 (C5.1, closes deferred LPP L-5). */
  consecutiveFailures: number;
  /** The clock reading the seed was taken at. Only consulted if
   *  `consecutiveFailures` alone already meets/exceeds `failureThreshold` —
   *  in that case it becomes `openedAtMs`, so `beforeCall`'s normal
   *  resetTimeoutMs-elapsed half-open transition still works correctly
   *  instead of leaving the breaker open forever. */
  atMs: number;
}

export interface PluginBreakerOptions {
  /** Defaults to LPP_BREAKER_FAILURE_THRESHOLD (5, LD8). */
  failureThreshold?: number;
  /** Defaults to LPP_BREAKER_RESET_TIMEOUT_MS (60s — see timeouts.ts's
   *  header for why this specific number is a lane decision, not a rail). */
  resetTimeoutMs?: number;
  /** C5.1 (closes deferred LPP L-5): seed this breaker's failure count from
   *  a durable source at construction time. Omit for a brand-new breaker
   *  with no prior history (the default, unchanged behavior). */
  seed?: PluginBreakerSeed;
}

export interface PluginBreakerCallAdmission {
  allowed: boolean;
}

export interface PluginBreakerFailureOutcome {
  /** True exactly on the ONE call whose failure crosses the threshold
   *  (closed -> open transition). A caller uses this to know precisely
   *  when to persist the DB-level auto-disable (LD8) — never on every
   *  subsequent failure while already open. */
  tripped: boolean;
  consecutiveFailures: number;
}

export class PluginCircuitBreaker {
  private state: PluginBreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(opts: PluginBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? LPP_BREAKER_FAILURE_THRESHOLD;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? LPP_BREAKER_RESET_TIMEOUT_MS;

    // C5.1 boot re-seed (closes deferred LPP L-5).
    if (opts.seed) {
      this.consecutiveFailures = Math.max(0, opts.seed.consecutiveFailures);
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = "open";
        this.openedAtMs = opts.seed.atMs;
      }
    }
  }

  snapshot(): PluginBreakerSnapshot {
    return { state: this.state, consecutiveFailures: this.consecutiveFailures, openedAtMs: this.openedAtMs };
  }

  /** Pure function of injected `nowMs` — an OPEN breaker transitions itself
   *  to half-open (and admits this one call) exactly when `nowMs` shows
   *  `resetTimeoutMs` has elapsed since it opened; there is no background
   *  timer anywhere in this class. */
  beforeCall(nowMs: number): PluginBreakerCallAdmission {
    if (this.state === "closed") return { allowed: true };
    if (this.state === "half-open") return { allowed: false };
    // open
    if (this.openedAtMs !== null && nowMs - this.openedAtMs >= this.resetTimeoutMs) {
      this.state = "half-open";
      return { allowed: true };
    }
    return { allowed: false };
  }

  onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
  }

  onFailure(nowMs: number): PluginBreakerFailureOutcome {
    this.consecutiveFailures += 1;

    if (this.state === "half-open") {
      // The trial call failed — reopen immediately, no further grace.
      this.state = "open";
      this.openedAtMs = nowMs;
      return { tripped: false, consecutiveFailures: this.consecutiveFailures };
    }

    if (this.state !== "open" && this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAtMs = nowMs;
      return { tripped: true, consecutiveFailures: this.consecutiveFailures };
    }

    return { tripped: false, consecutiveFailures: this.consecutiveFailures };
  }

  /** Force-closes the breaker (LD8: "manual re-enable service method resets
   *  the count") — apps/server's lifecycle service calls this alongside
   *  its own DB-column reset when an admin manually re-enables a
   *  breaker-disabled plugin. */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
  }
}
