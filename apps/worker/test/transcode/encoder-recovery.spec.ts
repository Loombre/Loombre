// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/transcode/encoder-recovery.spec.ts
//
// QA finding browser-player-F2 (2026-08-20/21 sweep, P1): a real 4K HDR
// session died mid-transcode with
//
//   [hevc_videotoolbox] Error encoding frame: -17691
//   ... Terminating thread with return code -542398533
//
// and the runtime marked the session `failed`/`transcode-failed` on the
// spot. OSStatus -17691 is `kVTSessionMalfunctionErr` (MacOSX.sdk
// VideoToolbox/VTErrors.h:61) — the out-of-process VideoToolbox session
// backing `hevc_videotoolbox` died; it says nothing about the input frame
// and everything about the encode SESSION, so a fresh session (and, if
// that keeps happening, a software encoder) is the correct response, not a
// terminal failure.
//
// These are the PURE halves of that recovery: the exit classifier and the
// bounded retry/fallback policy. Deliberately platform-free string/table
// logic with no process, no clock and no database, so a Linux/Windows CI
// box exercises the VideoToolbox path exactly as a Mac does. The wiring
// into the poll loop is proven separately, against a fake ffmpeg process
// and a real Postgres, in encoder-malfunction.integration.spec.ts.

import { describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "@loombre/playback-engine";
import type { DeviceProfile, MediaInfo, PlanInput, TrackSelection } from "@loombre/playback-engine";
import {
  classifyFfmpegExit,
  TRANSCODE_ERROR_CODE_ENCODER_MALFUNCTION,
  TRANSCODE_ERROR_CODE_FAILED,
} from "../../src/transcode/exit-classify.js";
import {
  MAX_ENCODER_MALFUNCTION_RETRIES,
  newEncoderRecoveryState,
  planEncoderRecovery,
  softwareFallbackAvailable,
  softwareFallbackPlan,
} from "../../src/transcode/encoder-recovery.js";
import { planShapeForRung } from "../../src/transcode/rebuild-args.js";
import type { StoredPlan } from "../../src/transcode/plan-shape.js";

/** The stderr tail as it was actually recorded on the failed session
 *  (ledger evidence for browser-player-F2), trimmed to the lines that
 *  carry the diagnosis. */
const VT_MALFUNCTION_STDERR = [
  "[hevc_videotoolbox @ 0x14a8f4e70] Error encoding frame: -17691",
  "[hevc_videotoolbox @ 0x14a8f4e70] Error submitting video frame to the encoder",
  "[vost#0:0/hevc_videotoolbox @ 0x14a8e1cc0] Error submitting a packet to the muxer: Generic error in an external library",
  "[out#0/hls @ 0x14a8e0a40] Terminating thread with return code -542398533 (Generic error in an external library)",
].join("\n");

const GENERIC_FAILURE_STDERR = [
  "[in#0 @ 0x600001b0c000] Error opening input: No such file or directory",
  "Error opening input file /nonexistent/does-not-exist.mp4.",
].join("\n");

describe("classifyFfmpegExit — the injectable, platform-free exit classifier", () => {
  it("a VideoToolbox OSStatus -17691 (kVTSessionMalfunctionErr) exit is RETRYABLE, not fatal", () => {
    const result = classifyFfmpegExit({ exitCode: 1, killedByUs: false, stderrTail: VT_MALFUNCTION_STDERR });
    expect(result.kind).toBe("encoder-malfunction");
    if (result.kind !== "encoder-malfunction") throw new Error("unreachable");
    expect(result.osStatus).toBe(-17691);
    expect(result.symbol).toBe("kVTSessionMalfunctionErr");
  });

  it("a generic non-zero exit is FATAL (no OSStatus, no recovery)", () => {
    expect(classifyFfmpegExit({ exitCode: 1, killedByUs: false, stderrTail: GENERIC_FAILURE_STDERR })).toEqual({ kind: "fatal" });
  });

  it("an exit with a null code (spawn error / signal death) and no OSStatus is FATAL", () => {
    expect(classifyFfmpegExit({ exitCode: null, killedByUs: false, stderrTail: "" })).toEqual({ kind: "fatal" });
  });

  it("our own terminate() is never a failure of any kind", () => {
    expect(classifyFfmpegExit({ exitCode: null, killedByUs: true, stderrTail: VT_MALFUNCTION_STDERR })).toEqual({ kind: "killed-by-us" });
  });

  it("a clean exit is clean", () => {
    expect(classifyFfmpegExit({ exitCode: 0, killedByUs: false, stderrTail: "" })).toEqual({ kind: "clean" });
  });

  it("the AVERROR_EXTERNAL code alone is NOT enough — the OSStatus is what identifies a dead VT session", () => {
    const stderr = "[out#0/hls @ 0x14a8e0a40] Terminating thread with return code -542398533 (Generic error in an external library)";
    expect(classifyFfmpegExit({ exitCode: 1, killedByUs: false, stderrTail: stderr })).toEqual({ kind: "fatal" });
  });

  it("an OSStatus with no VideoToolbox component in the tail is NOT claimed as a VT session death", () => {
    const stderr = "[libx265 @ 0x1] some unrelated message mentioning -17691 in passing";
    expect(classifyFfmpegExit({ exitCode: 1, killedByUs: false, stderrTail: stderr })).toEqual({ kind: "fatal" });
  });

  it("does not mistake a LONGER number containing the OSStatus digits for the OSStatus", () => {
    const stderr = "[hevc_videotoolbox @ 0x1] Error encoding frame: -176911";
    expect(classifyFfmpegExit({ exitCode: 1, killedByUs: false, stderrTail: stderr })).toEqual({ kind: "fatal" });
  });

  it("the two error codes are distinct, so the client can tell a dead encoder from a broken pipeline", () => {
    expect(TRANSCODE_ERROR_CODE_ENCODER_MALFUNCTION).not.toBe(TRANSCODE_ERROR_CODE_FAILED);
    expect(TRANSCODE_ERROR_CODE_FAILED).toBe("transcode-failed");
    expect(TRANSCODE_ERROR_CODE_ENCODER_MALFUNCTION).toBe("transcode-encoder-malfunction");
  });
});

describe("planEncoderRecovery — bounded fresh-session retries, THEN software, THEN terminal", () => {
  it("spends its hardware retries first", () => {
    const state = newEncoderRecoveryState();
    for (let attempt = 1; attempt <= MAX_ENCODER_MALFUNCTION_RETRIES; attempt += 1) {
      const action = planEncoderRecovery(state, { softwareFallbackAvailable: true });
      expect(action).toEqual({ kind: "retry-hardware", attempt });
      state.hardwareRetriesUsed = attempt;
    }
  });

  it("falls back to software once the retry budget is spent", () => {
    const state = { hardwareRetriesUsed: MAX_ENCODER_MALFUNCTION_RETRIES, softwareFallbackActive: false };
    expect(planEncoderRecovery(state, { softwareFallbackAvailable: true })).toEqual({ kind: "fall-back-to-software" });
  });

  it("gives up once software is already running (nothing left to fall back to)", () => {
    const state = { hardwareRetriesUsed: MAX_ENCODER_MALFUNCTION_RETRIES, softwareFallbackActive: true };
    expect(planEncoderRecovery(state, { softwareFallbackAvailable: false })).toEqual({ kind: "give-up" });
  });

  it("gives up immediately when the session has no hardware encoder to fall back FROM", () => {
    const state = { hardwareRetriesUsed: MAX_ENCODER_MALFUNCTION_RETRIES, softwareFallbackActive: false };
    expect(planEncoderRecovery(state, { softwareFallbackAvailable: false })).toEqual({ kind: "give-up" });
  });

  it("the budget is finite — a crash loop can never restart forever", () => {
    const state = newEncoderRecoveryState();
    let restarts = 0;
    for (;;) {
      const action = planEncoderRecovery(state, { softwareFallbackAvailable: !state.softwareFallbackActive });
      if (action.kind === "give-up") break;
      if (action.kind === "fall-back-to-software") state.softwareFallbackActive = true;
      else state.hardwareRetriesUsed = action.attempt;
      restarts += 1;
      expect(restarts).toBeLessThanOrEqual(MAX_ENCODER_MALFUNCTION_RETRIES + 1);
    }
    expect(restarts).toBe(MAX_ENCODER_MALFUNCTION_RETRIES + 1);
  });
});

// ---------------------------------------------------------------------------
// The software fallback's PLAN SHAPE, and the argv it makes the (untouched,
// pure) engine builder emit. `packages/playback-engine` is out of this
// lane's edit scope entirely — the fallback is expressed purely as a
// different PlanShape handed to the same builder.
// ---------------------------------------------------------------------------

const media: MediaInfo = {
  fileId: "11111111-1111-7111-8111-111111111111",
  container: "mkv",
  durationMs: 7_200_000,
  sizeBytes: 40_000_000_000,
  overallBitrateBps: 44_000_000,
  video: [
    {
      index: 0,
      codec: "hevc",
      profile: "main 10",
      level: 153,
      width: 3840,
      height: 2160,
      bitDepth: 10,
      frameRate: 23.976,
      bitrateBps: 40_000_000,
      hdr: "hdr10",
      dvProfile: null,
      dvBlCompatId: null,
      interlaced: false,
      openGop: false,
    },
  ],
  audio: [{ index: 1, codec: "eac3", channels: 6, sampleRate: 48000, bitrateBps: 768_000, language: "eng", isDefault: true, hasAtmos: false }],
  subtitle: [],
};

const device: DeviceProfile = {
  profileId: "encoder-recovery-device",
  directPlayContainers: ["mp4"],
  hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
  video: [{ codec: "hevc", maxProfile: "main 10", maxLevel: null, maxBitDepth: 10, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrateBps: null }],
  hdr: { hdr10: false, hlg: false, dolbyVision: false },
  audio: [{ codec: "opus", maxChannels: 6, passthrough: false }],
  subtitles: { renderText: [], hlsVtt: true, renderImage: false },
  maxStreamBitrateBps: null,
};

const selection: TrackSelection = { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null };

const planInput: PlanInput = {
  media,
  device,
  selection,
  network: { maxBitrateBps: Number.MAX_SAFE_INTEGER, isLocal: true },
  policy: {
    allowTranscode: true,
    allowToneMapCpu: "tier-gated",
    tier: 0,
    preferredTextSubMode: "hls-vtt",
    preserveAssStyling: false,
    audioTranscodeCodecPriority: ["opus", "aac"],
    maxSimultaneousTranscodes: 1,
    ladderRungs: [],
    segmentDurationSec: 6,
    hevcEncodePreferred: true,
    av1EncodePreferred: false,
  },
  caps: { backends: [] },
  mode: "stream",
};

/** The shape the failed session was actually running: a 4K HDR10 source
 *  tone-mapped and encoded to a 1080p hevc rung ON VIDEOTOOLBOX — i.e.
 *  hevc_videotoolbox with scale_vt doing the tone-map, which is exactly
 *  the pipeline whose VT session died. */
function videotoolboxPlan(): StoredPlan {
  return {
    decision: "transcode",
    container: "fmp4-hls",
    video: { action: "transcode", targetCodec: "hevc", encoder: "videotoolbox", toneMap: "videotoolbox" },
    audio: { action: "transcode", targetCodec: "opus", targetChannels: 6, targetBitrateBps: 384_000 },
    subtitle: { strategy: "none" },
    ladder: [{ heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "hevc" }],
    ffmpegArgs: [],
    engineVersion: "test",
    selection,
  };
}

describe("softwareFallbackPlan — the same session, off the hardware encoder", () => {
  it("a hardware-encoding transcode session HAS a software fallback", () => {
    expect(softwareFallbackAvailable(videotoolboxPlan())).toBe(true);
  });

  it("a session already on software has nothing left to fall back to", () => {
    const already = videotoolboxPlan();
    already.video = { ...already.video, encoder: "software", toneMap: "cpu-zscale" };
    expect(softwareFallbackAvailable(already)).toBe(false);
  });

  it("a video-COPY session has no encoder to fall back from", () => {
    const copyPlan = videotoolboxPlan();
    copyPlan.video = { action: "copy" };
    expect(softwareFallbackAvailable(copyPlan)).toBe(false);
  });

  it("swaps the encoder to software AND drops the hardware tone-map, leaving everything else alone", () => {
    const original = videotoolboxPlan();
    const fallback = softwareFallbackPlan(original);

    expect(fallback.video.encoder).toBe("software");
    // scale_vt cannot run on software frames — a fallback that kept the
    // hardware tone-map method would emit a filtergraph ffmpeg refuses.
    expect(fallback.video.toneMap).toBe("cpu-zscale");
    expect(fallback.video.targetCodec).toBe("hevc");
    expect(fallback.ladder).toEqual(original.ladder);
    expect(fallback.selection).toEqual(original.selection);
    // Non-mutating: the stored plan the row holds is a fact, not scratch space.
    expect(original.video.encoder).toBe("videotoolbox");
    expect(original.video.toneMap).toBe("videotoolbox");
  });

  it("the restart argv it produces is genuinely software: libx265, the cpu tone-map chain, and NO -hwaccel", () => {
    const args = buildFfmpegArgs(planInput, planShapeForRung(softwareFallbackPlan(videotoolboxPlan()), 0), { withSeek: true });
    const argv = args.join(" ");

    expect(argv).toContain("libx265");
    expect(argv).not.toContain("hevc_videotoolbox");
    expect(args).not.toContain("-hwaccel");
    expect(args).not.toContain("-hwaccel_output_format");
    expect(argv).not.toContain("scale_vt");
    expect(argv).toContain("zscale=t=linear");
  });

  it("for comparison, the UNCHANGED plan still emits the hardware pipeline (the happy path is untouched)", () => {
    const args = buildFfmpegArgs(planInput, planShapeForRung(videotoolboxPlan(), 0), { withSeek: true });
    const argv = args.join(" ");
    expect(argv).toContain("hevc_videotoolbox");
    expect(args).toContain("-hwaccel");
    expect(argv).toContain("scale_vt");
  });
});
