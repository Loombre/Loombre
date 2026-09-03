// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/plan.ts — the pipeline skeleton + Stage A assembly
 * (Phase 3 Step 2a). Lives in the package's NORMAL (non-matrix) test
 * project (vitest.config.ts's `include` covers `test/**\/*.spec.ts`),
 * separate from matrix/'s case-file burn-up.
 *
 * Covers (per this step's instructions): the B-E-copy re-evaluation
 * contract at the stub level (container mismatch alone never escalates
 * past direct-stream, because Stages B-F's stubs always contribute
 * 'direct-play'), download-mode remux vs stream-mode direct-stream on the
 * SAME input, and the rest of the §5 output-assembly contract this step
 * owns: container field mapping, video/audio action assembly,
 * subtitle-strategy stub behavior, ladder/ffmpegArgs empty-until-later,
 * and engineVersion.
 */
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, plan } from "../src/plan.js";
import type { DeviceProfile, MediaInfo, PlanInput } from "../src/types.js";

function makeDevice(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    profileId: "test-device",
    directPlayContainers: ["mp4", "webm"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "h264",
        maxProfile: "high",
        maxLevel: 41,
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
        maxBitrateBps: null,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    fileId: "file-1",
    container: "mp4",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: 8_000_000,
    video: [
      {
        index: 0,
        codec: "h264",
        profile: "high",
        level: 41,
        width: 1920,
        height: 1080,
        bitDepth: 8,
        frameRate: 23.976,
        bitrateBps: 5_000_000,
        hdr: "none",
        dvProfile: null,
        dvBlCompatId: null,
        interlaced: false,
        openGop: false,
      },
    ],
    audio: [
      {
        index: 1,
        codec: "aac",
        channels: 2,
        sampleRate: 48000,
        bitrateBps: 160_000,
        language: "eng",
        isDefault: true,
        hasAtmos: false,
      },
    ],
    subtitle: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    media: makeMedia(),
    device: makeDevice(),
    network: { maxBitrateBps: 100_000_000, isLocal: true },
    policy: {
      allowTranscode: true,
      allowToneMapCpu: "tier-gated",
      tier: 0,
      preferredTextSubMode: "hls-vtt",
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"],
      maxSimultaneousTranscodes: 1,
      ladderRungs: [],
      segmentDurationSec: 2,
      hevcEncodePreferred: false,
      av1EncodePreferred: false,
    },
    caps: { backends: [{ backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1_750_000_000_000 }] },
    selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    mode: "stream",
    ...overrides,
  };
}

describe("plan(): direct-play baseline", () => {
  it("container in list + all stub stages copy -> direct-play, reasons [], container 'source'", () => {
    const result = plan(makeInput());
    expect(result.decision).toBe("direct-play");
    expect(result.reasons).toEqual([]);
    expect(result.container).toBe("source");
    expect(result.video.action).toBe("copy");
    expect(result.audio.action).toBe("copy");
    expect(result.subtitle).toEqual({ strategy: "none" });
    expect(result.ladder).toEqual([]);
    expect(result.ffmpegArgs).toEqual([]);
    expect(result.engineVersion).toBe(ENGINE_VERSION);
  });
});

describe("plan(): B-F-copy re-evaluation contract (stub level)", () => {
  it("container mismatch ALONE never escalates past direct-stream — Stages B-F's stubs always contribute 'direct-play' severity", () => {
    const input = makeInput({ media: makeMedia({ container: "mkv" }) });
    const result = plan(input);
    expect(result.decision).toBe("direct-stream");
    expect(result.reasons).toEqual([{ code: "container-not-direct-playable", detail: "container=mkv" }]);
  });

  it("container match -> Stage A alone cannot push past direct-play even though B-F ran", () => {
    const result = plan(makeInput());
    expect(result.decision).toBe("direct-play");
  });
});

describe("plan(): mode=download remux vs mode=stream direct-stream (same input, only `mode` differs)", () => {
  const mismatchedContainerInput = makeInput({ media: makeMedia({ container: "mkv" }) });

  it("mode=stream -> direct-stream", () => {
    const result = plan({ ...mismatchedContainerInput, mode: "stream" });
    expect(result.decision).toBe("direct-stream");
    expect(result.container).toBe("fmp4-hls");
  });

  it("mode=download -> remux (container-only change)", () => {
    const result = plan({ ...mismatchedContainerInput, mode: "download" });
    expect(result.decision).toBe("remux");
    expect(result.container).toBe("mp4");
    expect(result.reasons).toEqual([{ code: "container-not-direct-playable", detail: "container=mkv" }]);
  });

  it("mode=download does NOT force remux when the container already direct-plays", () => {
    const result = plan(makeInput({ mode: "download" }));
    expect(result.decision).toBe("direct-play");
  });

  it("mode=download: an INFORMATIONAL reason (dv-stripped-to-hdr10) does not block the container-only-change remux (ENGINE_VERSION 0.3.1 rule)", () => {
    // Seed case 010's scenario (mkv + dv8.1 compat-BL + hdr10-capable
    // device) in download mode — the blocking set is exactly
    // {container-not-direct-playable}; the informational strip reason is
    // ignored by the container-only-change predicate (§4 class split:
    // blocking forces severity, informational never does). Pinned by matrix
    // case 205 too.
    const media = makeMedia({ container: "mkv" });
    media.video[0]!.hdr = "dv";
    media.video[0]!.dvProfile = 8;
    media.video[0]!.dvBlCompatId = 1;
    const device = makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } });
    const result = plan(makeInput({ media, device, mode: "download" }));
    expect(result.decision).toBe("remux");
    expect(result.container).toBe("mp4");
    expect(result.reasons.map((r) => r.code)).toEqual([
      "container-not-direct-playable",
      "dv-stripped-to-hdr10",
    ]);
    expect(result.video.action).toBe("copy");
  });

  it("mode=download: a BLOCKING non-container reason (tone-map required) blocks remux — decision stays transcode", () => {
    const media = makeMedia({ container: "mkv" });
    media.video[0]!.hdr = "hdr10";
    // Device: SDR-only (hdr10 false in makeDevice's default) but codec-capable.
    const result = plan(makeInput({ media, mode: "download" }));
    expect(result.decision).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toContain("hdr-tone-map-required");
  });
});

