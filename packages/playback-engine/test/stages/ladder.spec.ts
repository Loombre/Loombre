// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/stages/ladder.ts (Stage F — docs/PLAYBACK.md §3/§7,
 * Phase 3 Step 2f). Lives in the package's NORMAL (non-matrix) test project
 * (vitest.config.ts's `include` covers `test/**\/*.spec.ts`), separate from
 * matrix/'s case-file burn-up.
 *
 * Coverage (per this step's instructions): `evaluateBitrate`'s reason-rule
 * truth table including BOTH unless-clause directions (local+within-device-
 * cap -> no reason; local+exceeds-device-cap -> reason fires), every
 * `buildLadder` construction rule (a)-(f) isolated on its own, the
 * ordered-swap proof (a rung surviving a cap ONLY because of the ×0.75
 * hevc reduction), the keep-lowest-rung fallback, and the refused ⇒
 * `ladder: []` guarantee via a full `plan()` call (test/stages/hdr.spec.ts
 * carries the ORIGINAL Step 2c pin, extended by this step; this file adds
 * its own focused copy per this step's instructions).
 */
import { describe, expect, it } from "vitest";
import { evaluateBitrate, buildLadder } from "../../src/stages/ladder.js";
import { plan } from "../../src/plan.js";
import type {
  DeviceProfile,
  DeviceProfileVideoEntry,
  LadderRung,
  MediaInfo,
  NetworkConditions,
  PlanInput,
  ServerPolicy,
  VideoStream,
} from "../../src/types.js";

const DEFAULT_LADDER: LadderRung[] = [
  { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
  { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" },
  { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
];

function makeVideoStream(overrides: Partial<VideoStream> = {}): VideoStream {
  return {
    index: 0,
    codec: "h264",
    profile: "high",
    level: 41,
    width: 3840,
    height: 2160,
    bitDepth: 8,
    frameRate: 23.976,
    bitrateBps: 20_000_000,
    hdr: "none",
    dvProfile: null,
    dvBlCompatId: null,
    interlaced: false,
    ...overrides,
  };
}

function makeMedia(video: VideoStream[], overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    fileId: "file-1",
    container: "mp4",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: video[0]?.bitrateBps ?? 20_000_000,
    video,
    audio: [],
    subtitle: [],
    ...overrides,
  };
}

const GENEROUS_H264_ENTRY: DeviceProfileVideoEntry = {
  codec: "h264",
  maxProfile: "high",
  maxLevel: 52,
  maxBitDepth: 8,
  maxWidth: 3840,
  maxHeight: 2160,
  maxFrameRate: 60,
  maxBitrateBps: null,
};

function makeDevice(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    profileId: "test-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [GENEROUS_H264_ENTRY],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
    ...overrides,
  };
}

function makeNetwork(overrides: Partial<NetworkConditions> = {}): NetworkConditions {
  return { maxBitrateBps: 100_000_000, isLocal: true, ...overrides };
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
    ladderRungs: DEFAULT_LADDER,
    segmentDurationSec: 6,
    hevcEncodePreferred: false,
    ...overrides,
  };
}

describe("evaluateBitrate: videoAlreadyTranscoding gate (binding interpretation constraint 1)", () => {
  it("videoAlreadyTranscoding=true -> NEVER fires, even when overall wildly exceeds a non-local network cap", () => {
    const media = makeMedia([makeVideoStream({ bitrateBps: 100_000_000 })], { overallBitrateBps: 100_000_000 });
    const device = makeDevice();
    const network = makeNetwork({ maxBitrateBps: 1_000_000, isLocal: false });
    expect(evaluateBitrate(media, device, network, 0, true)).toEqual({ verdict: "direct-play", reasons: [] });
  });
});

describe("evaluateBitrate: selection scoping (vacuous-pass branches)", () => {
  it("videoStreamIndex null -> vacuous pass regardless of network", () => {
    const media = makeMedia([makeVideoStream({ bitrateBps: 100_000_000 })], { overallBitrateBps: 100_000_000 });
    const network = makeNetwork({ maxBitrateBps: 1_000_000, isLocal: false });
    expect(evaluateBitrate(media, makeDevice(), network, null, false)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("media.video empty (music mode) -> vacuous pass regardless of index", () => {
    const media = makeMedia([], { overallBitrateBps: 100_000_000 });
    const network = makeNetwork({ maxBitrateBps: 1_000_000, isLocal: false });
    expect(evaluateBitrate(media, makeDevice(), network, 0, false)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("selection index does not resolve to any stream (defensive) -> vacuous pass, never throws", () => {
    const media = makeMedia([makeVideoStream({ index: 0, bitrateBps: 100_000_000 })], {
      overallBitrateBps: 100_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 1_000_000, isLocal: false });
    expect(evaluateBitrate(media, makeDevice(), network, 7, false)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });
});

describe("evaluateBitrate: reason rule truth table (binding interpretation constraint 2)", () => {
  it("overall <= network.maxBitrateBps -> NO reason, whether local or not", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 4_000_000 });
    for (const isLocal of [true, false]) {
      const network = makeNetwork({ maxBitrateBps: 4_000_000, isLocal });
      expect(evaluateBitrate(media, makeDevice(), network, 0, false), `isLocal=${isLocal}`).toEqual({
        verdict: "direct-play",
        reasons: [],
      });
    }
  });

  it("overall > network.maxBitrateBps, NOT local -> FIRES", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 40_000_000 });
    const network = makeNetwork({ maxBitrateBps: 4_000_000, isLocal: false });
    const result = evaluateBitrate(media, makeDevice(), network, 0, false);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons).toEqual([
      { code: "bitrate-exceeds-network", detail: "overall=40000000 network=4000000" },
    ]);
  });

  it("PIN (direction 1) — local + overall > network.max + WITHIN device cap (null) -> NO reason", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 2_000_000_000 });
    const network = makeNetwork({ maxBitrateBps: 1_000_000_000, isLocal: true });
    const device = makeDevice({ maxStreamBitrateBps: null });
    expect(evaluateBitrate(media, device, network, 0, false)).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("PIN (direction 1, variant) — local + overall > network.max + WITHIN a non-null device cap -> NO reason", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 2_000_000_000 });
    const network = makeNetwork({ maxBitrateBps: 1_000_000_000, isLocal: true });
    const device = makeDevice({ maxStreamBitrateBps: 3_000_000_000 });
    expect(evaluateBitrate(media, device, network, 0, false)).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("PIN (direction 2) — local + overall > a non-null device cap -> reason FIRES (unless-clause's second half fails)", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 2_000_000_000 });
    const network = makeNetwork({ maxBitrateBps: 1_000_000_000, isLocal: true });
    const device = makeDevice({ maxStreamBitrateBps: 500_000 });
    const result = evaluateBitrate(media, device, network, 0, false);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toEqual(["bitrate-exceeds-network"]);
  });

  it("NOT local + overall > a non-null device cap that's otherwise fine -> still fires (isLocal is false, device cap is irrelevant to the unless-clause)", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 40_000_000 });
    const network = makeNetwork({ maxBitrateBps: 4_000_000, isLocal: false });
    const device = makeDevice({ maxStreamBitrateBps: 1_000_000_000 }); // overall <= this cap, doesn't matter
    const result = evaluateBitrate(media, device, network, 0, false);
    expect(result.verdict).toBe("transcode");
  });

  it("reason has no streamIndex (whole-file/network property, mirrors Stage A's container reason)", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 40_000_000 });
    const network = makeNetwork({ maxBitrateBps: 4_000_000, isLocal: false });
    const result = evaluateBitrate(media, makeDevice(), network, 0, false);
    expect(result.reasons[0]).toBeDefined();
    expect("streamIndex" in result.reasons[0]!).toBe(false);
  });
});

