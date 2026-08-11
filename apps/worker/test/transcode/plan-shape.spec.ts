// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/plan-shape.spec.ts
//
// Pure tests for src/transcode/plan-shape.ts: parsing the stored session
// plan JSONB (incl. the required `selection` sidecar key, see that
// module's header) and the topRung-selection helper.

import { describe, expect, it } from "vitest";
import { InvalidStoredPlanError, parseStoredPlan, rungAtIndex, topRungOf } from "../../src/transcode/plan-shape.js";

function validRawPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: "transcode",
    reasons: [],
    container: "fmp4-hls",
    video: { action: "copy" },
    audio: { action: "transcode", targetCodec: "opus", targetChannels: 2, targetBitrateBps: 120000 },
    subtitle: { strategy: "none" },
    ladder: [],
    ffmpegArgs: ["-i", "{INPUT}"],
    engineVersion: "0.8.0",
    selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    ...overrides,
  };
}

describe("parseStoredPlan", () => {
  it("parses a well-formed stored plan", () => {
    const plan = parseStoredPlan(validRawPlan());
    expect(plan.decision).toBe("transcode");
    expect(plan.container).toBe("fmp4-hls");
    expect(plan.ffmpegArgs).toEqual(["-i", "{INPUT}"]);
    expect(plan.selection).toEqual({ videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null });
  });

  it("throws InvalidStoredPlanError when plan is null", () => {
    expect(() => parseStoredPlan(null)).toThrow(InvalidStoredPlanError);
  });

  it("throws when the required 'selection' sidecar key is missing (the one field beyond §5's PlaybackPlan)", () => {
    const raw = validRawPlan();
    delete raw["selection"];
    expect(() => parseStoredPlan(raw)).toThrow(/selection.*sidecar/);
  });

  it("throws when ffmpegArgs is not a string[]", () => {
    expect(() => parseStoredPlan(validRawPlan({ ffmpegArgs: [1, 2, 3] }))).toThrow(/ffmpegArgs/);
  });

  it("throws when container is missing", () => {
    expect(() => parseStoredPlan(validRawPlan({ container: undefined }))).toThrow(/container/);
  });

  it("throws when ladder is not an array", () => {
    expect(() => parseStoredPlan(validRawPlan({ ladder: "nope" }))).toThrow(/ladder/);
  });

  it("accepts an all-null selection (no tracks selected)", () => {
    const plan = parseStoredPlan(
      validRawPlan({ selection: { videoStreamIndex: null, audioStreamIndex: null, subtitleStreamIndex: null } }),
    );
    expect(plan.selection).toEqual({ videoStreamIndex: null, audioStreamIndex: null, subtitleStreamIndex: null });
  });
});

describe("topRungOf", () => {
  it("undefined for an empty ladder", () => {
    expect(topRungOf([])).toBeUndefined();
  });
  it("picks the rung with the highest videoBitrateBps", () => {
    const ladder = [
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 128_000, codec: "h264" as const },
      { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 128_000, codec: "h264" as const },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 128_000, codec: "h264" as const },
    ];
    expect(topRungOf(ladder)?.heightPx).toBe(1080);
  });
});

// Wave C2 (docs/PLAYBACK.md §9.1.4): a slot handoff spawns the SAME
// pipeline against a DIFFERENT rung, addressed by its INDEX in the stored
// plan's ladder — which is exactly what the client's `v{K}` path named.
describe("rungAtIndex", () => {
  const LADDER = [
    { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" as const },
    { heightPx: 1080, videoBitrateBps: 2_400_000, audioBitrateBps: 160_000, codec: "av1" as const },
    { heightPx: 360, videoBitrateBps: 480_000, audioBitrateBps: 160_000, codec: "av1" as const },
  ];

  it("addresses by ARRAY INDEX, not by bitrate rank — index is what v{K} names", () => {
    // Deliberately a ladder where index order and bitrate order agree, so
    // the distinction is only visible in the next test: this one just pins
    // the mapping.
    expect(rungAtIndex(LADDER, 0)).toEqual(LADDER[0]);
    expect(rungAtIndex(LADDER, 1)).toEqual(LADDER[1]);
    expect(rungAtIndex(LADDER, 2)).toEqual(LADDER[2]);
  });

  it("an UNSORTED policy table is still addressed positionally (the master lists array order)", () => {
    const unsorted = [LADDER[2]!, LADDER[0]!, LADDER[1]!];
    expect(rungAtIndex(unsorted, 0)).toEqual(LADDER[2]);
    expect(rungAtIndex(unsorted, 1)).toEqual(LADDER[0]);
  });

  it("undefined for an out-of-range or negative index, and for an empty ladder", () => {
    expect(rungAtIndex(LADDER, 3)).toBeUndefined();
    expect(rungAtIndex(LADDER, -1)).toBeUndefined();
    expect(rungAtIndex([], 0)).toBeUndefined();
  });

  it("undefined for a non-integer index (a malformed control value never picks a rung)", () => {
    expect(rungAtIndex(LADDER, 1.5)).toBeUndefined();
    expect(rungAtIndex(LADDER, Number.NaN)).toBeUndefined();
  });
});
