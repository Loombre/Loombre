// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/stages/subtitle.ts (Stage E — docs/PLAYBACK.md §3, Phase
 * 3 Step 2e). Lives in the package's NORMAL (non-matrix) test project
 * (vitest.config.ts's `include` covers `test/**\/*.spec.ts`), separate from
 * matrix/'s case-file burn-up.
 *
 * Coverage (per this step's instructions): every branch of both trees (TEXT
 * cascade (a)/(b)/(c), IMAGE embed/burn-in), the `unknown` override, external
 * subtitle handling, cascade order (including the literal-order embed-
 * despite-burn-in-policy case), the burn-in verdict + video-reason gating on
 * Stage B's OWN verdict, and streamIndex discipline. Also plan()-level tests:
 * video.action becoming 'transcode' on burn-in with a Stage-B-copy source,
 * the §5 subtitle output field assembly, and the download-remux interaction
 * (binding instructions constraint 10: download + container-mismatch + pgs
 * burn-in -> transcode, never remux).
 */
import { describe, expect, it } from "vitest";
import { evaluateSubtitle } from "../../src/stages/subtitle.js";
import { plan } from "../../src/plan.js";
import type {
  AudioStream,
  DeviceProfile,
  MediaInfo,
  PlanInput,
  ServerPolicy,
  SubtitleStream,
  VideoStream,
} from "../../src/types.js";

function makeSubtitleStream(overrides: Partial<SubtitleStream> = {}): SubtitleStream {
  return {
    index: 2,
    codec: "subrip",
    language: "eng",
    isForced: false,
    isDefault: false,
    isExternal: false,
    externalPath: null,
    ...overrides,
  };
}

function makeVideoStream(overrides: Partial<VideoStream> = {}): VideoStream {
  return {
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
    ...overrides,
  };
}

function makeAudioStream(overrides: Partial<AudioStream> = {}): AudioStream {
  return {
    index: 1,
    codec: "aac",
    channels: 2,
    sampleRate: 48000,
    bitrateBps: 160_000,
    language: "eng",
    isDefault: true,
    hasAtmos: false,
    ...overrides,
  };
}

function makeMedia(subtitle: SubtitleStream[], overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    fileId: "file-1",
    container: "mp4",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: 8_000_000,
    video: [makeVideoStream()],
    audio: [makeAudioStream()],
    subtitle,
    ...overrides,
  };
}

function makeDevice(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    profileId: "test-device",
    directPlayContainers: ["mp4"],
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
    audio: [{ codec: "aac", maxChannels: 6, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
    ...overrides,
  };
}

function makePolicy(overrides: Partial<ServerPolicy> = {}): ServerPolicy {
  return {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluateSubtitle() — selection / vacuous-pass branches
// ---------------------------------------------------------------------------

describe("Stage E: evaluateSubtitle — selection / vacuous-pass branches", () => {
  it("subtitleStreamIndex null -> strategy 'none', verdict direct-play, no reasons, no streamIndex", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "pgs" })]); // present but unselected
    const device = makeDevice();
    const out = evaluateSubtitle(media, device, makePolicy(), null, true, "direct-play");
    expect(out).toEqual({ result: { verdict: "direct-play", reasons: [] }, strategy: "none" });
    expect(out.streamIndex).toBeUndefined();
  });

  it("media.subtitle is empty -> strategy 'none' regardless of index", () => {
    const media = makeMedia([]);
    const device = makeDevice();
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out).toEqual({ result: { verdict: "direct-play", reasons: [] }, strategy: "none" });
  });

  it("selection index does not resolve to any stream (defensive) -> vacuous pass, never throws", () => {
    const media = makeMedia([makeSubtitleStream({ index: 2 })]);
    const device = makeDevice();
    const out = evaluateSubtitle(media, device, makePolicy(), 99, true, "direct-play");
    expect(out).toEqual({ result: { verdict: "direct-play", reasons: [] }, strategy: "none" });
  });
});

// ---------------------------------------------------------------------------
// TEXT tree — cascade (a): device.hlsVtt && policy.preferredTextSubMode==='hls-vtt'
// ---------------------------------------------------------------------------

