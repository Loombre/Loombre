// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/throttle.spec.ts
//
// Pure decision-table tests for src/transcode/throttle.ts (docs/
// PLAYBACK.md §9 mandatory throttle + P3.8 platform mechanism). No I/O, no
// real ffmpeg/DB — see that module's header for the full reasoning each
// case below is transcribing.

import { describe, expect, it } from "vitest";
import { reconcileThrottle, throttleMechanismForPlatform, THROTTLE_SUSPEND_AHEAD, THROTTLE_RESUME_AHEAD } from "../../src/transcode/throttle.js";

describe("throttleMechanismForPlatform", () => {
  it("win32 -> readrate (P3.8 fallback, no new native dependency)", () => {
    expect(throttleMechanismForPlatform("win32")).toBe("readrate");
  });
  it("darwin/linux -> suspend (real SIGSTOP/SIGCONT)", () => {
    expect(throttleMechanismForPlatform("darwin")).toBe("suspend");
    expect(throttleMechanismForPlatform("linux")).toBe("suspend");
  });
});

describe("reconcileThrottle — mechanism='readrate' always no-ops", () => {
  it("never suspends/resumes regardless of how far ahead", () => {
    const action = reconcileThrottle({
      mechanism: "readrate",
      producedSegment: 999,
      requestedSegment: 0,
      rowStatus: "active",
      suspendedByThrottle: false,
      processStopped: false,
    });
    expect(action).toEqual({ kind: "none" });
  });
});

describe("reconcileThrottle — mechanism='suspend', not currently throttle-suspended", () => {
  it("ahead > 10 and running -> suspend-for-throttle", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: THROTTLE_SUSPEND_AHEAD + 1,
      requestedSegment: 0,
      rowStatus: "active",
      suspendedByThrottle: false,
      processStopped: false,
    });
    expect(action).toEqual({ kind: "suspend-for-throttle" });
  });

  it("exactly at the threshold (ahead === 10) does NOT suspend (strictly greater-than)", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: THROTTLE_SUSPEND_AHEAD,
      requestedSegment: 0,
      rowStatus: "active",
      suspendedByThrottle: false,
      processStopped: false,
    });
    expect(action).toEqual({ kind: "none" });
  });

  it("requestedSegment null is treated as 0, not as unbounded", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 11,
      requestedSegment: null,
      rowStatus: "active",
      suspendedByThrottle: false,
      processStopped: false,
    });
    expect(action).toEqual({ kind: "suspend-for-throttle" });
  });

  it("heartbeat-cause suspend already physically applied -> no duplicate stop-process-only action", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 50,
      requestedSegment: 0,
      rowStatus: "suspended",
      suspendedByThrottle: false,
      processStopped: true,
    });
    expect(action).toEqual({ kind: "none" });
  });

  it("row already 'suspended' for another cause (heartbeat) and process still running -> stop-process-only, no row write", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 2,
      requestedSegment: 0,
      rowStatus: "suspended",
      suspendedByThrottle: false,
      processStopped: false,
    });
    expect(action).toEqual({ kind: "stop-process-only" });
  });

  it("defensive: process stopped but nothing wants it stopped (row active, ahead low) -> resume-for-throttle", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 1,
      requestedSegment: 0,
      rowStatus: "active",
      suspendedByThrottle: false,
      processStopped: true,
    });
    expect(action).toEqual({ kind: "resume-for-throttle" });
  });

  it("nothing produced yet (undefined) never suspends", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: undefined,
      requestedSegment: 0,
      rowStatus: "active",
      suspendedByThrottle: false,
      processStopped: false,
    });
    expect(action).toEqual({ kind: "none" });
  });
});

