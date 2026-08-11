// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/rebuild-args.spec.ts
//
// Pure tests for `planShapeForRung` — the part of the restart-args rebuild
// that decides WHICH rung a respawn encodes to, and what the arg builder is
// therefore told to target. Everything else in rebuild-args.ts is db I/O
// (re-reading MediaInfo and the device profile) and is covered by the
// real-ffmpeg integration specs.
//
// This is the §9.1.4 step-3 sentence made testable: "the encoder name comes
// from the routed backend + the RUNG's codec — a mixed-codec ladder (av1
// top / hevc mid) makes this load-bearing". `buildFfmpegArgs` picks its
// encoder from `video.targetCodec`, NOT from `rung.codec`, so a handoff
// that forgot to re-point `targetCodec` would spawn the OLD rung's encoder
// against the NEW rung's bitrate and height — a plausible-looking argv that
// produces the wrong bitstream.

import { describe, expect, it } from "vitest";
import { planShapeForRung } from "../../src/transcode/rebuild-args.js";
import type { StoredPlan } from "../../src/transcode/plan-shape.js";

const MIXED_LADDER: StoredPlan["ladder"] = [
  { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
  { heightPx: 1080, videoBitrateBps: 2_400_000, audioBitrateBps: 160_000, codec: "av1" },
  { heightPx: 360, videoBitrateBps: 480_000, audioBitrateBps: 160_000, codec: "av1" },
];

function transcodePlan(overrides: Partial<StoredPlan> = {}): StoredPlan {
  return {
    decision: "transcode",
    container: "fmp4-hls",
    video: { action: "transcode", targetCodec: "hevc", encoder: "qsv" },
    audio: { action: "copy" },
    subtitle: { strategy: "none" },
    ladder: MIXED_LADDER,
    ffmpegArgs: [],
    engineVersion: "0.11.0",
    selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    ...overrides,
  };
}

describe("planShapeForRung (§9.1.4 step 3)", () => {
  it("no rung index -> the TOP rung and the plan's own targetCodec (a plain seek restart)", () => {
    const shape = planShapeForRung(transcodePlan(), undefined);
    expect(shape.rung).toEqual(MIXED_LADDER[0]);
    expect(shape.video.targetCodec).toBe("hevc");
  });

  it("a rung index -> THAT rung, and targetCodec RE-POINTED at the rung's own codec", () => {
    const shape = planShapeForRung(transcodePlan(), 1);
    expect(shape.rung).toEqual(MIXED_LADDER[1]);
    // The whole point: golden 42 pins that this shape produces `av1_qsv`.
    // Leaving targetCodec at 'hevc' would have produced `hevc_qsv` at the
    // av1 rung's bitrate — args that run, and are wrong.
    expect(shape.video.targetCodec).toBe("av1");
  });

  it("keeps the ROUTED backend — a switch changes the rung, never the hardware route", () => {
    expect(planShapeForRung(transcodePlan(), 2).video.encoder).toBe("qsv");
  });

  it("carries container/audio/subtitle through untouched (a switch is a video-rung change only)", () => {
    const plan = transcodePlan({
      audio: { action: "transcode", targetCodec: "opus", targetChannels: 2, targetBitrateBps: 120_000 },
      subtitle: { strategy: "embed", streamIndex: 2 },
    });
    const shape = planShapeForRung(plan, 1);
    expect(shape.container).toBe("fmp4-hls");
    expect(shape.audio).toEqual(plan.audio);
    expect(shape.subtitle).toEqual(plan.subtitle);
  });

  it("does NOT mutate the stored plan (the row is re-read every restart and must stay authoritative)", () => {
    const plan = transcodePlan();
    const snapshot = structuredClone(plan);
    planShapeForRung(plan, 1);
    expect(plan).toEqual(snapshot);
  });

  it("an OUT-OF-RANGE index falls back to the top rung rather than producing no rung at all", () => {
    // Defensive: the controller validates 0 <= K < ladder.length before
    // recording, so this is unreachable in practice — but a restart that
    // silently produced NO rung would hand buildFfmpegArgs an encode with
    // no bitrate or height, and a session that cannot restart is worse
    // than one that restarts at the quality it was already serving.
    const shape = planShapeForRung(transcodePlan(), 99);
    expect(shape.rung).toEqual(MIXED_LADDER[0]);
    expect(shape.video.targetCodec).toBe("hevc");
  });

  it("a video-COPY plan gets NO rung at all, whatever index is asked for", () => {
    const plan = transcodePlan({ video: { action: "copy" }, ladder: [] });
    expect(planShapeForRung(plan, 1).rung).toBeUndefined();
    expect(planShapeForRung(plan, undefined).rung).toBeUndefined();
  });

  it("a ladder-EMPTY transcode gets no rung and leaves targetCodec alone", () => {
    const plan = transcodePlan({ ladder: [] });
    const shape = planShapeForRung(plan, 0);
    expect(shape.rung).toBeUndefined();
    expect(shape.video.targetCodec).toBe("hevc");
  });
});
