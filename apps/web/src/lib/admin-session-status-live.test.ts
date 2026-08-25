// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-session-status-live.test.ts
//
// d3-e5: the pure half of the admin now-playing surfaces' live status
// patching. See admin-session-status-live.ts's header for why the payload
// carries transport facts only and what that means for what may be patched.

import { describe, expect, it } from "vitest";
import { mergeSessionStatusChange, type PlaybackSessionStatusChangedPayload } from "./admin-session-status-live.js";

interface Row {
  id: string;
  status: string;
  suspendedByThrottle?: boolean;
  heartbeatStale?: boolean;
  itemTitle: string | null;
  updatedAtMs: number;
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    status: "active",
    suspendedByThrottle: false,
    heartbeatStale: false,
    itemTitle: "Arrival",
    updatedAtMs: 0,
    ...overrides,
  };
}

function change(overrides: Partial<PlaybackSessionStatusChangedPayload> = {}): PlaybackSessionStatusChangedPayload {
  return {
    sessionId: "s1",
    previousStatus: "active",
    status: "suspended",
    suspendedByThrottle: true,
    reason: "throttle-suspend",
    changedAtMs: 1_700_000_060_000,
    ...overrides,
  };
}

describe("mergeSessionStatusChange (d3-e5)", () => {
  it("patches status and suspendedByThrottle on the matching row, in place", () => {
    const before = [row("s0"), row("s1"), row("s2")];
    const after = mergeSessionStatusChange(before, change());

    expect(after).not.toBeNull();
    expect(after!.map((r) => r.id)).toEqual(["s0", "s1", "s2"]);
    expect(after![1]).toMatchObject({ id: "s1", status: "suspended", suspendedByThrottle: true });
    expect(after![1]!.updatedAtMs).toBe(1_700_000_060_000);
  });

  it("never invents item data — everything the server redacts is left exactly as fetched", () => {
    const before = [row("s1", { itemTitle: null })];
    const after = mergeSessionStatusChange(before, change());
    expect(after![0]!.itemTitle).toBeNull();
  });

  it("leaves heartbeatStale alone — a worker transition says nothing about the client", () => {
    const before = [row("s1", { status: "suspended", suspendedByThrottle: false, heartbeatStale: true })];
    const after = mergeSessionStatusChange(before, change({ status: "active", suspendedByThrottle: false, reason: "throttle-resume" }));
    expect(after![0]).toMatchObject({ status: "active", heartbeatStale: true });
  });

  it("returns null for a session the list has never seen — the caller must refetch, not synthesize", () => {
    expect(mergeSessionStatusChange([row("s0")], change({ sessionId: "unknown" }))).toBeNull();
  });

  it("returns null when the row already says exactly this — no pointless re-render", () => {
    const before = [row("s1", { status: "suspended", suspendedByThrottle: true })];
    expect(mergeSessionStatusChange(before, change())).toBeNull();
  });

  it("does not mutate the array it was given", () => {
    const before = [row("s1")];
    mergeSessionStatusChange(before, change());
    expect(before[0]!.status).toBe("active");
  });
});
