// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-jobs-live.test.ts

import { describe, expect, it } from "vitest";
import { mergeJobUpdate, type Job } from "./admin-jobs-live.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    type: "scan",
    status: "queued",
    priority: 0,
    attempts: 0,
    lastError: null,
    subjectItemId: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    startedAtMs: null,
    finishedAtMs: null,
    ...overrides,
  };
}

describe("mergeJobUpdate", () => {
  it("updates an existing row in place, preserving array position", () => {
    const jobs = [makeJob({ id: "job-a" }), makeJob({ id: "job-b" }), makeJob({ id: "job-c" })];
    const next = mergeJobUpdate(jobs, {
      jobId: "job-b",
      jobType: "scan",
      status: "active",
      updatedAtMs: 2000,
    });
    expect(next.map((j) => j.id)).toEqual(["job-a", "job-b", "job-c"]);
    expect(next[1]!.status).toBe("active");
    expect(next[1]!.startedAtMs).toBe(2000);
    expect(next[1]!.updatedAtMs).toBe(2000);
  });

  it("does not overwrite an already-set startedAtMs on a later active transition", () => {
    const jobs = [makeJob({ id: "job-a", status: "active", startedAtMs: 1500 })];
    const next = mergeJobUpdate(jobs, {
      jobId: "job-a",
      jobType: "scan",
      status: "active",
      updatedAtMs: 3000,
    });
    expect(next[0]!.startedAtMs).toBe(1500);
  });

  it("sets finishedAtMs on a completed transition", () => {
    const jobs = [makeJob({ id: "job-a", status: "active", startedAtMs: 1500 })];
    const next = mergeJobUpdate(jobs, {
      jobId: "job-a",
      jobType: "scan",
      status: "completed",
      updatedAtMs: 4000,
    });
    expect(next[0]!.status).toBe("completed");
    expect(next[0]!.finishedAtMs).toBe(4000);
  });

  it("sets finishedAtMs and lastError on a failed transition", () => {
    const jobs = [makeJob({ id: "job-a", status: "active" })];
    const next = mergeJobUpdate(jobs, {
      jobId: "job-a",
      jobType: "probe",
      status: "failed",
      errorMessage: "ffprobe exited 1",
      updatedAtMs: 5000,
    });
    expect(next[0]!.status).toBe("failed");
    expect(next[0]!.lastError).toBe("ffprobe exited 1");
    expect(next[0]!.finishedAtMs).toBe(5000);
  });

  it("preserves the prior lastError when a transition carries no errorMessage", () => {
    const jobs = [makeJob({ id: "job-a", status: "failed", lastError: "earlier failure" })];
    const next = mergeJobUpdate(jobs, {
      jobId: "job-a",
      jobType: "scan",
      status: "active",
      updatedAtMs: 6000,
    });
    expect(next[0]!.lastError).toBe("earlier failure");
  });

  it("prepends a synthesized row for an unseen jobId (newest-first order)", () => {
    const jobs = [makeJob({ id: "job-old" })];
    const next = mergeJobUpdate(jobs, {
      jobId: "job-new",
      jobType: "hwprobe",
      status: "queued",
      updatedAtMs: 7000,
    });
    expect(next.map((j) => j.id)).toEqual(["job-new", "job-old"]);
    expect(next[0]!.type).toBe("hwprobe");
    expect(next[0]!.status).toBe("queued");
    expect(next[0]!.createdAtMs).toBe(7000);
    expect(next[0]!.startedAtMs).toBeNull();
    expect(next[0]!.finishedAtMs).toBeNull();
  });

  it("synthesizes startedAtMs for an unseen jobId whose first observed transition is already 'active'", () => {
    const next = mergeJobUpdate([], {
      jobId: "job-new",
      jobType: "image",
      status: "active",
      updatedAtMs: 8000,
    });
    expect(next[0]!.startedAtMs).toBe(8000);
  });

  it("does not mutate the input array (frozen array passed directly)", () => {
    const frozen: readonly Job[] = Object.freeze([makeJob({ id: "job-a" })]);
    expect(() =>
      mergeJobUpdate(frozen, { jobId: "job-a", jobType: "scan", status: "active", updatedAtMs: 9000 }),
    ).not.toThrow();
  });
});
