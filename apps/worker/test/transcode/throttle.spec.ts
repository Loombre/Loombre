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
