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
      segmentDurationSec: 6,
      hevcEncodePreferred: false,
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
      segmentDurationSec: 6 as const,
      hevcEncodePreferred: false,
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
      const media = makeMedia({ video: [{ index: 0, codec: "hevc", profile: "main10", level: 153, width: 1920, height: 1080, bitDepth: 8, frameRate: 23.976, bitrateBps: 5_000_000, hdr: "none", dvProfile: null, dvBlCompatId: null, interlaced: false }] });
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
        segmentDurationSec: 6,
        hevcEncodePreferred: false,
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
        segmentDurationSec: 6,
        hevcEncodePreferred: false,
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
        segmentDurationSec: 6,
        hevcEncodePreferred: false,
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
        segmentDurationSec: 6,
        hevcEncodePreferred: false,
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
      segmentDurationSec: 6,
      hevcEncodePreferred: false,
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