describe("plan(): container field mapping (§5)", () => {
  it("direct-stream + device.hls.supportsFmp4 true -> 'fmp4-hls'", () => {
    const input = makeInput({
      media: makeMedia({ container: "mkv" }),
      device: makeDevice({ hls: { container: "fmp4", supportsFmp4: true, lowLatency: false } }),
    });
    expect(plan(input).container).toBe("fmp4-hls");
  });

  it("direct-stream + device.hls.supportsFmp4 false -> 'ts-hls'", () => {
    const input = makeInput({
      media: makeMedia({ container: "mkv" }),
      device: makeDevice({ hls: { container: "ts", supportsFmp4: false, lowLatency: false } }),
    });
    expect(plan(input).container).toBe("ts-hls");
  });
});

describe("plan(): video/audio action assembly (§5 architecture requirement 3)", () => {
  it("selection index null -> action 'none' even though a stream exists", () => {
    const input = makeInput({ selection: { videoStreamIndex: null, audioStreamIndex: 1, subtitleStreamIndex: null } });
    const result = plan(input);
    expect(result.video.action).toBe("none");
    expect(result.audio.action).toBe("copy");
  });

  it("empty stream list -> action 'none' (music mode, no video)", () => {
    const input = makeInput({
      media: makeMedia({ container: "flac", video: [], audio: [{ index: 0, codec: "flac", channels: 2, sampleRate: 44100, bitrateBps: 900_000, language: "eng", isDefault: true, hasAtmos: false }] }),
      device: makeDevice({ directPlayContainers: ["flac"], video: [], audio: [{ codec: "flac", maxChannels: 2, passthrough: false }] }),
      selection: { videoStreamIndex: null, audioStreamIndex: 0, subtitleStreamIndex: null },
    });
    const result = plan(input);
    expect(result.video.action).toBe("none");
    expect(result.audio.action).toBe("copy");
  });
});

describe("plan(): video.openGop assembly (§5, 2026-08-10)", () => {
  const hevcOpenGopStream = {
    index: 0,
    codec: "hevc" as const,
    profile: "main10",
    level: 153,
    width: 1920,
    height: 1080,
    bitDepth: 10,
    frameRate: 23.976,
    bitrateBps: 5_000_000,
    hdr: "none" as const,
    dvProfile: null,
    dvBlCompatId: null,
    interlaced: false,
    openGop: true,
  };
  const hevcDeviceEntry = {
    codec: "hevc" as const,
    maxProfile: "main10",
    maxLevel: 153,
    maxBitDepth: 10,
    maxWidth: 3840,
    maxHeight: 2160,
    maxFrameRate: 60,
    maxBitrateBps: null,
  };

  it("action 'copy' + repackaged container (direct-stream) + hevc openGop:true -> video.openGop true, open-gop-leading-pictures-stripped fires", () => {
    const input = makeInput({
      media: makeMedia({ container: "mkv", video: [hevcOpenGopStream] }),
      device: makeDevice({ video: [hevcDeviceEntry] }),
    });
    const result = plan(input);
    expect(result.decision).toBe("direct-stream");
    expect(result.video.action).toBe("copy");
    expect(result.video.openGop).toBe(true);
    expect(result.reasons).toEqual([
      { code: "container-not-direct-playable", detail: "container=mkv" },
      { code: "open-gop-leading-pictures-stripped", streamIndex: 0 },
    ]);
  });

  it("action 'copy' + direct-play (container 'source') + hevc openGop:true -> video.openGop unset, no reason (nothing was repackaged)", () => {
    const input = makeInput({
      media: makeMedia({ container: "mp4", video: [hevcOpenGopStream] }),
      device: makeDevice({ video: [hevcDeviceEntry], directPlayContainers: ["mp4", "webm"] }),
    });
    const result = plan(input);
    expect(result.decision).toBe("direct-play");
    expect(result.video.action).toBe("copy");
    expect(result.video.openGop).toBeUndefined();
    expect(result.reasons).toEqual([]);
  });

  it("action 'transcode' (interlaced) + hevc openGop:true -> video.openGop unset, no strip reason (action isn't 'copy')", () => {
    const stream = { ...hevcOpenGopStream, interlaced: true };
    const input = makeInput({
      media: makeMedia({ container: "mkv", video: [stream] }),
      device: makeDevice({ video: [hevcDeviceEntry] }),
    });
    const result = plan(input);
    expect(result.video.action).toBe("transcode");
    expect(result.video.openGop).toBeUndefined();
    expect(result.reasons.some((r) => r.code === "open-gop-leading-pictures-stripped")).toBe(false);
  });

  it("action 'copy' + repackaged container + openGop:false -> video.openGop unset, no reason (the conservative default)", () => {
    const stream = { ...hevcOpenGopStream, openGop: false };
    const input = makeInput({
      media: makeMedia({ container: "mkv", video: [stream] }),
      device: makeDevice({ video: [hevcDeviceEntry] }),
    });
    const result = plan(input);
    expect(result.video.action).toBe("copy");
    expect(result.video.openGop).toBeUndefined();
    expect(result.reasons.some((r) => r.code === "open-gop-leading-pictures-stripped")).toBe(false);
  });

  // Opus-review Finding C (2026-08-10): the assembly's hevc codec gate. A
  // non-hevc stream with a stray `openGop:true` fact (defensive-only per
  // types.ts's VideoStream.openGop doc — DB NULL collapses to false, so a
  // real h264 row would never actually reach this) must never get the flag
  // or the reason: the bsf this flag drives strips HEVC NAL types 8/9,
  // which mean something else entirely on h264 (NAL 8 is PPS).
  it("h264 stream + openGop:true + repackaged container -> video.openGop unset, no reason, no bsf in ffmpegArgs", () => {
    const input = makeInput({
      media: makeMedia({ container: "mkv", video: [{ ...makeMedia().video[0]!, openGop: true }] }),
    });
    const result = plan(input);
    expect(result.decision).toBe("direct-stream");
    expect(result.video.action).toBe("copy");
    expect(result.video.openGop).toBeUndefined();
    expect(result.reasons).toEqual([{ code: "container-not-direct-playable", detail: "container=mkv" }]);
    expect(result.ffmpegArgs).not.toContain("filter_units=remove_types=8-9");
  });
});