describe("reconcileThrottle — mechanism='suspend', currently throttle-suspended (suspendedByThrottle=true)", () => {
  it("ahead drops to exactly 5 (the resume threshold) -> resume-for-throttle", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: THROTTLE_RESUME_AHEAD,
      requestedSegment: 0,
      rowStatus: "suspended",
      suspendedByThrottle: true,
      processStopped: true,
    });
    expect(action).toEqual({ kind: "resume-for-throttle" });
  });

  it("ahead still > 5 and row correctly still 'suspended' -> none (steady state)", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 20,
      requestedSegment: 0,
      rowStatus: "suspended",
      suspendedByThrottle: true,
      processStopped: true,
    });
    expect(action).toEqual({ kind: "none" });
  });

  it("a heartbeat flipped the row back to 'active' out from under a still-too-far-ahead throttle -> rewrite-suspended-only (no new physical signal)", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 20,
      requestedSegment: 0,
      rowStatus: "active",
      suspendedByThrottle: true,
      processStopped: true,
    });
    expect(action).toEqual({ kind: "rewrite-suspended-only" });
  });
});

describe("reconcileThrottle — V8 currentRunStartSegment floor (docs/PLAYBACK.md §9 throttle 'Lead arithmetic'; STATE.md 'Seek model V8')", () => {
  it("D-C pin (backward seek): requested pinned below the fresh run's start is a numbering artifact, not encoder lead — produced=200, requested=3, startSegment=201 -> none, never suspend", () => {
    // Pre-V8 this read ahead = 200 - 3 = 197 > 10 and SIGSTOPped the
    // seek-spawned run before its first segment; the resume condition
    // (ahead <= 5) was then arithmetically unreachable ("buffers
    // forever", QA 2026-08-12). With the floor: 200 - max(3, 201) = -1.
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 200,
      requestedSegment: 3,
      currentRunStartSegment: 201,
      rowStatus: "active",
      suspendedByThrottle: false,
      processStopped: false,
    });
    expect(action).toEqual({ kind: "none" });
  });

  it("A3 pin (PURE rung switch, no seek anywhere): the §9.1.4 handoff run at produced+1 with requested still on the old rung's tail must not be suspended pre-first-segment", () => {
    // Old rung produced through 42; handoff run starts at 43; the client
    // is draining the old rung's buffered tail so requested sits at 40.
    // Raw arithmetic (42 - 40 = 2) happens to be safe HERE, but the
    // deadlock fires as soon as the tail is long (e.g. paused viewer):
    const paused = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 55, // old rung raced ahead before the switch
      requestedSegment: 40,
      currentRunStartSegment: 56, // handoff run: produced+1
      rowStatus: "active",
      suspendedByThrottle: false,
      processStopped: false,
    });
    expect(paused).toEqual({ kind: "none" });
  });

  it("deadlock breaker: throttle-suspended with requested below the current run's start resumes (floored ahead <= resume threshold)", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 200,
      requestedSegment: 3,
      currentRunStartSegment: 201,
      rowStatus: "suspended",
      suspendedByThrottle: true,
      processStopped: true,
    });
    expect(action).toEqual({ kind: "resume-for-throttle" });
  });

  it("floor is a no-op in steady state (requested >= startSegment): decisions identical with and without it", () => {
    const base = {
      mechanism: "suspend" as const,
      producedSegment: 30,
      requestedSegment: 12,
      rowStatus: "active" as const,
      suspendedByThrottle: false,
      processStopped: false,
    };
    expect(reconcileThrottle({ ...base, currentRunStartSegment: 5 })).toEqual(reconcileThrottle(base));
    expect(reconcileThrottle({ ...base, currentRunStartSegment: 5 })).toEqual({ kind: "suspend-for-throttle" });
  });

  it("floor never manufactures suspension: requested above startSegment stays authoritative (real lead 2 -> resume while throttle-suspended)", () => {
    const action = reconcileThrottle({
      mechanism: "suspend",
      producedSegment: 20,
      requestedSegment: 18,
      currentRunStartSegment: 10,
      rowStatus: "suspended",
      suspendedByThrottle: true,
      processStopped: true,
    });
    expect(action).toEqual({ kind: "resume-for-throttle" });
  });
});