describe("Stage E: TEXT cascade (a) — hls-vtt branch", () => {
  it("non-ass TEXT codec (subrip) -> strategy hls-vtt, verdict direct-play, no reasons at all", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "subrip" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preferredTextSubMode: "hls-vtt" }), 2, true, "direct-play");
    expect(out).toEqual({ result: { verdict: "direct-play", reasons: [] }, strategy: "hls-vtt", streamIndex: 2 });
  });

  it("webvtt / mov_text also hit the same non-ass hls-vtt branch, reason-free (codec-agnostic outside ass)", () => {
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    for (const codec of ["webvtt", "mov_text"] as const) {
      const media = makeMedia([makeSubtitleStream({ codec })]);
      const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
      expect(out.strategy, codec).toBe("hls-vtt");
      expect(out.result.reasons, codec).toEqual([]);
    }
  });

  it("ass + NOT preserveAssStyling -> hls-vtt, WITH informational subtitle-styling-lost (verdict stays direct-play)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "ass" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preserveAssStyling: false }), 2, true, "direct-play");
    expect(out.strategy).toBe("hls-vtt");
    expect(out.result).toEqual({
      verdict: "direct-play",
      reasons: [{ code: "subtitle-styling-lost", streamIndex: 2 }],
    });
  });

  it("ass + preserveAssStyling true -> OVERRIDES to burn-in, subtitle-burn-in-for-styling (verdict transcode)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "ass" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preserveAssStyling: true }), 2, true, "direct-play");
    expect(out.strategy).toBe("burn-in");
    expect(out.result.verdict).toBe("transcode");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-burn-in-for-styling",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });

  it("ass + preserveAssStyling true + Stage B ALREADY transcode -> burn-in-for-styling alone, no duplicate video reason", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "ass" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preserveAssStyling: true }), 2, true, "transcode");
    expect(out.result.reasons.map((r) => r.code)).toEqual(["subtitle-burn-in-for-styling"]);
  });

  it("(a) fires REGARDLESS of device.subtitles.renderText / containerDirectPlayable — cascade never reaches (b)/(c)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "subrip" })]);
    // renderText EXCLUDES subrip and container is NOT direct-playable — if
    // the cascade fell through to (b)/(c) this would burn-in; (a) must win.
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preferredTextSubMode: "hls-vtt" }), 2, false, "direct-play");
    expect(out.strategy).toBe("hls-vtt");
  });
});

// ---------------------------------------------------------------------------
// TEXT tree — cascade (b): device renders codec natively in directPlayContainer
// ---------------------------------------------------------------------------

describe("Stage E: TEXT cascade (b) — embed branch", () => {
  it("device.hlsVtt false (policy says hls-vtt) + renderText includes codec + containerDirectPlayable -> embed", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "subrip" })]);
    const device = makeDevice({ subtitles: { renderText: ["subrip"], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preferredTextSubMode: "hls-vtt" }), 2, true, "direct-play");
    expect(out).toEqual({ result: { verdict: "direct-play", reasons: [] }, strategy: "embed", streamIndex: 2 });
  });

  it("LITERAL CASCADE ORDER PIN (binding interpretation constraint 3): policy.preferredTextSubMode==='burn-in' STILL yields 'embed' when device.hlsVtt true + renderText includes codec + container playable — (a) merely failed to fire, (b) is reached the same as any other (a)-miss", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "webvtt" })]);
    const device = makeDevice({ subtitles: { renderText: ["webvtt"], hlsVtt: true, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preferredTextSubMode: "burn-in" }), 2, true, "direct-play");
    expect(out.strategy).toBe("embed");
    expect(out.result).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("embed preserves ASS styling wholesale — no subtitle-styling-lost in the embed branch", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "ass" })]);
    const device = makeDevice({ subtitles: { renderText: ["ass"], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out).toEqual({ result: { verdict: "direct-play", reasons: [] }, strategy: "embed", streamIndex: 2 });
  });
});

// ---------------------------------------------------------------------------
// TEXT tree — cascade (c): burn-in fallback
// ---------------------------------------------------------------------------

describe("Stage E: TEXT cascade (c) — burn-in fallback", () => {
  it("renderText EXCLUDES the codec -> burn-in, subtitle-format-requires-burn-in", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "mov_text" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preferredTextSubMode: "burn-in" }), 2, true, "direct-play");
    expect(out.strategy).toBe("burn-in");
    expect(out.result.verdict).toBe("transcode");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-format-requires-burn-in",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });

  it("renderText INCLUDES the codec but containerDirectPlayable is false -> STILL burn-in (embed requires BOTH)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "subrip" })]);
    const device = makeDevice({ subtitles: { renderText: ["subrip"], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, false, "direct-play");
    expect(out.strategy).toBe("burn-in");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-format-requires-burn-in",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });

  it("plain ass falls to (c) when device.hlsVtt is false and renderText excludes ass -> ordinary format-requires-burn-in, NOT the styling-specific reasons", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "ass" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preserveAssStyling: true }), 2, true, "direct-play");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-format-requires-burn-in",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });
});

