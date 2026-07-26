// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-fallback.test.ts
//
// Pure-logic coverage only (this codebase's convention — no vi.mock; see
// e.g. playback-session.test.ts's header). `findPlayableFallback` itself is
// network-driving (POST /playback/plan) and is proven against the REAL
// engine instead, at the component level, in
// components/player/UnavailableScreen.test.tsx (constructs a real
// PlanInput mirroring the seeded 2160p file, calls `plan()` directly, and
// asserts `isPlanRefused` reads its output correctly for both a genuinely
// refused case and a genuinely playable one).

import { describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { fallbackLabel, isPlanRefused, resolutionLabel } from "./playback-fallback.js";

type MediaFileSummary = components["schemas"]["MediaFileSummary"];
type PlaybackPlan = components["schemas"]["PlaybackPlan"];

function fakeFile(overrides: Partial<MediaFileSummary> = {}): MediaFileSummary {
  return {
    id: "file-1",
    versionLabel: null,
    container: "mp4",
    width: null,
    height: null,
    sizeBytes: null,
    durationMs: null,
    ...overrides,
  };
}

describe("isPlanRefused", () => {
  it("mirrors the server's own 409 condition: transcode + empty ffmpegArgs is refused", () => {
    expect(isPlanRefused({ decision: "transcode", ffmpegArgs: [] })).toBe(true);
  });

  it("a transcode WITH real ffmpegArgs is not refused", () => {
    expect(isPlanRefused({ decision: "transcode", ffmpegArgs: ["-i", "{INPUT}"] })).toBe(false);
  });

  it("direct-play is never refused, even with empty ffmpegArgs (its normal shape)", () => {
    expect(isPlanRefused({ decision: "direct-play", ffmpegArgs: [] })).toBe(false);
  });

  it("direct-stream is never refused", () => {
    expect(isPlanRefused({ decision: "direct-stream", ffmpegArgs: [] })).toBe(false);
  });

  it("remux is never refused", () => {
    expect(isPlanRefused({ decision: "remux", ffmpegArgs: [] })).toBe(false);
  });

  const _typeCheck: PlaybackPlan["decision"][] = ["direct-play", "direct-stream", "remux", "transcode"];
  void _typeCheck;
});

describe("resolutionLabel", () => {
  it("buckets to the docs/PLAYBACK.md §7 ladder rung vocabulary", () => {
    expect(resolutionLabel(2160)).toBe("2160p");
    expect(resolutionLabel(1080)).toBe("1080p");
    expect(resolutionLabel(720)).toBe("720p");
    expect(resolutionLabel(480)).toBe("480p");
    expect(resolutionLabel(360)).toBe("360p");
  });

  it("returns null for an unprobed file (height null) — never a guessed label", () => {
    expect(resolutionLabel(null)).toBeNull();
  });
});

describe("fallbackLabel", () => {
  it("prefers the admin-set edition label when present", () => {
    expect(fallbackLabel(fakeFile({ versionLabel: "Director's Cut", height: 1080 }))).toBe("Director's Cut");
  });

  it("falls back to a resolution bucket from the file's own probed height", () => {
    expect(fallbackLabel(fakeFile({ versionLabel: null, height: 1080 }))).toBe("1080p");
  });

  it("falls back to the honest generic label when neither is known (never fabricates a resolution)", () => {
    expect(fallbackLabel(fakeFile({ versionLabel: null, height: null }))).toBe("alternate version");
  });
});
