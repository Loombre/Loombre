// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/relative-time.test.ts
//
// Pins the COMPACT vocabulary ("2h ago"), which is the one LD-16 (rc.6)
// names for the dashboard's job-queue mini-cards. Deliberately separate
// from lib/admin-capability-format.test.ts, which pins the VERBOSE
// vocabulary ("3 hours ago") of formatProbeAge — two different strings for
// two different surfaces, neither reshapeable into the other.

import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relative-time.js";

describe("formatRelativeTime", () => {
  const now = 1_700_100_000_000;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("< 60s -> 'just now'", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 59_000, now)).toBe("just now");
  });

  it("minutes bucket -> 'N min ago' (no pluralisation — the compact form)", () => {
    expect(formatRelativeTime(now - MIN, now)).toBe("1 min ago");
    expect(formatRelativeTime(now - 5 * MIN, now)).toBe("5 min ago");
    expect(formatRelativeTime(now - 59 * MIN, now)).toBe("59 min ago");
  });

  it("hours bucket -> 'Nh ago' — the exact string LD-16 (rc.6) specifies", () => {
    expect(formatRelativeTime(now - HOUR, now)).toBe("1h ago");
    expect(formatRelativeTime(now - 2 * HOUR, now)).toBe("2h ago");
    expect(formatRelativeTime(now - 23 * HOUR, now)).toBe("23h ago");
  });

  it("days bucket -> 'Nd ago'", () => {
    expect(formatRelativeTime(now - DAY, now)).toBe("1d ago");
    expect(formatRelativeTime(now - 10 * DAY, now)).toBe("10d ago");
  });

  it("clamps a future timestamp to 'just now' rather than a negative duration", () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe("just now");
  });
});