// ---------------------------------------------------------------------------
// IMAGE tree
// ---------------------------------------------------------------------------

describe("Stage E: IMAGE tree (pgs/vobsub/dvbsub)", () => {
  it.each(["pgs", "vobsub", "dvbsub"] as const)(
    "%s: renderImage true + containerDirectPlayable true -> embed",
    (codec) => {
      const media = makeMedia([makeSubtitleStream({ codec })]);
      const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: true } });
      const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
      expect(out).toEqual({ result: { verdict: "direct-play", reasons: [] }, strategy: "embed", streamIndex: 2 });
    },
  );

  it("renderImage false (container playable) -> burn-in, subtitle-format-requires-burn-in", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "pgs" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out.strategy).toBe("burn-in");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-format-requires-burn-in",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });

  it("renderImage true but containerDirectPlayable false -> burn-in (AND requires BOTH)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "vobsub" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: true } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, false, "direct-play");
    expect(out.strategy).toBe("burn-in");
  });

  it("neither renderImage nor containerDirectPlayable -> burn-in", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "dvbsub" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, false, "direct-play");
    expect(out.strategy).toBe("burn-in");
  });
});

// ---------------------------------------------------------------------------
// unknown codec override (binding interpretation constraint 5)
// ---------------------------------------------------------------------------

describe("Stage E: unknown codec ALWAYS burn-in, subtitle-codec-unknown REPLACES subtitle-format-requires-burn-in", () => {
  it("renderImage false -> burn-in, subtitle-codec-unknown (not subtitle-format-requires-burn-in)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "unknown" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out.strategy).toBe("burn-in");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-codec-unknown",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });

  it("renderImage TRUE + containerDirectPlayable TRUE (would embed a real pgs/vobsub/dvbsub) -> STILL burn-in for unknown", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "unknown" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: true } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out.strategy).toBe("burn-in");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-codec-unknown",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });

  it("unknown + Stage B already transcode -> subtitle-codec-unknown alone, no duplicate video reason", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "unknown" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: true } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "transcode");
    expect(out.result.reasons.map((r) => r.code)).toEqual(["subtitle-codec-unknown"]);
  });

  it("unknown via an EXTERNAL stream (isExternal true) behaves identically — codec alone drives it", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "unknown", isExternal: true, externalPath: "/sidecars/x.sub" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: true } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out.strategy).toBe("burn-in");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-codec-unknown",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });
});

// ---------------------------------------------------------------------------
// External subtitles (binding interpretation constraint 8) — codec alone drives the tree
// ---------------------------------------------------------------------------

describe("Stage E: external subtitles are treated identically to embedded ones, by codec alone", () => {
  it("external .srt (codec subrip) through hls-vtt", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "subrip", isExternal: true, externalPath: "/sidecars/movie.srt" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preferredTextSubMode: "hls-vtt" }), 2, true, "direct-play");
    expect(out.strategy).toBe("hls-vtt");
    expect(out.result.reasons).toEqual([]);
  });

  it("external .srt through embed", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "subrip", isExternal: true, externalPath: "/sidecars/movie.srt" })]);
    const device = makeDevice({ subtitles: { renderText: ["subrip"], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out.strategy).toBe("embed");
  });

  it("external .srt through burn-in", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "subrip", isExternal: true, externalPath: "/sidecars/movie.srt" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy({ preferredTextSubMode: "burn-in" }), 2, true, "direct-play");
    expect(out.strategy).toBe("burn-in");
  });
});

// ---------------------------------------------------------------------------
// streamIndex discipline (binding interpretation constraint 9)
// ---------------------------------------------------------------------------