describe("buildLadder: rule (a) — never exceed source height", () => {
  it("720p source drops the 2160p and both 1080p rungs, keeping 720/480/360", () => {
    const media = makeMedia([makeVideoStream({ height: 720, width: 1280, bitrateBps: 10_000_000 })], {
      overallBitrateBps: 10_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 0);
    expect(ladder).toEqual([
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });

  it("480p source keeps only 480/360", () => {
    const media = makeMedia([makeVideoStream({ height: 480, width: 854, bitrateBps: 10_000_000 })], {
      overallBitrateBps: 10_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 0);
    expect(ladder).toEqual([
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });

  it("exact-boundary height (source height === a rung's heightPx) keeps that rung — 'exceed' is strict >", () => {
    const media = makeMedia([makeVideoStream({ height: 1080, width: 1920, bitrateBps: 10_000_000 })], {
      overallBitrateBps: 10_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 0);
    expect(ladder.some((r) => r.heightPx === 1080)).toBe(true);
    expect(ladder.some((r) => r.heightPx === 2160)).toBe(false);
  });
});

describe("buildLadder: rule (b) — never exceed source bitrate", () => {
  it("low-bitrate 2160p source drops the two highest rungs by bitrate alone (height passes)", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 5_000_000 })], {
      overallBitrateBps: 5_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 0);
    expect(ladder).toEqual([
      { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });

  it("comparator interpretation: stream.bitrateBps null falls back to media.overallBitrateBps", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: null })], {
      overallBitrateBps: 2_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 0);
    expect(ladder).toEqual([
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });

  it("exact-boundary bitrate (source bitrate === a rung's videoBitrateBps) keeps that rung — strict >", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 4_000_000 })], {
      overallBitrateBps: 4_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 0);
    expect(ladder.some((r) => r.videoBitrateBps === 4_000_000)).toBe(true);
    expect(ladder.some((r) => r.videoBitrateBps === 8_000_000)).toBe(false);
  });
});

