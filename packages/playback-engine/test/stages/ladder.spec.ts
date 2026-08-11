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
import {
  buildLadder,
  capAdvertisedVariants,
  evaluateBitrate,
  TIER0_MAX_ADVERTISED_VARIANTS,
} from "../../src/stages/ladder.js";
import { plan } from "../../src/plan.js";
import type {
  DeviceProfile,
  DeviceProfileVideoEntry,
  LadderRung,
  MediaInfo,
  NetworkConditions,
  PlanInput,
  ServerPolicy,
  VerifiedCapabilities,
  VideoStream,
} from "../../src/types.js";

// Wave C1 (LD-7): `buildLadder` gained a `caps` parameter (the §7.2 AV1
// eligibility gate is capability-driven) and now returns
// `{ ladder, reasons }` — step (g)'s demotion normalization is the first
// ladder rule that FIRES A REASON (`av1-rung-demoted`, §4). Every
// pre-C1 assertion below is unchanged apart from threading this
// deliberately av1-free caps set through and reading `.ladder`: the whole
// point of the regression pin is that an av1-free input builds exactly the
// ladder it always did.
const CAPS_SOFTWARE_ONLY: VerifiedCapabilities = {
  backends: [
    { backend: "software", decode: ["h264", "hevc", "av1", "vp9"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
  ],
};

/** Software ffmpeg whose libsvtav1 encode self-test passed (§7.3, D4). */
const CAPS_SOFTWARE_AV1: VerifiedCapabilities = {
  backends: [
    { backend: "software", decode: ["h264", "hevc", "av1", "vp9"], encode: ["h264", "hevc", "av1"], toneMap: [], verifiedAtMs: 1 },
  ],
};

/** A real AV1 encode ENGINE present (Arc/DG2-class, RTX 40-class, ...). */
const CAPS_HW_AV1: VerifiedCapabilities = {
  backends: [
    { backend: "nvenc", decode: ["h264", "hevc", "av1"], encode: ["h264", "hevc", "av1"], toneMap: ["cuda"], verifiedAtMs: 1 },
    { backend: "software", decode: ["h264", "hevc", "av1", "vp9"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
  ],
};

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
    openGop: false,
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
    // §2.4 (LD-7): the operator PREFERENCE, passed through verbatim — the
    // capability/tier law lives inside the engine (§7.2), not here.
    av1EncodePreferred: false,
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
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
    expect(ladder).toEqual([
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });

  it("exact-boundary height (source height === a rung's heightPx) keeps that rung — 'exceed' is strict >", () => {
    const media = makeMedia([makeVideoStream({ height: 1080, width: 1920, bitrateBps: 10_000_000 })], {
      overallBitrateBps: 10_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
    expect(ladder.some((r) => r.heightPx === 1080)).toBe(true);
    expect(ladder.some((r) => r.heightPx === 2160)).toBe(false);
  });
});

describe("buildLadder: rule (b) — never exceed source bitrate", () => {
  it("low-bitrate 2160p source drops the two highest rungs by bitrate alone (height passes)", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 5_000_000 })], {
      overallBitrateBps: 5_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
    expect(ladder).toEqual([
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
  });

  it("exact-boundary bitrate (source bitrate === a rung's videoBitrateBps) keeps that rung — strict >", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 4_000_000 })], {
      overallBitrateBps: 4_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, makeDevice(), network, makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, makeDevice(), network, makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, device, network, makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, device, makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, device, network, makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
    expect(ladder).toEqual([{ heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" }]);
  });

  it("network cap (non-local) below even the lowest rung still yields exactly that one rung", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 100_000, isLocal: false });
    const ladder = buildLadder(media, makeDevice(), network, makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
    expect(ladder).toEqual([{ heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" }]);
  });

  it("even a source height below every rung (e.g. 240p) still yields the lowest rung, not []", () => {
    const media = makeMedia([makeVideoStream({ height: 240, width: 426, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, HEVC_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_ONLY, 0).ladder;
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
    const ladder = buildLadder(media, HEVC_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_ONLY, 0).ladder;
    expect(ladder).toEqual(DEFAULT_LADDER);
  });

  it("hevcEncodePreferred=true but device has NO hevc entry -> h264 unchanged", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const policy = makePolicy({ hevcEncodePreferred: true });
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), policy, CAPS_SOFTWARE_ONLY, 0).ladder; // h264-only device
    expect(ladder).toEqual(DEFAULT_LADDER);
  });

  it("ORDERED-SWAP PROOF: a rung survives a network cap ONLY because the swap is applied BEFORE the cap check", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
      overallBitrateBps: 20_000_000,
    });
    const network = makeNetwork({ maxBitrateBps: 7_000_000, isLocal: false });

    // WITHOUT the swap (hevcEncodePreferred false): the 1080p/8,000,000 rung
    // exceeds the 7,000,000 cap and is dropped.
    const withoutSwap = buildLadder(media, HEVC_DEVICE, network, makePolicy({ hevcEncodePreferred: false }), CAPS_SOFTWARE_ONLY, 0).ladder;
    expect(withoutSwap.some((r) => r.heightPx === 1080 && r.videoBitrateBps === 8_000_000)).toBe(false);
    expect(withoutSwap.every((r) => r.videoBitrateBps <= 7_000_000)).toBe(true);

    // WITH the swap (hevcEncodePreferred true + hevc device): the SAME
    // 1080p rung, now 8,000,000 * 0.75 = 6,000,000, SURVIVES the identical
    // 7,000,000 cap — the swap must run BEFORE the cap check for this to
    // hold (binding interpretation constraint 3's BIND).
    const withSwap = buildLadder(media, HEVC_DEVICE, network, makePolicy({ hevcEncodePreferred: true }), CAPS_SOFTWARE_ONLY, 0).ladder;
    const survivingTopRung = withSwap.find((r) => r.heightPx === 1080 && r.videoBitrateBps === 6_000_000);
    expect(survivingTopRung).toEqual({ heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 384_000, codec: "hevc" });
    // And the 2160p rung (16,000,000, unswapped) is correctly dropped by the
    // same 7,000,000 cap — proving the 2160p rung is NEVER swapped.
    expect(withSwap.some((r) => r.heightPx === 2160)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wave C1 (LD-7) — step (f)'s generalized codec selection + step (g)'s
// demotion normalization (docs/PLAYBACK.md §7.1). Both consult src/av1.ts
// and NOTHING else; test/av1.spec.ts owns the predicate itself, these own
// the ladder's USE of it.
// ---------------------------------------------------------------------------

const AV1_ENTRY: DeviceProfileVideoEntry = { ...GENEROUS_H264_ENTRY, codec: "av1", maxLevel: null };
const HEVC_ENTRY: DeviceProfileVideoEntry = { ...GENEROUS_H264_ENTRY, codec: "hevc" };

/** Declares av1 AND hevc AND h264, and can take fmp4 — everything §7.1's
 *  condition 2 asks for. */
const AV1_DEVICE = makeDevice({ video: [GENEROUS_H264_ENTRY, HEVC_ENTRY, AV1_ENTRY] });

function bigSource() {
  return makeMedia([makeVideoStream({ height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
    overallBitrateBps: 20_000_000,
  });
}

describe("buildLadder: rule (f) — AV1 swap (§7.1, precedence av1 > hevc > h264)", () => {
  it("claims every rung below 2160p at ×0.6 exactly, leaving the 2160p rung untouched", () => {
    const policy = makePolicy({ av1EncodePreferred: true, tier: 0 });
    const { ladder, reasons } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder).toEqual([
      { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 1080, videoBitrateBps: 4_800_000, audioBitrateBps: 384_000, codec: "av1" },
      { heightPx: 1080, videoBitrateBps: 2_400_000, audioBitrateBps: 160_000, codec: "av1" },
      { heightPx: 720, videoBitrateBps: 1_800_000, audioBitrateBps: 160_000, codec: "av1" },
      { heightPx: 480, videoBitrateBps: 900_000, audioBitrateBps: 160_000, codec: "av1" },
      { heightPx: 360, videoBitrateBps: 480_000, audioBitrateBps: 160_000, codec: "av1" },
    ]);
    // A rung the SWAP produced already satisfies step (g)'s gates by
    // construction, so no demotion reason can accompany it.
    expect(reasons).toEqual([]);
  });

  it("audioBitrateBps is NEVER scaled — only the video bitrate takes the ×0.6", () => {
    const policy = makePolicy({ av1EncodePreferred: true, tier: 0 });
    const { ladder } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder.map((r) => r.audioBitrateBps)).toEqual(DEFAULT_LADDER.map((r) => r.audioBitrateBps));
  });

  it("PRECEDENCE — with BOTH hevcEncodePreferred and av1EncodePreferred, sub-2160 rungs go av1, not hevc", () => {
    const policy = makePolicy({ av1EncodePreferred: true, hevcEncodePreferred: true, tier: 0 });
    const { ladder } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder.filter((r) => r.heightPx < 2160).every((r) => r.codec === "av1")).toBe(true);
    expect(ladder.filter((r) => r.heightPx < 2160).every((r) => r.videoBitrateBps % 100 === 0)).toBe(true);
    expect(ladder[1]).toEqual({ heightPx: 1080, videoBitrateBps: 4_800_000, audioBitrateBps: 384_000, codec: "av1" });
  });

  it("FALL-THROUGH — rungs the AV1 swap does not claim take the hevc rule VERBATIM (×0.75)", () => {
    // av1EncodePreferred ON but the box has no av1 encoder at all: the AV1
    // swap claims nothing, so the hevc rule runs exactly as it always did.
    const policy = makePolicy({ av1EncodePreferred: true, hevcEncodePreferred: true, tier: 2 });
    const { ladder } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_ONLY, 0);
    expect(ladder).toEqual([
      { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 1080, videoBitrateBps: 6_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 1080, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "hevc" },
      { heightPx: 720, videoBitrateBps: 2_250_000, audioBitrateBps: 160_000, codec: "hevc" },
      { heightPx: 480, videoBitrateBps: 1_125_000, audioBitrateBps: 160_000, codec: "hevc" },
      { heightPx: 360, videoBitrateBps: 600_000, audioBitrateBps: 160_000, codec: "hevc" },
    ]);
  });

  it("TIER-0 LENS — an opted-in T0 box with SOFTWARE-only av1 builds a ladder byte-identical to pre-C1", () => {
    const policy = makePolicy({ av1EncodePreferred: true, tier: 0 });
    const { ladder, reasons } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_AV1, 0);
    expect(ladder).toEqual(DEFAULT_LADDER);
    expect(reasons).toEqual([]);
  });

  it("TIER-0 LENS — an opted-in T0 box WITH hardware av1 does swap (the escape hatch is real hardware)", () => {
    const policy = makePolicy({ av1EncodePreferred: true, tier: 0 });
    const { ladder } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder.some((r) => r.codec === "av1")).toBe(true);
  });

  it("tier 1 + software av1 DOES swap (the permitted software fallback)", () => {
    const policy = makePolicy({ av1EncodePreferred: true, tier: 1 });
    const { ladder } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_AV1, 0);
    expect(ladder.filter((r) => r.heightPx < 2160).every((r) => r.codec === "av1")).toBe(true);
  });

  it("device declares no av1 entry -> no swap, even at tier 2 with hardware av1", () => {
    const policy = makePolicy({ av1EncodePreferred: true, tier: 2 });
    const { ladder } = buildLadder(bigSource(), makeDevice(), makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder).toEqual(DEFAULT_LADDER);
  });

  it("device cannot take fmp4 -> no swap (AV1 has no MPEG-TS stream_type, §6 interp. M)", () => {
    const tsDevice = makeDevice({
      video: [GENEROUS_H264_ENTRY, AV1_ENTRY],
      hls: { container: "ts", supportsFmp4: false, lowLatency: false },
    });
    const policy = makePolicy({ av1EncodePreferred: true, tier: 2 });
    const { ladder } = buildLadder(bigSource(), tsDevice, makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder).toEqual(DEFAULT_LADDER);
  });

  it("ORDERED-SWAP PROOF (av1): a rung survives a cap ONLY because ×0.6 ran BEFORE the cap check", () => {
    const network = makeNetwork({ maxBitrateBps: 5_000_000, isLocal: false });
    const off = buildLadder(bigSource(), AV1_DEVICE, network, makePolicy({ av1EncodePreferred: false }), CAPS_HW_AV1, 0).ladder;
    expect(off.some((r) => r.heightPx === 1080 && r.videoBitrateBps === 8_000_000)).toBe(false);

    const on = buildLadder(bigSource(), AV1_DEVICE, network, makePolicy({ av1EncodePreferred: true }), CAPS_HW_AV1, 0).ladder;
    expect(on[0]).toEqual({ heightPx: 1080, videoBitrateBps: 4_800_000, audioBitrateBps: 384_000, codec: "av1" });
    // The 2160p rung (16,000,000, never swapped) is still dropped by the
    // same cap — proving the 2160p rung stays out of the AV1 swap.
    expect(on.some((r) => r.heightPx === 2160)).toBe(false);
  });
});

describe("buildLadder: rule (g) — AV1 demotion normalization (§7.1, demote-don't-drop)", () => {
  const EXPLICIT_AV1_TABLE: LadderRung[] = [
    { heightPx: 2160, videoBitrateBps: 10_000_000, audioBitrateBps: 384_000, codec: "av1" },
    { heightPx: 1080, videoBitrateBps: 5_000_000, audioBitrateBps: 384_000, codec: "av1" },
    { heightPx: 720, videoBitrateBps: 2_000_000, audioBitrateBps: 160_000, codec: "h264" },
  ];

  it("condition 1 does NOT apply — an EXPLICIT av1 rung survives with av1EncodePreferred FALSE", () => {
    const policy = makePolicy({ ladderRungs: EXPLICIT_AV1_TABLE, av1EncodePreferred: false, tier: 2 });
    const { ladder, reasons } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder).toEqual(EXPLICIT_AV1_TABLE);
    expect(reasons).toEqual([]);
  });

  it("an explicit 2160p av1 rung is expressible — the swap never claims 2160, but (g) never demotes an admissible one either", () => {
    const policy = makePolicy({ ladderRungs: EXPLICIT_AV1_TABLE, av1EncodePreferred: true, tier: 0 });
    const { ladder } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder[0]).toEqual({ heightPx: 2160, videoBitrateBps: 10_000_000, audioBitrateBps: 384_000, codec: "av1" });
  });

  it("cause tier0-no-hw-av1: T0 + software-only av1 demotes every av1 rung to hevc at the VERBATIM bitrate", () => {
    const policy = makePolicy({ ladderRungs: EXPLICIT_AV1_TABLE, tier: 0 });
    const { ladder, reasons } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_AV1, 0);
    expect(ladder).toEqual([
      { heightPx: 2160, videoBitrateBps: 10_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 1080, videoBitrateBps: 5_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 720, videoBitrateBps: 2_000_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
    expect(reasons).toEqual([
      { code: "av1-rung-demoted", detail: "cause=tier0-no-hw-av1 demotedTo=hevc heightPx=2160" },
      { code: "av1-rung-demoted", detail: "cause=tier0-no-hw-av1 demotedTo=hevc heightPx=1080" },
    ]);
  });

  it("cause no-av1-encoder: tier 2 with no av1 encoder anywhere", () => {
    const policy = makePolicy({ ladderRungs: EXPLICIT_AV1_TABLE, tier: 2 });
    const { reasons } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_ONLY, 0);
    expect(reasons.map((r) => r.detail)).toEqual([
      "cause=no-av1-encoder demotedTo=hevc heightPx=2160",
      "cause=no-av1-encoder demotedTo=hevc heightPx=1080",
    ]);
  });

  it("cause device-no-av1: a device with no av1 entry demotes to h264 when it has no hevc entry either", () => {
    const policy = makePolicy({ ladderRungs: EXPLICIT_AV1_TABLE, tier: 2 });
    const { ladder, reasons } = buildLadder(bigSource(), makeDevice(), makeNetwork(), policy, CAPS_HW_AV1, 0);
    expect(ladder.every((r) => r.codec === "h264")).toBe(true);
    expect(reasons.map((r) => r.detail)).toEqual([
      "cause=device-no-av1 demotedTo=h264 heightPx=2160",
      "cause=device-no-av1 demotedTo=h264 heightPx=1080",
    ]);
  });

  it("DEMOTE-DON'T-DROP: the rung COUNT and every heightPx are preserved", () => {
    const policy = makePolicy({ ladderRungs: EXPLICIT_AV1_TABLE, tier: 0 });
    const { ladder } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_AV1, 0);
    expect(ladder.map((r) => r.heightPx)).toEqual([2160, 1080, 720]);
  });

  it("a demotion that duplicates an existing rung is dropped, and the caps STILL run on the demoted values", () => {
    const table: LadderRung[] = [
      { heightPx: 1080, videoBitrateBps: 5_000_000, audioBitrateBps: 384_000, codec: "av1" },
      { heightPx: 1080, videoBitrateBps: 5_000_000, audioBitrateBps: 384_000, codec: "hevc" },
    ];
    const policy = makePolicy({ ladderRungs: table, tier: 0 });
    const { ladder, reasons } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), policy, CAPS_SOFTWARE_AV1, 0);
    expect(ladder).toEqual([{ heightPx: 1080, videoBitrateBps: 5_000_000, audioBitrateBps: 384_000, codec: "hevc" }]);
    expect(reasons).toHaveLength(1);
  });

  it("(g) runs BEFORE the cap filters: a demoted rung is judged on its VERBATIM (unscaled) bitrate", () => {
    const table: LadderRung[] = [{ heightPx: 1080, videoBitrateBps: 9_000_000, audioBitrateBps: 384_000, codec: "av1" }];
    const policy = makePolicy({ ladderRungs: table, tier: 0 });
    const network = makeNetwork({ maxBitrateBps: 6_000_000, isLocal: false });
    const { ladder } = buildLadder(bigSource(), AV1_DEVICE, network, policy, CAPS_SOFTWARE_AV1, 0);
    // Kept only by rule (e)'s keep-lowest rescue — i.e. rule (c) really did
    // evaluate 9,000,000 (not 9,000,000 × anything) against the 6 Mbps cap.
    expect(ladder).toEqual([{ heightPx: 1080, videoBitrateBps: 9_000_000, audioBitrateBps: 384_000, codec: "hevc" }]);
  });

  it("an av1-free table NEVER fires a demotion reason, whatever the caps/tier", () => {
    for (const caps of [CAPS_SOFTWARE_ONLY, CAPS_SOFTWARE_AV1, CAPS_HW_AV1]) {
      for (const tier of [0, 1, 2] as const) {
        const { reasons } = buildLadder(bigSource(), AV1_DEVICE, makeNetwork(), makePolicy({ tier }), caps, 0);
        expect(reasons, `tier=${tier}`).toEqual([]);
      }
    }
  });
});