describe("Stage E: streamIndex discipline — present iff strategy !== 'none'", () => {
  it("'none' never carries streamIndex", () => {
    const media = makeMedia([]);
    const device = makeDevice();
    const out = evaluateSubtitle(media, device, makePolicy(), null, true, "direct-play");
    expect(out.strategy).toBe("none");
    expect("streamIndex" in out).toBe(false);
  });

  it.each(["hls-vtt", "embed", "burn-in"] as const)("'%s' always carries the SELECTED stream's own index, non-zero included", (_strategy) => {
    // Construct each branch with a non-zero subtitle index (5) to prove the
    // engine reports the SELECTED stream's real index, not a hardcoded 0/2.
    const media = makeMedia([makeSubtitleStream({ index: 5, codec: "webvtt" })]);
    let device: DeviceProfile;
    let policy: ServerPolicy;
    if (_strategy === "hls-vtt") {
      device = makeDevice({ subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
      policy = makePolicy({ preferredTextSubMode: "hls-vtt" });
    } else if (_strategy === "embed") {
      device = makeDevice({ subtitles: { renderText: ["webvtt"], hlsVtt: false, renderImage: false } });
      policy = makePolicy();
    } else {
      device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
      policy = makePolicy({ preferredTextSubMode: "burn-in" });
    }
    const out = evaluateSubtitle(media, device, policy, 5, true, "direct-play");
    expect(out.strategy).toBe(_strategy);
    expect(out.streamIndex).toBe(5);
    for (const r of out.result.reasons) {
      expect(r.streamIndex).toBe(5);
    }
  });

  it("video-transcode-for-subtitle-burn-in carries the SUBTITLE stream's index, not the video stream's", () => {
    const media = makeMedia([makeSubtitleStream({ index: 7, codec: "pgs" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 7, true, "direct-play");
    const videoTranscodeReason = out.result.reasons.find((r) => r.code === "video-transcode-for-subtitle-burn-in");
    expect(videoTranscodeReason?.streamIndex).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// video-transcode-for-subtitle-burn-in gating on Stage B's verdict (binding
// interpretation constraint 6)
// ---------------------------------------------------------------------------

describe("Stage E: video-transcode-for-subtitle-burn-in gating on Stage B's OWN verdict", () => {
  it("Stage B verdict 'direct-play' (copy) -> appended AFTER the strategy-blocking reason", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "pgs" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out.result.reasons.map((r) => r.code)).toEqual([
      "subtitle-format-requires-burn-in",
      "video-transcode-for-subtitle-burn-in",
    ]);
  });

  it("Stage B verdict 'transcode' -> NOT appended (only the strategy-blocking reason)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "pgs" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "transcode");
    expect(out.result.reasons.map((r) => r.code)).toEqual(["subtitle-format-requires-burn-in"]);
  });

  it("SURFACED interpretation: the gate is on Stage B's verdict alone (not the aggregate video.action) — a Stage-C-only HDR transcode with Stage B still 'direct-play' still gets the reason appended", () => {
    // Stage E has no visibility into Stage C at all; this test simply pins
    // that passing videoVerdict='direct-play' (Stage B's own verdict, even
    // when some OTHER stage is what will actually force video.action to
    // 'transcode') still appends the reason, matching stages/subtitle.ts's
    // documented interpretation.
    const media = makeMedia([makeSubtitleStream({ codec: "pgs" })]);
    const device = makeDevice({ subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const out = evaluateSubtitle(media, device, makePolicy(), 2, true, "direct-play");
    expect(out.result.reasons.map((r) => r.code)).toContain("video-transcode-for-subtitle-burn-in");
  });
});

// ---------------------------------------------------------------------------
// plan()-level assembly tests
// ---------------------------------------------------------------------------

function makePlanInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    media: makeMedia([]),
    device: makeDevice({ directPlayContainers: ["mp4"] }),
    network: { maxBitrateBps: 100_000_000, isLocal: true },
    policy: makePolicy(),
    caps: { backends: [{ backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 }] },
    selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    mode: "stream",
    ...overrides,
  };
}

describe("plan(): video.action becomes 'transcode' on burn-in even when Stage B alone would copy", () => {
  it("pgs burn-in (device renderImage false), h264 within device caps -> video.action 'transcode', decision 'transcode'", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "pgs" })]);
    const result = plan(makePlanInput({ media, selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 } }));
    expect(result.video.action).toBe("transcode");
    expect(result.decision).toBe("transcode");
    expect(result.subtitle).toEqual({ strategy: "burn-in", streamIndex: 2 });
  });

  it("hls-vtt strategy never forces video.action to transcode (stays 'copy')", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "webvtt" })]);
    const device = makeDevice({ directPlayContainers: ["mp4"], subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const result = plan(
      makePlanInput({
        media,
        device,
        policy: makePolicy({ preferredTextSubMode: "hls-vtt" }),
        selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 },
      }),
    );
    expect(result.video.action).toBe("copy");
    expect(result.decision).toBe("direct-play");
  });

  it("no video stream at all (music) + subtitle forced to burn-in -> video.action stays 'none' (SURFACED: the reason still fires, per stages/subtitle.ts's documented artifact, even though there is no video track to transcode)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "subrip", isExternal: true, externalPath: "/sidecars/lyrics.srt" })], {
      container: "mp4",
      video: [],
    });
    const device = makeDevice({
      directPlayContainers: ["mp4"],
      video: [],
      subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    });
    const result = plan(
      makePlanInput({
        media,
        device,
        selection: { videoStreamIndex: null, audioStreamIndex: 1, subtitleStreamIndex: 2 },
      }),
    );
    expect(result.subtitle).toEqual({ strategy: "burn-in", streamIndex: 2 });
    expect(result.reasons.map((r) => r.code)).toEqual([
      "subtitle-format-requires-burn-in",
      "video-transcode-for-subtitle-burn-in",
    ]);
    // The output contract still correctly reports no video work at all —
    // there is no video stream to act on, regardless of the fired reason.
    expect(result.video.action).toBe("none");
    expect(result.decision).toBe("transcode");
  });
});

