// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-session-presence.test.ts
//
// d3-e3: the pure half of "an abandoned session must not look like a
// healthy one". The rendering halves live in StreamsPanel.test.tsx and
// app/admin/sessions/page.test.tsx.

import { describe, expect, it } from "vitest";
import { BUFFERED_AHEAD_LABEL, NO_HEARTBEAT_LABEL, countLiveSessions, describeSessionPresence } from "./admin-session-presence.js";

describe("describeSessionPresence (d3-e3)", () => {
  it("a throttle-parked transcode reads as buffered ahead and stays live — that is what a healthy stream looks like", () => {
    const presence = describeSessionPresence({ status: "suspended", suspendedByThrottle: true, heartbeatStale: false });
    expect(presence.label).toBe(BUFFERED_AHEAD_LABEL);
    expect(presence.live).toBe(true);
  });

  it("a heartbeat-suspended session reads as Suspended and stays live until the heartbeat window actually lapses", () => {
    const presence = describeSessionPresence({ status: "suspended", suspendedByThrottle: false, heartbeatStale: false });
    expect(presence.label).toBe("Suspended");
    expect(presence.live).toBe(true);
  });

  it("a heartbeat-stale session is NOT live and gets its own label, whatever the transport was doing", () => {
    for (const status of ["created", "starting", "active", "suspended", "seeking"]) {
      const presence = describeSessionPresence({ status, suspendedByThrottle: false, heartbeatStale: true });
      expect(presence.label, status).toBe(NO_HEARTBEAT_LABEL);
      expect(presence.live, status).toBe(false);
    }
  });

  it("staleness outranks the throttle cause — a parked transcode nobody is watching is still nobody watching", () => {
    const presence = describeSessionPresence({ status: "suspended", suspendedByThrottle: true, heartbeatStale: true });
    expect(presence.label).toBe(NO_HEARTBEAT_LABEL);
    expect(presence.live).toBe(false);
  });

  it("falls back to the plain status pill when an older server sends neither field", () => {
    expect(describeSessionPresence({ status: "active" })).toEqual({ label: "Active", tone: "success", live: true });
    expect(describeSessionPresence({ status: "suspended" })).toEqual({ label: "Suspended", tone: "warning", live: true });
  });

  it("counts only the live rows", () => {
    expect(
      countLiveSessions([
        { status: "active", heartbeatStale: false },
        { status: "suspended", suspendedByThrottle: true, heartbeatStale: false },
        { status: "suspended", suspendedByThrottle: false, heartbeatStale: true },
        { status: "active", heartbeatStale: true },
      ]),
    ).toBe(2);
    expect(countLiveSessions([])).toBe(0);
  });
});
