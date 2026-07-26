// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/args.spec.ts
//
// Pure tests for src/transcode/args.ts: token substitution (docs/
// PLAYBACK.md §6) + the P3.8 -readrate injection.

import { describe, expect, it } from "vitest";
import { injectReadrate, seekSecondsArg, substituteTokens } from "../../src/transcode/args.js";

describe("substituteTokens", () => {
  it("substitutes every token, including one embedded in a larger string", () => {
    const args = ["-i", "{INPUT}", "-hls_segment_filename", "{SESSION_DIR}/s%06d.m4s", "{SESSION_DIR}/media.m3u8"];
    const result = substituteTokens(args, { input: "/media/movie.mp4", runDir: "/tmp/sess/run0", segDurSec: 6, startSeg: 0 });
    expect(result).toEqual([
      "-i",
      "/media/movie.mp4",
      "-hls_segment_filename",
      "/tmp/sess/run0/s%06d.m4s",
      "/tmp/sess/run0/media.m3u8",
    ]);
  });

  it("substitutes {SEG_DUR} and {START_SEG}", () => {
    const result = substituteTokens(["-hls_time", "{SEG_DUR}", "-start_number", "{START_SEG}"], {
      input: "x",
      runDir: "y",
      segDurSec: 6,
      startSeg: 43,
    });
    expect(result).toEqual(["-hls_time", "6", "-start_number", "43"]);
  });

  it("substitutes {SEEK_SECONDS} when withSeek args + seekTargetMs are both present", () => {
    const result = substituteTokens(["-ss", "{SEEK_SECONDS}"], { input: "x", runDir: "y", segDurSec: 6, startSeg: 0, seekTargetMs: 12345 });
    expect(result).toEqual(["-ss", "12.345"]);
  });

  it("throws if args contain {SEEK_SECONDS} but no seekTargetMs was supplied", () => {
    expect(() => substituteTokens(["-ss", "{SEEK_SECONDS}"], { input: "x", runDir: "y", segDurSec: 6, startSeg: 0 })).toThrow(
      /no seekTargetMs was supplied/,
    );
  });

  it("throws if seekTargetMs is supplied but no arg contains {SEEK_SECONDS} (shape mismatch)", () => {
    expect(() => substituteTokens(["-i", "{INPUT}"], { input: "x", runDir: "y", segDurSec: 6, startSeg: 0, seekTargetMs: 1000 })).toThrow(
      /withSeek args expected/,
    );
  });

  it("args with no tokens at all pass through unchanged", () => {
    expect(substituteTokens(["-hide_banner", "-loglevel", "warning"], { input: "x", runDir: "y", segDurSec: 6, startSeg: 0 })).toEqual([
      "-hide_banner",
      "-loglevel",
      "warning",
    ]);
  });
});

describe("seekSecondsArg", () => {
  it("whole seconds render without a decimal point", () => {
    expect(seekSecondsArg(60_000)).toBe("60");
  });
  it("millisecond precision is preserved", () => {
    expect(seekSecondsArg(12_345)).toBe("12.345");
  });
  it("kills floating-point noise", () => {
    expect(seekSecondsArg(1)).toBe("0.001");
  });
});

describe("injectReadrate", () => {
  it("inserts -readrate immediately after the fixed 4-element global segment", () => {
    const args = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-i", "{INPUT}"];
    const result = injectReadrate(args, 1.2);
    expect(result).toEqual(["-hide_banner", "-loglevel", "warning", "-nostdin", "-readrate", "1.2", "-i", "{INPUT}"]);
  });

  it("does not mutate the input array", () => {
    const args = ["-hide_banner", "-loglevel", "warning", "-nostdin"];
    const copy = [...args];
    injectReadrate(args, 6);
    expect(args).toEqual(copy);
  });
});
