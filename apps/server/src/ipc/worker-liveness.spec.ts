// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/ipc/worker-liveness.spec.ts

import { describe, expect, it } from "vitest";
import { computeWorkerProcessInfo, WORKER_LIVENESS_FRESHNESS_MS } from "./worker-liveness.js";

const NOW = 1_800_000_000_000;
const VERSION = "0.9.0-dev+test";

describe("computeWorkerProcessInfo", () => {
  it("reports 'running' when a job is currently active", () => {
    const info = computeWorkerProcessInfo([{ status: "active", updatedAtMs: NOW - 999_999 }], VERSION, NOW);
    expect(info.state).toBe("running");
  });

  it("reports 'running' when the most recent job was touched within the freshness window", () => {
    const info = computeWorkerProcessInfo(
      [{ status: "completed", updatedAtMs: NOW - WORKER_LIVENESS_FRESHNESS_MS + 1 }],
      VERSION,
      NOW,
    );
    expect(info.state).toBe("running");
  });

  it("reports 'stopped' when the most recent job is older than the freshness window", () => {
    const info = computeWorkerProcessInfo(
      [{ status: "completed", updatedAtMs: NOW - WORKER_LIVENESS_FRESHNESS_MS - 1 }],
      VERSION,
      NOW,
    );
    expect(info.state).toBe("stopped");
  });

  it("reports 'stopped' with an empty job list (never enqueued anything yet)", () => {
    const info = computeWorkerProcessInfo([], VERSION, NOW);
    expect(info.state).toBe("stopped");
  });

  it("picks the MOST RECENT row, not the first, when multiple rows are present", () => {
    const info = computeWorkerProcessInfo(
      [
        { status: "failed", updatedAtMs: NOW - 10_000_000 },
        { status: "completed", updatedAtMs: NOW - 1_000 },
        { status: "completed", updatedAtMs: NOW - 5_000_000 },
      ],
      VERSION,
      NOW,
    );
    expect(info.state).toBe("running");
  });

  it("always reports pid/startedAtMs as null (different process, unknowable from this data source)", () => {
    const info = computeWorkerProcessInfo([{ status: "active", updatedAtMs: NOW }], VERSION, NOW);
    expect(info.pid).toBeNull();
    expect(info.startedAtMs).toBeNull();
  });

  it("carries the provided version through unchanged", () => {
    const info = computeWorkerProcessInfo([], VERSION, NOW);
    expect(info.version).toBe(VERSION);
  });

  it("defaults `now` to Date.now() when omitted", () => {
    const info = computeWorkerProcessInfo([{ status: "active", updatedAtMs: Date.now() }], VERSION);
    expect(info.state).toBe("running");
  });
});
