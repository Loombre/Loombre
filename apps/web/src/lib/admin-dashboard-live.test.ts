// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { pushEventLogEntry, getLibraryScanState, type LibraryScanState } from "./admin-dashboard-live.js";

describe("pushEventLogEntry", () => {
  it("prepends newest-first", () => {
    const first = pushEventLogEntry([], { id: "a", type: "item.added", tsMs: 1, actorUserId: null, payload: {} });
    const second = pushEventLogEntry(first, { id: "b", type: "scan.started", tsMs: 2, actorUserId: null, payload: {} });
    expect(second.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("caps at 50 entries, dropping the oldest", () => {
    let log: ReturnType<typeof pushEventLogEntry> = [];
    for (let i = 0; i < 60; i++) {
      log = pushEventLogEntry(log, { id: `id-${i}`, type: "item.added", tsMs: i, actorUserId: null, payload: {} });
    }
    expect(log).toHaveLength(50);
    expect(log[0]!.id).toBe("id-59");
    expect(log[log.length - 1]!.id).toBe("id-10");
  });
});

describe("getLibraryScanState", () => {
  it("returns the idle default for a library with no entry", () => {
    const map = new Map<string, LibraryScanState>();
    expect(getLibraryScanState(map, "missing-library")).toEqual({
      scanning: false,
      filesProcessed: null,
      lastSkipped: null,
    });
  });

  it("returns the live entry when present", () => {
    const map = new Map<string, LibraryScanState>([
      ["lib-1", { scanning: true, filesProcessed: 42, lastSkipped: null }],
    ]);
    expect(getLibraryScanState(map, "lib-1")).toEqual({ scanning: true, filesProcessed: 42, lastSkipped: null });
  });

  it("returns a persisted lastSkipped report (STATE.md H3) after a scan finishes", () => {
    const map = new Map<string, LibraryScanState>([
      ["lib-1", { scanning: false, filesProcessed: null, lastSkipped: { count: 3, files: ["a.wma", "b.ape"] } }],
    ]);
    expect(getLibraryScanState(map, "lib-1").lastSkipped).toEqual({ count: 3, files: ["a.wma", "b.ape"] });
  });
});