describe("plan(): §5 subtitle output field assembly", () => {
  it("'none' carries no streamIndex field at all", () => {
    const result = plan(makePlanInput());
    expect(result.subtitle).toEqual({ strategy: "none" });
    expect("streamIndex" in result.subtitle).toBe(false);
  });

  it("every non-'none' strategy carries streamIndex matching the SELECTED subtitle stream", () => {
    const media = makeMedia([makeSubtitleStream({ index: 9, codec: "webvtt" })]);
    const device = makeDevice({ directPlayContainers: ["mp4"], subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const result = plan(
      makePlanInput({ media, device, selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 9 } }),
    );
    expect(result.subtitle).toEqual({ strategy: "hls-vtt", streamIndex: 9 });
  });
});

describe("plan(): download-remux interaction with Stage E (binding instructions constraint 10)", () => {
  it("download + container-mismatch + pgs burn-in -> transcode, NOT remux (burn-in's blocking reason blocks the container-only-change predicate)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "pgs" })], { container: "mkv" });
    const device = makeDevice({ directPlayContainers: ["mp4"], subtitles: { renderText: [], hlsVtt: false, renderImage: false } });
    const result = plan(
      makePlanInput({
        media,
        device,
        mode: "download",
        selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 },
      }),
    );
    expect(result.decision).toBe("transcode");
    expect(result.container).not.toBe("mp4");
    // why (Phase 3 §11 step 3, Stage G arrival): this scenario's caps
    // declares only a `software` backend -> Stage G's full-software route
    // always fires `software-fallback:encode`. NO `tier-capped` here despite
    // tier 0 + a 1080p source: `makePolicy()`'s default `ladderRungs: []`
    // means Stage F's `buildLadder` returns an empty ladder BEFORE Stage G
    // ever runs, and the tier cap only fires when it actually removes rungs
    // from a non-empty ladder (stages/hardware.ts's `applyTierCap` — an
    // already-empty ladder has nothing to remove).
    expect(result.reasons.map((r) => r.code)).toEqual([
      "container-not-direct-playable",
      "subtitle-format-requires-burn-in",
      "video-transcode-for-subtitle-burn-in",
      "software-fallback:encode",
    ]);
  });

  it("download + container-mismatch + hls-vtt (informational only) -> STILL remux (informational reason never blocks, matches the dv-stripped-to-hdr10 precedent)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "ass" })], { container: "mkv" });
    const device = makeDevice({ directPlayContainers: ["mp4"], subtitles: { renderText: [], hlsVtt: true, renderImage: false } });
    const result = plan(
      makePlanInput({
        media,
        device,
        mode: "download",
        policy: makePolicy({ preferredTextSubMode: "hls-vtt", preserveAssStyling: false }),
        selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 2 },
      }),
    );
    expect(result.decision).toBe("remux");
    expect(result.container).toBe("mp4");
    expect(result.reasons.map((r) => r.code)).toEqual(["container-not-direct-playable", "subtitle-styling-lost"]);
  });
});

describe("plan(): informational reasons never unlock download-remux for a BLOCKING burn-in (0.3.1 predicate, constraint 10)", () => {
  it("download + container-mismatch + pgs burn-in -> decision is 'transcode', never 'remux' (spot-check distinct from the case above, different device/codec combo)", () => {
    const media = makeMedia([makeSubtitleStream({ codec: "pgs", index: 3 })], { container: "avi" });
    const device = makeDevice({
      directPlayContainers: ["mp4", "mkv"],
      subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    });
    const result = plan(
      makePlanInput({
        media,
        device,
        mode: "download",
        selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: 3 },
      }),
    );
    expect(result.decision).toBe("transcode");
  });
});