describe("plan(): Stage E subtitle assembly (§5 architecture requirement 3/9, Phase 3 Step 2e)", () => {
  it("no subtitle selected -> strategy 'none', no streamIndex", () => {
    const result = plan(makeInput());
    expect(result.subtitle).toEqual({ strategy: "none" });
  });

  it("IMAGE subtitle (pgs) selected, device.renderImage false -> 'burn-in', FORCES video.action to 'transcode' and decision to 'transcode' even though Stage B alone would have copied", () => {
    const input = makeInput({
      media: makeMedia({
        subtitle: [{ index: 2, codec: "pgs", language: "eng", isForced: false, isDefault: false, isExternal: false, externalPath: null }],
      }),
      selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 },
    });
    const result = plan(input);
    expect(result.subtitle).toEqual({ strategy: "burn-in", streamIndex: 2 });
    expect(result.video.action).toBe("transcode");
    expect(result.decision).toBe("transcode");
    // why (Phase 3 §11 step 3, Stage G arrival): this scenario's caps
    // (makeInput's default) declares only a `software` backend -> Stage G's
    // full-software route always fires `software-fallback:encode`. NO
    // `tier-capped` here: `makeInput()`'s default policy has `ladderRungs:
    // []`, so Stage F's `buildLadder` returns an empty ladder before Stage G
    // ever runs — there is nothing for the tier cap to remove.
    expect(result.reasons.map((r) => r.code)).toEqual([
      "subtitle-format-requires-burn-in",
      "video-transcode-for-subtitle-burn-in",
      "software-fallback:encode",
    ]);
  });

  it("TEXT subtitle (webvtt) selected, device.hlsVtt true + policy hls-vtt -> 'hls-vtt', never forces video work", () => {
    const input = makeInput({
      media: makeMedia({
        subtitle: [{ index: 2, codec: "webvtt", language: "eng", isForced: false, isDefault: false, isExternal: false, externalPath: null }],
      }),
      selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 },
    });
    const result = plan(input);
    expect(result.subtitle).toEqual({ strategy: "hls-vtt", streamIndex: 2 });
    expect(result.video.action).toBe("copy");
    expect(result.decision).toBe("direct-play");
    expect(result.reasons).toEqual([]);
  });
});

describe("plan(): totality (docs/PLAYBACK.md §10 property 3, spot-checked here)", () => {
  it("never throws on a degenerate input (no video, no audio, no subtitle, empty caps/device arrays)", () => {
    const input = makeInput({
      media: makeMedia({ video: [], audio: [], subtitle: [] }),
      device: makeDevice({ directPlayContainers: [], video: [], audio: [] }),
      caps: { backends: [] },
      selection: { videoStreamIndex: null, audioStreamIndex: null, subtitleStreamIndex: null },
    });
    let result;
    expect(() => {
      result = plan(input);
    }).not.toThrow();
    expect(result!.decision).toBe("direct-stream");
    expect(result!.video.action).toBe("none");
    expect(result!.audio.action).toBe("none");
  });

  it("is deterministic: identical inputs (structurally cloned) produce a deep-equal plan", () => {
    const input = makeInput();
    const first = plan(structuredClone(input));
    const second = plan(structuredClone(input));
    expect(second).toEqual(first);
  });
});