describe("buildLadder: degenerate inputs stay total", () => {
  it("empty policy.ladderRungs -> [] (nothing to construct from, never throws)", () => {
    const media = makeMedia([makeVideoStream()], { overallBitrateBps: 20_000_000 });
    const policy = makePolicy({ ladderRungs: [] });
    expect(buildLadder(media, makeDevice(), makeNetwork(), policy, CAPS_SOFTWARE_ONLY, 0).ladder).toEqual([]);
  });

  it("videoStreamIndex that doesn't resolve to a real stream (defensive) -> permissive height (no crash), still constructs from overallBitrateBps", () => {
    const media = makeMedia([makeVideoStream({ index: 0 })], { overallBitrateBps: 5_000_000 });
    expect(() => buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 99).ladder).not.toThrow();
    const ladder = buildLadder(media, makeDevice(), makeNetwork(), makePolicy(), CAPS_SOFTWARE_ONLY, 99).ladder;
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

// ---------------------------------------------------------------------------
// Wave C2 (LD-6 under LD-16) — step (h)'s Tier-0 advertised-variant cap
// (docs/PLAYBACK.md §7.5). A FINAL-ASSEMBLY trim, so it is tested here as a
// pure function AND through plan() (where it really runs, after Stage G).
// ---------------------------------------------------------------------------

describe("capAdvertisedVariants: step (h) — Tier-0 advertised-variant cap (§7.5)", () => {
  const SIX: LadderRung[] = DEFAULT_LADDER;

  it("TIER0_MAX_ADVERTISED_VARIANTS is the law constant 3 (owner-decision V1 — NOT a ServerPolicy knob)", () => {
    expect(TIER0_MAX_ADVERTISED_VARIANTS).toBe(3);
  });

  it("T0 + 6 rungs -> exactly 3, by the keep rule top/geometric-mid/floor, array order preserved", () => {
    const { ladder, reasons } = capAdvertisedVariants(SIX, 0);
    // geometric mid of (16M, 0.8M) is sqrt(16e6*0.8e6) ≈ 3.578M; the
    // candidate minimizing |ln(v) − ln(3.578M)| is the 1080p/4M rung.
    expect(ladder).toEqual([
      { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
    expect(reasons.map((r) => r.code)).toEqual(["ladder-variant-capped"]);
  });

  it("the spec's own worked example (§7.5): a 1080p source's 5 surviving rungs keep 8M / 3M / 0.8M", () => {
    const fiveRung = SIX.filter((r) => r.heightPx <= 1080);
    const { ladder } = capAdvertisedVariants(fiveRung, 0);
    expect(ladder.map((r) => r.videoBitrateBps)).toEqual([8_000_000, 3_000_000, 800_000]);
  });

  it("fires the reason exactly ONCE (single-firing, owner-decision V2) with EVERY dropped rung in the detail", () => {
    const { reasons } = capAdvertisedVariants(SIX, 0);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.code).toBe("ladder-variant-capped");
    // The three dropped rungs, in table order — 1080p/8M, 720p/3M, 480p/1.5M.
    expect(reasons[0]!.detail).toBe("cap=3 dropped=1080p@8000000,720p@3000000,480p@1500000");
  });

  it("T0 + exactly 3 rungs -> UNTOUCHED, and no reason fires (byte-identical plans, §7.5)", () => {
    const three = [SIX[1]!, SIX[3]!, SIX[5]!];
    const { ladder, reasons } = capAdvertisedVariants(three, 0);
    expect(ladder).toEqual(three);
    expect(reasons).toEqual([]);
  });

  it("T0 + 1 or 2 rungs (the software-route tier-capped shape) -> untouched, no reason", () => {
    for (const n of [1, 2]) {
      const shortLadder = SIX.slice(0, n);
      const { ladder, reasons } = capAdvertisedVariants(shortLadder, 0);
      expect(ladder, `n=${n}`).toEqual(shortLadder);
      expect(reasons, `n=${n}`).toEqual([]);
    }
  });

  it("Tier 1 and Tier 2 are NEVER trimmed (owner-decision V6 — the law constrains Tier-0 only)", () => {
    for (const tier of [1, 2] as const) {
      const { ladder, reasons } = capAdvertisedVariants(SIX, tier);
      expect(ladder, `tier=${tier}`).toEqual(SIX);
      expect(reasons, `tier=${tier}`).toEqual([]);
    }
  });

  it("keeps the top rung, so topRungOf (and therefore video.targetCodec) is unchanged by the trim", () => {
    const topOf = (l: readonly LadderRung[]): LadderRung =>
      l.reduce((max, r) => (r.videoBitrateBps > max.videoBitrateBps ? r : max));
    expect(capAdvertisedVariants(SIX, 0).ladder[0]).toEqual(topOf(SIX));
  });

  it("keeps the FLOOR rung — the rescue rung the network-cap filter also refuses to drop", () => {
    const { ladder } = capAdvertisedVariants(SIX, 0);
    expect(ladder[ladder.length - 1]).toEqual(SIX[SIX.length - 1]);
  });

  it("mid-rung tie breaks toward the LOWER-bitrate candidate (§7.5's stated tiebreak)", () => {
    // top 1,000,000 / floor 10,000 -> geometric mid = 100,000 exactly.
    // 50,000 and 200,000 are equidistant in log space (factor 2 either way).
    const tied: LadderRung[] = [
      { heightPx: 1080, videoBitrateBps: 1_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 720, videoBitrateBps: 200_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 480, videoBitrateBps: 50_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 10_000, audioBitrateBps: 160_000, codec: "h264" },
    ];
    expect(capAdvertisedVariants(tied, 0).ladder.map((r) => r.videoBitrateBps)).toEqual([1_000_000, 50_000, 10_000]);
  });

  it("array order is PRESERVED — trimming removes elements, never reorders (§7.5)", () => {
    // A deliberately unsorted policy table: the kept subset must come back
    // in the SAME relative order it appeared in, not sorted by bitrate.
    const unsorted: LadderRung[] = [
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
    ];
    const { ladder } = capAdvertisedVariants(unsorted, 0);
    expect(ladder.map((r) => r.heightPx)).toEqual([360, 2160, 1080]);
  });

  it("stays TOTAL on degenerate bitrates (a 0-bps rung never produces NaN/-Infinity)", () => {
    const degenerate: LadderRung[] = [
      { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 0, audioBitrateBps: 160_000, codec: "h264" },
    ];
    const { ladder } = capAdvertisedVariants(degenerate, 0);
    expect(ladder).toHaveLength(3);
    expect(ladder.every((r) => Number.isFinite(r.videoBitrateBps))).toBe(true);
  });

  it("is PURE — the input array and its rungs are never mutated", () => {
    const input = structuredClone(SIX);
    const snapshot = structuredClone(SIX);
    capAdvertisedVariants(input, 0);
    expect(input).toEqual(snapshot);
  });
});

describe("plan(): step (h) runs at final assembly, AFTER Stage G (§7.5)", () => {
  function makeCapPlanInput(overrides: Partial<PlanInput> = {}): PlanInput {
    return {
      media: makeMedia([makeVideoStream({ codec: "vp9", height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
        overallBitrateBps: 20_000_000,
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
      device: makeDevice(),
      network: makeNetwork(),
      policy: makePolicy({ tier: 0 }),
      caps: {
        backends: [
          {
            backend: "nvenc",
            decode: ["h264", "hevc", "vp9"],
            encode: ["h264", "hevc"],
            toneMap: ["cuda"],
            verifiedAtMs: 1,
          },
        ],
      },
      selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
      mode: "stream",
      ...overrides,
    };
  }

  it("a T0 transcode whose FINAL ladder exceeds 3 rungs is trimmed to exactly 3 and reports the reason LAST", () => {
    const result = plan(makeCapPlanInput());
    expect(result.decision).toBe("transcode");
    expect(result.ladder).toHaveLength(3);
    // The cap runs after Stage G, so its reason lands after the routing
    // reason (docs/PLAYBACK.md §4 "ordered by stage").
    expect(result.reasons[result.reasons.length - 1]!.code).toBe("ladder-variant-capped");
  });

  it("targetCodec is IDENTICAL with and without the trim (the keep rule preserves topRungOf)", () => {
    const t0 = plan(makeCapPlanInput());
    const t1 = plan(makeCapPlanInput({ policy: makePolicy({ tier: 1 }) }));
    expect(t1.ladder.length).toBeGreaterThan(3); // T1 is never trimmed (V6)
    expect(t0.video.targetCodec).toBe(t1.video.targetCodec);
    expect(t0.ffmpegArgs).toEqual(t1.ffmpegArgs); // args target the top rung, which survived
  });

  it("the trimmed ladder is a SUBSEQUENCE of the untrimmed one (nothing invented, nothing reordered)", () => {
    const t0 = plan(makeCapPlanInput()).ladder;
    const t1 = plan(makeCapPlanInput({ policy: makePolicy({ tier: 1 }) })).ladder;
    let cursor = 0;
    for (const rung of t0) {
      cursor = t1.findIndex((r, i) => i >= cursor && r.videoBitrateBps === rung.videoBitrateBps) + 1;
      expect(cursor, `rung ${rung.videoBitrateBps} not found in order`).toBeGreaterThan(0);
    }
  });

  it("a REFUSED plan never reports the cap reason (its ladder is discarded entirely)", () => {
    const refused = plan(
      makeCapPlanInput({
        media: makeMedia([makeVideoStream({ hdr: "hdr10", height: 2160, width: 3840, bitrateBps: 20_000_000 })], {
          overallBitrateBps: 20_000_000,
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
        caps: { backends: [{ backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 }] },
      }),
    );
    expect(refused.ladder).toEqual([]);
    expect(refused.reasons.map((r) => r.code)).not.toContain("ladder-variant-capped");
  });
});