describe("buildLadder: rule (c) — network cap, skipped when isLocal", () => {
  it("non-local: drops rungs above network.maxBitrateBps", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 5_000_000, isLocal: false });
    const ladder = buildLadder(media, makeDevice(), network, makePolicy(), 0);
    expect(ladder).toEqual([
      { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });

  it("isLocal=true SKIPS the network cap entirely (same numbers, only isLocal flips)", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 5_000_000, isLocal: true });
    const ladder = buildLadder(media, makeDevice(), network, makePolicy(), 0);
    expect(ladder).toEqual(DEFAULT_LADDER);
  });
});

describe("buildLadder: rule (d) — device cap, ALWAYS applied (isLocal honors it)", () => {
  it("isLocal=true still drops rungs above a non-null device.maxStreamBitrateBps", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 100_000_000, isLocal: true });
    const device = makeDevice({ maxStreamBitrateBps: 5_000_000 });
    const ladder = buildLadder(media, device, network, makePolicy(), 0);
    expect(ladder).toEqual([
      { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });

  it("device cap is null -> unconstrained (no drop from this rule)", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const device = makeDevice({ maxStreamBitrateBps: null });
    const ladder = buildLadder(media, device, makeNetwork(), makePolicy(), 0);
    expect(ladder).toEqual(DEFAULT_LADDER);
  });
});

describe("buildLadder: rule (e) — keep at least the lowest rung when everything else drops", () => {
  it("device cap below even the lowest (360p/800000) rung still yields exactly that one rung", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 100_000_000, isLocal: true });
    const device = makeDevice({ maxStreamBitrateBps: 100_000 }); // below every rung
    const ladder = buildLadder(media, device, network, makePolicy(), 0);
    expect(ladder).toEqual([{ heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" }]);
  });

  it("network cap (non-local) below even the lowest rung still yields exactly that one rung", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 100_000, isLocal: false });
    const ladder = buildLadder(media, makeDevice(), network, makePolicy(), 0);
    expect(ladder).toEqual([{ heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" }]);
  });

  it("even a source height below every rung (e.g. 240p) still yields the lowest rung, not []", () => {
    const media = makeMedia([makeVideoStream({ height: 240, width: 426, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 0);
    expect(ladder).toEqual([{ heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" }]);
  });
});

describe("buildLadder: rule (f) — hevc swap (device hevc entry + policy.hevcEncodePreferred)", () => {
  const HEVC_DEVICE = makeDevice({ video: [GENEROUS_H264_ENTRY, { ...GENEROUS_H264_ENTRY, codec: "hevc" }] });

  it("applies to every rung below 2160p, ×0.75 exact, leaves the 2160p rung untouched", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const policy = makePolicy({ hevcEncodePreferred: true });
    const ladder = buildLadder(media, HEVC_DEVICE, makeNetwork(), policy, 0);
    expect(ladder).toEqual([
      { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 1080, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "hevc" },
      { heightPx: 720, videoBitrateBps: 2_250_000, audioBitrateBps: 160_000, codec: "hevc" },
      { heightPx: 480, videoBitrateBps: 1_125_000, audioBitrateBps: 160_000, codec: "hevc" },
      { heightPx: 360, videoBitrateBps: 600_000, audioBitrateBps: 160_000, codec: "hevc" },
    ]);
  });

  it("hevcEncodePreferred=false -> h264 unchanged even though the device has an hevc entry", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const policy = makePolicy({ hevcEncodePreferred: false });
    const ladder = buildLadder(media, HEVC_DEVICE, makeNetwork(), policy, 0);
    expect(ladder).toEqual(DEFAULT_LADDER);
  });

  it("hevcEncodePreferred=true but device has NO hevc entry -> h264 unchanged", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const policy = makePolicy({ hevcEncodePreferred: true });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), policy, 0); // h264-only device
    expect(ladder).toEqual(DEFAULT_LADDER);
  });

  it("ORDERED-SWAP PROOF: a rung survives a network cap ONLY because the swap is applied BEFORE the cap check", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 7_000_000, isLocal: false });

    // WITHOUT the swap (hevcEncodePreferred false): the 1080p/8,000,000 rung
    // exceeds the 7,000,000 cap and is dropped.
    const withoutSwap = buildLadder(media, HEVC_DEVICE, network, makePolicy({ hevcEncodePreferred: false }), 0);
    expect(withoutSwap.some((r) => r.heightPx === 1080 && r.videoBitrateBps === 8_000_000)).toBe(false);
    expect(withoutSwap.every((r) => r.videoBitrateBps <= 7_000_000)).toBe(true);

    // WITH the swap (hevcEncodePreferred true + hevc device): the SAME
    // 1080p rung, now 8,000,000 * 0.75 = 6,000,000, SURVIVES the identical
    // 7,000,000 cap — the swap must run BEFORE the cap check for this to
    // hold (binding interpretation constraint 3's BIND).
    const withSwap = buildLadder(media, HEVC_DEVICE, network, makePolicy({ hevcEncodePreferred: true }), 0);
    const survivingTopRung = withSwap.find((r) => r.heightPx === 1080 && r.videoBitrateBps === 6_000_000);
    expect(survivingTopRung).toEqual({ heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 384_000, codec: "hevc" });
    // And the 2160p rung (16,000,000, unswapped) is correctly dropped by the
    // same 7,000,000 cap — proving the 2160p rung is NEVER swapped.
    expect(withSwap.some((r) => r.heightPx === 2160)).toBe(false);
  });
});