describe("plan(): engineVersion", () => {
  it("stamps the exported ENGINE_VERSION constant, a valid semver string", () => {
    expect(plan(makeInput()).engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("Wave C2 bumps the ruleset to 0.11.0 — a NEW decision rule (§7.5 step (h)) + a new reason code, so MINOR", () => {
    // Wave C1 (LD-7) landed 0.10.0 (AV1 ladder targeting) and its review
    // finding-1 follow-up 0.10.1 (a narrowing of an existing rule, PATCH).
    // Wave C2 adds §7.5's Tier-0 advertised-variant cap: a genuinely new
    // decision rule with a new emittable reason code, changing the stored
    // `ladder` for a whole class of Tier-0 plans — MINOR, by the same
    // policy that made 0.10.0 minor and 0.10.1 patch.
    expect(ENGINE_VERSION).toBe("0.11.0");
  });
});

describe("plan(): Stage F / ladder assembly (docs/PLAYBACK.md §3/§7, Phase 3 Step 2f)", () => {
  const DEFAULT_LADDER = [
    { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" as const },
    { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" as const },
    { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" as const },
    { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" as const },
    { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" as const },
    { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" as const },
  ];

  function makeLadderPolicy() {
    return {
      allowTranscode: true,
      allowToneMapCpu: "tier-gated" as const,
      tier: 0 as const,
      preferredTextSubMode: "hls-vtt" as const,
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"] as const,
      maxSimultaneousTranscodes: 1,
      ladderRungs: DEFAULT_LADDER,
      segmentDurationSec: 2 as const,
      hevcEncodePreferred: false,
      av1EncodePreferred: false,
    };
  }

  describe("ladder presence/absence matrix", () => {
    it("video-transcode decision (Stage F itself firing) -> ladder is non-empty and capped by the network", () => {
      const input = makeInput({
        media: makeMedia({ overallBitrateBps: 40_000_000 }),
        network: { maxBitrateBps: 4_000_000, isLocal: false },
        policy: makeLadderPolicy(),
      });
      const result = plan(input);
      expect(result.decision).toBe("transcode");
      // why (Phase 3 §11 step 3, Stage G arrival): this input's `caps`
      // (makeInput's default) declares only a `software` backend, so Stage G
      // always routes full-software (`software-fallback:encode`); tier 0
      // (makeLadderPolicy) + a 1080p source (makeMedia's default height)
      // additionally trips the tier cap (the Stage-F-built ladder still
      // carries a 1080p/4M rung above the 480p ceiling), appending
      // `software-fallback:tier-capped`. The ladder assertions below are
      // UNCHANGED and still hold against the tier-capped (smaller) ladder.
      expect(result.reasons.map((r) => r.code)).toEqual([
        "bitrate-exceeds-network",
        "software-fallback:encode",
        "software-fallback:tier-capped",
      ]);
      expect(result.video.action).toBe("transcode");
      expect(result.ladder.length).toBeGreaterThan(0);
      expect(result.ladder.every((r) => r.videoBitrateBps <= 4_000_000)).toBe(true);
    });

    it("video-transcode decision driven by Stage B (codec unsupported) -> ladder still built, Stage F contributes no reason", () => {
      const media = makeMedia({ video: [{ index: 0, codec: "hevc", profile: "main10", level: 153, width: 1920, height: 1080, bitDepth: 8, frameRate: 23.976, bitrateBps: 5_000_000, hdr: "none", dvProfile: null, dvBlCompatId: null, interlaced: false, openGop: false }] });
      const input = makeInput({
        media,
        network: { maxBitrateBps: 3_000_000, isLocal: false },
        policy: makeLadderPolicy(),
      });
      const result = plan(input);
      expect(result.decision).toBe("transcode");
      // why (Phase 3 §11 step 3, Stage G arrival): same reasoning as the
      // test immediately above — software-only caps + tier 0 + 1080p source
      // -> full-software route, tier-capped (the surviving ladder still had
      // a 720p rung above 480p before the cap).
      expect(result.reasons.map((r) => r.code)).toEqual([
        "video-codec-unsupported",
        "software-fallback:encode",
        "software-fallback:tier-capped",
      ]);
      expect(result.video.action).toBe("transcode");
      expect(result.ladder.length).toBeGreaterThan(0);
      expect(result.ladder.every((r) => r.videoBitrateBps <= 3_000_000)).toBe(true);
    });

    it("audio-only transcode (video stays copy) -> ladder [] (§5: may be empty for copy/audio-only decisions)", () => {
      const media = makeMedia({
        audio: [{ index: 1, codec: "truehd", channels: 6, sampleRate: 48000, bitrateBps: 2_000_000, language: "eng", isDefault: true, hasAtmos: false }],
      });
      const device = makeDevice({ audio: [{ codec: "truehd", maxChannels: 8, passthrough: false }] });
      const input = makeInput({ media, device, policy: makeLadderPolicy() });
      const result = plan(input);
      expect(result.decision).toBe("transcode");
      expect(result.reasons.map((r) => r.code)).toEqual(["audio-passthrough-unsupported"]);
      expect(result.video.action).toBe("copy");
      expect(result.ladder).toEqual([]);
    });

    it("copy decision (direct-play, no escalation anywhere) -> ladder []", () => {
      const result = plan(makeInput({ policy: makeLadderPolicy() }));
      expect(result.decision).toBe("direct-play");
      expect(result.video.action).toBe("copy");
      expect(result.ladder).toEqual([]);
    });

    it("refused (tone-map-refused-by-policy) -> ladder [] even with a real non-empty ladderRungs table", () => {
      const media = makeMedia();
      media.video[0]!.hdr = "hdr10";
      const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
      const caps = { backends: [{ backend: "software" as const, decode: ["h264" as const], encode: ["h264" as const], toneMap: [], verifiedAtMs: 1 }] };
      const input = makeInput({ media, device, caps, policy: makeLadderPolicy() });
      const result = plan(input);
      expect(result.decision).toBe("transcode");
      expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);
      expect(result.ladder).toEqual([]);
    });

    it("music (no video streams at all) -> video.action 'none', ladder [] regardless of an audio transcode", () => {
      const media = makeMedia({
        container: "flac",
        video: [],
        audio: [{ index: 0, codec: "flac", channels: 6, sampleRate: 44100, bitrateBps: 2_000_000, language: "eng", isDefault: true, hasAtmos: false }],
      });
      const device = makeDevice({ directPlayContainers: ["flac"], video: [], audio: [{ codec: "flac", maxChannels: 2, passthrough: false }] });
      const input = makeInput({
        media,
        device,
        selection: { videoStreamIndex: null, audioStreamIndex: 0, subtitleStreamIndex: null },
        policy: makeLadderPolicy(),
      });
      const result = plan(input);
      expect(result.video.action).toBe("none");
      expect(result.ladder).toEqual([]);
    });
  });

  describe("bitrate-exceeds-network is blocking-class -> blocks download-remux", () => {
    it("mode=download + an otherwise container-only change ALSO exceeding the network cap -> decision stays transcode, not remux", () => {
      const input = makeInput({
        media: makeMedia({ container: "mkv", overallBitrateBps: 40_000_000 }),
        network: { maxBitrateBps: 4_000_000, isLocal: false },
        policy: makeLadderPolicy(),
        mode: "download",
      });
      const result = plan(input);
      expect(result.decision).toBe("transcode");
      // why (Phase 3 §11 step 3, Stage G arrival): software-only caps + tier
      // 0 + 1080p source (same reasoning as the ladder-assembly describe
      // block above) -> full-software route, tier-capped.
      expect(result.reasons.map((r) => r.code)).toEqual([
        "container-not-direct-playable",
        "bitrate-exceeds-network",
        "software-fallback:encode",
        "software-fallback:tier-capped",
      ]);
      expect(result.ladder.length).toBeGreaterThan(0);
    });

    it("control: the SAME container-only change WITHOUT the bitrate reason still remuxes (mode=download)", () => {
      const input = makeInput({
        media: makeMedia({ container: "mkv" }), // overallBitrateBps stays at makeMedia's default (8M) < network cap
        policy: makeLadderPolicy(),
        mode: "download",
      });
      const result = plan(input);
      expect(result.decision).toBe("remux");
      expect(result.reasons.map((r) => r.code)).toEqual(["container-not-direct-playable"]);
    });
  });
});

describe("plan(): Stage G / hardware routing assembly (docs/PLAYBACK.md §3/§8.3, Phase 3 §11 step 3)", () => {
  const FULL_HW_CAPS = {
    backends: [
      { backend: "nvenc" as const, decode: ["h264" as const], encode: ["h264" as const], toneMap: ["cuda" as const], verifiedAtMs: 1 },
      { backend: "software" as const, decode: ["h264" as const], encode: ["h264" as const], toneMap: [], verifiedAtMs: 1 },
    ],
  };
  const SOFTWARE_ONLY_CAPS = {
    backends: [{ backend: "software" as const, decode: ["h264" as const], encode: ["h264" as const], toneMap: [], verifiedAtMs: 1 }],
  };

  it("hw route: video.encoder/targetCodec set, toneMap stays unset when no tone-map is needed", () => {
    const input = makeInput({
      media: makeMedia({ overallBitrateBps: 40_000_000 }),
      network: { maxBitrateBps: 4_000_000, isLocal: false },
      policy: {
        allowTranscode: true,
        allowToneMapCpu: "tier-gated",
        tier: 1, // avoid the tier-cap so the ladder assertion below is simple
        preferredTextSubMode: "hls-vtt",
        preserveAssStyling: false,
        audioTranscodeCodecPriority: ["opus", "aac"],
        maxSimultaneousTranscodes: 1,
        ladderRungs: [
          { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
          { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
        ],
        segmentDurationSec: 2,
        hevcEncodePreferred: false,
        av1EncodePreferred: false,
      },
      caps: FULL_HW_CAPS,
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["bitrate-exceeds-network", "hw-encoder-selected:nvenc"]);
    expect(result.video.encoder).toBe("nvenc");
    expect(result.video.toneMap).toBeUndefined();
    // targetCodec = the TOP surviving rung's codec (highest videoBitrateBps).
    expect(result.video.targetCodec).toBe("h264");
  });

  it("software route: video.encoder='software', targetCodec set from the top surviving rung, no toneMap (not required)", () => {
    const input = makeInput({
      media: makeMedia({ overallBitrateBps: 40_000_000 }),
      network: { maxBitrateBps: 4_000_000, isLocal: false },
      policy: {
        allowTranscode: true,
        allowToneMapCpu: "tier-gated",
        tier: 1,
        preferredTextSubMode: "hls-vtt",
        preserveAssStyling: false,
        audioTranscodeCodecPriority: ["opus", "aac"],
        maxSimultaneousTranscodes: 1,
        ladderRungs: [{ heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" }],
        segmentDurationSec: 2,
        hevcEncodePreferred: false,
        av1EncodePreferred: false,
      },
      caps: SOFTWARE_ONLY_CAPS,
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["bitrate-exceeds-network", "software-fallback:encode"]);
    expect(result.video.encoder).toBe("software");
    expect(result.video.toneMap).toBeUndefined();
    expect(result.video.targetCodec).toBe("h264");
  });

  it("software route + tone-map required + policy allows CPU tone-map -> video.toneMap='cpu-zscale'", () => {
    const media = makeMedia();
    media.video[0]!.hdr = "hdr10";
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    const input = makeInput({
      media,
      device,
      policy: {
        allowTranscode: true,
        allowToneMapCpu: "always",
        tier: 0,
        preferredTextSubMode: "hls-vtt",
        preserveAssStyling: false,
        audioTranscodeCodecPriority: ["opus", "aac"],
        maxSimultaneousTranscodes: 1,
        ladderRungs: [{ heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" }],
        segmentDurationSec: 2,
        hevcEncodePreferred: false,
        av1EncodePreferred: false,
      },
      caps: SOFTWARE_ONLY_CAPS,
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "software-fallback:encode"]);
    expect(result.video.encoder).toBe("software");
    expect(result.video.toneMap).toBe("cpu-zscale");
  });

  it("refused plan: video.encoder/targetCodec/toneMap ALL stay unset (Stage G never runs), ladder stays []", () => {
    const media = makeMedia();
    media.video[0]!.hdr = "hdr10";
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    const input = makeInput({ media, device }); // default policy: tier-gated @ tier 0 -> refuses; default caps: software w/ no toneMap
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);
    expect(result.video.encoder).toBeUndefined();
    expect(result.video.targetCodec).toBeUndefined();
    expect(result.video.toneMap).toBeUndefined();
    expect(result.ladder).toEqual([]);
  });

  it("Stage G silent on direct-play: no encoder/targetCodec/toneMap even with hw caps attached", () => {
    const result = plan(makeInput({ caps: FULL_HW_CAPS }));
    expect(result.decision).toBe("direct-play");
    expect(result.video.action).toBe("copy");
    expect(result.video.encoder).toBeUndefined();
    expect(result.reasons).toEqual([]);
  });

  it("Stage G silent on an audio-only transcode: video.action stays 'copy', no encoder set even with hw caps attached", () => {
    const media = makeMedia({
      audio: [{ index: 1, codec: "truehd", channels: 6, sampleRate: 48000, bitrateBps: 1_500_000, language: "eng", isDefault: true, hasAtmos: false }],
    });
    const device = makeDevice({ audio: [{ codec: "truehd", maxChannels: 8, passthrough: false }] });
    const result = plan(makeInput({ media, device, caps: FULL_HW_CAPS }));
    expect(result.decision).toBe("transcode");
    expect(result.video.action).toBe("copy");
    expect(result.video.encoder).toBeUndefined();
    expect(result.reasons.map((r) => r.code)).toEqual(["audio-passthrough-unsupported"]);
  });

  it("Stage G silent on a container-only direct-stream: no encoder set even with hw caps attached", () => {
    const result = plan(makeInput({ media: makeMedia({ container: "mkv" }), caps: FULL_HW_CAPS }));
    expect(result.decision).toBe("direct-stream");
    expect(result.video.action).toBe("copy");
    expect(result.video.encoder).toBeUndefined();
  });

  it("tier-cap assembly: reasons + ladder narrowing land in the SAME plan() call, in stage order", () => {
    const input = makeInput({
      media: makeMedia({ overallBitrateBps: 40_000_000 }),
      network: { maxBitrateBps: 4_000_000, isLocal: false },
      policy: {
        allowTranscode: true,
        allowToneMapCpu: "tier-gated",
        tier: 0,
        preferredTextSubMode: "hls-vtt",
        preserveAssStyling: false,
        audioTranscodeCodecPriority: ["opus", "aac"],
        maxSimultaneousTranscodes: 1,
        ladderRungs: [
          { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
          { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
          { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
        ],
        segmentDurationSec: 2,
        hevcEncodePreferred: false,
        av1EncodePreferred: false,
      },
      caps: SOFTWARE_ONLY_CAPS,
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual([
      "bitrate-exceeds-network",
      "software-fallback:encode",
      "software-fallback:tier-capped",
    ]);
    expect(result.ladder).toEqual([
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
    expect(result.video.targetCodec).toBe("h264");
    expect(result.video.encoder).toBe("software");
  });
});

describe("plan(): transcode-disabled-by-policy (step 7b fix F1 — docs/PLAYBACK.md §2.4/§4/§10)", () => {
  const REAL_LADDER = [
    { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" as const },
    { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" as const },
  ];

  function disabledPolicy(overrides: Partial<PlanInput["policy"]> = {}): PlanInput["policy"] {
    return {
      allowTranscode: false,
      allowToneMapCpu: "tier-gated",
      tier: 0,
      preferredTextSubMode: "hls-vtt",
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"],
      maxSimultaneousTranscodes: 1,
      ladderRungs: REAL_LADDER,
      segmentDurationSec: 2,
      hevcEncodePreferred: false,
      av1EncodePreferred: false,
      ...overrides,
    };
  }

  it("video-driven transcode: decision stays 'transcode', reason appended LAST, refused-style empty outputs (encoder/targetCodec/toneMap unset, ladder [], ffmpegArgs [])", () => {
    const media = makeMedia();
    media.video[0]!.interlaced = true; // Stage B: video-interlaced -> transcode
    const result = plan(makeInput({ media, policy: disabledPolicy() }));
    expect(result.decision).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toEqual(["video-interlaced", "transcode-disabled-by-policy"]);
    expect(result.video.action).toBe("transcode");
    expect(result.video.encoder).toBeUndefined();
    expect(result.video.targetCodec).toBeUndefined();
    expect(result.video.toneMap).toBeUndefined();
    expect(result.ladder).toEqual([]);
    expect(result.ffmpegArgs).toEqual([]);
  });

  it("audio-only transcode: the disabled verdict applies to audio transcoding too — audio target* fields are STRIPPED (action stays 'transcode'), ffmpegArgs []", () => {
    const media = makeMedia({
      audio: [{ index: 1, codec: "vorbis", channels: 2, sampleRate: 48000, bitrateBps: 160_000, language: "eng", isDefault: true, hasAtmos: false }],
    });
    const result = plan(makeInput({ media, policy: disabledPolicy() }));
    expect(result.decision).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toEqual(["audio-codec-unsupported", "transcode-disabled-by-policy"]);
    expect(result.video.action).toBe("copy");
    expect(result.audio).toEqual({ action: "transcode" }); // no targetCodec/targetChannels/targetBitrateBps
    expect(result.ladder).toEqual([]);
    expect(result.ffmpegArgs).toEqual([]);
  });

  it("BIND: refusal interaction is moot — a would-be tone-map-refused scenario under transcode-disabled appends ONLY transcode-disabled-by-policy (Stage G never evaluates)", () => {
    const media = makeMedia();
    media.video[0]!.hdr = "hdr10"; // device HDR flags are all false -> tone-map required
    const result = plan(makeInput({ media, policy: disabledPolicy() })); // tier-gated @ 0 WOULD refuse
    expect(result.decision).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "transcode-disabled-by-policy"]);
    expect(result.reasons.some((r) => r.code === "tone-map-refused-by-policy")).toBe(false);
    expect(result.ladder).toEqual([]);
    expect(result.ffmpegArgs).toEqual([]);
  });

  it("BOUNDARY: repackaging is not transcoding — direct-stream (copy-only HLS) is unaffected and keeps REAL ffmpegArgs", () => {
    const result = plan(makeInput({ media: makeMedia({ container: "mkv" }), policy: disabledPolicy() }));
    expect(result.decision).toBe("direct-stream");
    expect(result.reasons.map((r) => r.code)).toEqual(["container-not-direct-playable"]);
    expect(result.ffmpegArgs.length).toBeGreaterThan(0);
  });

  it("BOUNDARY: download-mode container-only change still remuxes with REAL ffmpegArgs", () => {
    const result = plan(makeInput({ media: makeMedia({ container: "mkv" }), policy: disabledPolicy(), mode: "download" }));
    expect(result.decision).toBe("remux");
    expect(result.ffmpegArgs.slice(-3)).toEqual(["-f", "mp4", "{SESSION_DIR}/download.mp4"]);
  });

  it("BOUNDARY: direct-play is unaffected", () => {
    const result = plan(makeInput({ policy: disabledPolicy() }));
    expect(result.decision).toBe("direct-play");
    expect(result.reasons).toEqual([]);
  });

  it("no Stage G reason ever lands on a disabled plan (the routing was skipped, not merely discarded)", () => {
    const media = makeMedia();
    media.video[0]!.interlaced = true;
    const result = plan(makeInput({ media, policy: disabledPolicy() }));
    expect(
      result.reasons.some((r) => r.code.startsWith("hw-encoder-selected") || r.code.startsWith("software-fallback")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wave C1 (LD-7 / LD-16) — the §7.2 unreachability argument, made at the
// plan() level. Each numbered leg is also pinned individually in the matrix
// (520-527) and quantified over randomized inputs by §10 property 5; these
// are the readable, hand-constructed statements of the same four steps.
// ---------------------------------------------------------------------------

describe("plan(): AV1 ladder targeting end-to-end (docs/PLAYBACK.md §7.1/§7.2)", () => {
  const AV1_ENCODER_NAMES = ["libsvtav1", "av1_nvenc", "av1_qsv", "av1_vaapi", "av1_amf"];

  const AV1_DEVICE = makeDevice({
    directPlayContainers: [], // force a repackage so a ladder is always built
    video: [
      { codec: "h264", maxProfile: "high", maxLevel: null, maxBitDepth: 8, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
      { codec: "hevc", maxProfile: "main10", maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
      { codec: "av1", maxProfile: null, maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null },
    ],
  });

  const LADDER_TABLE = [
    { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" as const },
    { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" as const },
  ];

  function av1Policy(overrides: Partial<PlanInput["policy"]> = {}): PlanInput["policy"] {
    return {
      allowTranscode: true,
      allowToneMapCpu: "always",
      tier: 1,
      preferredTextSubMode: "hls-vtt",
      preserveAssStyling: false,
      audioTranscodeCodecPriority: ["opus", "aac"],
      maxSimultaneousTranscodes: 2,
      ladderRungs: LADDER_TABLE,
      segmentDurationSec: 2,
      hevcEncodePreferred: false,
      av1EncodePreferred: true,
      ...overrides,
    };
  }

  const HW_AV1 = {
    backends: [
      { backend: "nvenc" as const, decode: ["h264" as const, "hevc" as const, "av1" as const], encode: ["h264" as const, "hevc" as const, "av1" as const], toneMap: ["cuda" as const], verifiedAtMs: 1 },
      { backend: "software" as const, decode: ["h264" as const, "hevc" as const], encode: ["h264" as const, "hevc" as const], toneMap: [], verifiedAtMs: 1 },
    ],
  };
  const SOFTWARE_AV1 = {
    backends: [
      { backend: "software" as const, decode: ["h264" as const, "hevc" as const, "av1" as const], encode: ["h264" as const, "hevc" as const, "av1" as const], toneMap: [], verifiedAtMs: 1 },
    ],
  };

  /** A transcode-forcing input: interlaced source, so Stage B escalates and
   *  a ladder is genuinely constructed and routed. */
  function av1Input(overrides: Partial<PlanInput> = {}): PlanInput {
    const media = makeMedia({ container: "mkv" });
    media.video[0]!.interlaced = true;
    return makeInput({ media, device: AV1_DEVICE, policy: av1Policy(), caps: HW_AV1, ...overrides });
  }

  it("T0 + hardware av1 + opt-in + av1/fmp4 device -> av1 rungs, av1 targetCodec, av1_nvenc in the args", () => {
    const result = plan(av1Input({ policy: av1Policy({ tier: 0 }) }));
    expect(result.decision).toBe("transcode");
    expect(result.ladder.every((r) => r.codec === "av1")).toBe(true);
    expect(result.ladder.map((r) => r.videoBitrateBps)).toEqual([4_800_000, 1_800_000]);
    expect(result.video.targetCodec).toBe("av1");
    expect(result.video.encoder).toBe("nvenc");
    expect(result.ffmpegArgs).toContain("av1_nvenc");
  });

  it("T1 + SOFTWARE av1 -> av1 rungs on the software route, libsvtav1 with -preset 10", () => {
    const result = plan(av1Input({ caps: SOFTWARE_AV1, policy: av1Policy({ tier: 1 }) }));
    expect(result.video.targetCodec).toBe("av1");
    expect(result.video.encoder).toBe("software");
    expect(result.ffmpegArgs).toContain("libsvtav1");
    expect(result.ffmpegArgs[result.ffmpegArgs.indexOf("-preset") + 1]).toBe("10");
    expect(result.ffmpegArgs).not.toContain("-level");
  });

  it("LEG 1+2+3 — T0 + software-only av1 emits NO av1 rung, NO av1 targetCodec, NO av1 encoder token", () => {
    const result = plan(av1Input({ caps: SOFTWARE_AV1, policy: av1Policy({ tier: 0 }) }));
    expect(result.ladder.some((r) => r.codec === "av1")).toBe(false);
    expect(result.video.targetCodec).not.toBe("av1");
    for (const name of AV1_ENCODER_NAMES) expect(result.ffmpegArgs, name).not.toContain(name);
  });

  it("LEG 1 — an EXPLICIT av1 policy rung on a T0 software-av1 box is DEMOTED, never emitted", () => {
    const policy = av1Policy({
      tier: 0,
      ladderRungs: [{ heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 384_000, codec: "av1" }],
    });
    const result = plan(av1Input({ caps: SOFTWARE_AV1, policy }));
    expect(result.ladder).toEqual([{ heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 384_000, codec: "hevc" }]);
    expect(result.reasons.filter((r) => r.code === "av1-rung-demoted")).toEqual([
      { code: "av1-rung-demoted", detail: "cause=tier0-no-hw-av1 demotedTo=hevc heightPx=1080" },
    ]);
    for (const name of AV1_ENCODER_NAMES) expect(result.ffmpegArgs, name).not.toContain(name);
  });

  it("a ts-hls device never gets an av1 swap — the args are byte-identical to the opt-OUT plan", () => {
    const tsDevice = makeDevice({
      directPlayContainers: [],
      hls: { container: "ts", supportsFmp4: false, lowLatency: false },
      video: AV1_DEVICE.video,
    });
    const optedIn = plan(av1Input({ device: tsDevice, policy: av1Policy({ tier: 2 }) }));
    const optedOut = plan(av1Input({ device: tsDevice, policy: av1Policy({ tier: 2, av1EncodePreferred: false }) }));
    expect(optedIn.ladder.some((r) => r.codec === "av1")).toBe(false);
    expect(optedIn.ffmpegArgs).toEqual(optedOut.ffmpegArgs);
    expect(optedIn.container).toBe("ts-hls");
  });

  it("COPY-PREFERENCE GUARANTEE — an AV1 SOURCE still direct-plays; no §7.1 rule ever reads it", () => {
    const media = makeMedia({ container: "mp4" });
    media.video[0]!.codec = "av1";
    const device = makeDevice({
      directPlayContainers: ["mp4"],
      video: [{ codec: "av1", maxProfile: null, maxLevel: null, maxBitDepth: 10, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60, maxBitrateBps: null }],
    });
    for (const tier of [0, 1, 2] as const) {
      const result = plan(makeInput({ media, device, policy: av1Policy({ tier }), caps: SOFTWARE_AV1 }));
      expect(result.decision, `tier=${tier}`).toBe("direct-play");
      expect(result.reasons).toEqual([]);
      expect(result.ladder).toEqual([]);
      expect(result.ffmpegArgs).toEqual([]);
    }
  });
});
