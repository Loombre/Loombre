// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-capability-format.test.ts

import { describe, expect, it } from "vitest";
import { formatFfmpegHashPrefix, formatProbeAge } from "./admin-capability-format.js";

describe("formatProbeAge", () => {
  const now = 1_700_100_000_000;

  it("< 1 minute -> 'just now'", () => {
    expect(formatProbeAge(now - 30_000, now)).toBe("just now");
  });

  it("minutes bucket, singular vs plural", () => {
    expect(formatProbeAge(now - 60_000, now)).toBe("1 minute ago");
    expect(formatProbeAge(now - 5 * 60_000, now)).toBe("5 minutes ago");
  });

  it("hours bucket, singular vs plural", () => {
    expect(formatProbeAge(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(formatProbeAge(now - 3 * 60 * 60_000, now)).toBe("3 hours ago");
  });

  it("days bucket, singular vs plural", () => {
    expect(formatProbeAge(now - 24 * 60 * 60_000, now)).toBe("1 day ago");
    expect(formatProbeAge(now - 10 * 24 * 60 * 60_000, now)).toBe("10 days ago");
  });

  it("clamps a future/negative delta to 'just now' rather than a negative duration", () => {
    expect(formatProbeAge(now + 1000, now)).toBe("just now");
  });
});

describe("formatFfmpegHashPrefix", () => {
  it("truncates a long hash to 12 chars", () => {
    expect(formatFfmpegHashPrefix("sha256-abcdef1234567890")).toBe("sha256-abcde");
    expect(formatFfmpegHashPrefix("sha256-abcdef1234567890")).toHaveLength(12);
  });

  it("returns a short hash unchanged", () => {
    expect(formatFfmpegHashPrefix("abc123")).toBe("abc123");
  });

  it("returns an em dash for null/undefined/empty", () => {
    expect(formatFfmpegHashPrefix(null)).toBe("—");
    expect(formatFfmpegHashPrefix(undefined)).toBe("—");
    expect(formatFfmpegHashPrefix("")).toBe("—");
  });
});