describe("buildLadder: degenerate inputs stay total", () => {
  it("empty policy.ladderRungs -> [] (nothing to construct from, never throws)", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 20_000_000 });
    const policy = makePolicy({ ladderRungs: [] });
    expect(buildLadder(media, makeDevice(), makeNetwork(), policy, 0)).toEqual([]);
  });

  it("videoStreamIndex that doesn't resolve to a real stream (defensive) -> permissive height (no crash), still constructs from overallBitrateBps", () => {
    const media = makeMedia([makeVideoStream({ index: 0 })], { overallBitrateBps: 5_000_000 });
    expect(() => buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 99)).not.toThrow();
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), 99);
    // No height cap applied (rule a permissive) — only bitrate rule (b) via
    // the overallBitrateBps fallback narrows the table.
    expect(ladder).toEqual([
      { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });
});

describe("plan(): refused ⇒ ladder [] (STATE.md P3.9(b), full plan() call against a REAL non-empty ladder table)", () => {
  function makePlanInput(overrides: Partial<PlanInput> = {}): PlanInput {
    return {
      media: makeMedia([makeVideoStream({ hdr: "hdr10", height: 1080, width: 1920, bitrateBps: 5_000_000 })], {
        overallBitrateBps: 5_000_000,
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
      }),
      device: makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false }, audio: [{ codec: "aac", maxChannels: 2, passthrough: false }] }),
      network: makeNetwork({ maxBitrateBps: 100_000_000, isLocal: true }),
      policy: makePolicy({ allowToneMapCpu: "tier-gated", tier: 0 }), // real, non-empty ladderRungs (DEFAULT_LADDER)
      caps: { backends: [{ backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 }] },
      selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
      mode: "stream",
      ...overrides,
    };
  }

  it("tone-map-refused-by-policy -> ladder stays [] even though the policy's ladderRungs table would otherwise build real rungs", () => {
    const result = plan(makePlanInput());
    expect(result.decision).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);
    expect(result.video.action).toBe("transcode");
    expect(result.ladder).toEqual([]);
  });

  it("control: the SAME scenario WITHOUT refusal (allowToneMapCpu 'always') gets a REAL non-empty ladder", () => {
    const result = plan(makePlanInput({ policy: makePolicy({ allowToneMapCpu: "always", tier: 0 }) }));
    // why (Phase 3 §11 step 3, Stage G arrival): this scenario's `caps`
    // (software backend only, decode/encode h264) -> Stage G's full-software
    // route always fires `software-fallback:encode`; tier 0 + this stream's
    // 1080p height additionally trips the tier cap (the pre-cap ladder
    // still has 1080p/720p rungs above the 480p ceiling).
    expect(result.reasons.map((r) => r.code)).toEqual([
      "hdr-tone-map-required",
      "software-fallback:encode",
      "software-fallback:tier-capped",
    ]);
    expect(result.video.action).toBe("transcode");
    expect(result.ladder.length).toBeGreaterThan(0);
  });
});
