// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/stages/hardware.ts (Stage G — docs/PLAYBACK.md §3/§8.3,
 * Phase 3 §11 step 3). Lives in the package's NORMAL (non-matrix) test
 * project (vitest.config.ts's `include` covers `test/**\/*.spec.ts`),
 * separate from matrix/'s case-file burn-up.
 *
 * Coverage (per this step's instructions): selection rules (i)/(ii)/(iii)
 * including the hw-only restriction on rule (i)/(ii), the tone-map
 * fall-through (both within rule (i) and across into rule (ii)/(iii)), the
 * §8.3 method preference table (videotoolbox, nvenc/cuda, qsv/vaapi
 * opencl-else-vulkan, cpu-zscale policy gating across all three
 * `allowToneMapCpu` values and both tier boundaries), the tier-cap grid
 * (T0+1080p/2160p capped, T0+720p uncapped, T1/T2 uncapped, hw routes
 * uncapped, empty-filter keep-lowest rescue, and the "already-capped, no
 * actual change" no-op case), the platform-blind array-order proof, the
 * decode-only-backend defensive guard, and totality on defensive/degenerate
 * inputs (unresolved stream, empty ladder).
 *
 * Wave C1 adds §7.2's Stage-G residual guard in BOTH its arms: the tier-0
 * arm (unreachability leg 4) and — from the C1 review's finding 1 — the
 * verified-capabilities arm, which demotes av1 rungs on ANY rule-(iii)
 * route whose software row never probe-verified av1 encode.
 */
import { describe, expect, it } from "vitest";
import { routeHardware } from "../../src/stages/hardware.js";
import type {
  DeviceProfile,
  DeviceProfileVideoEntry,
  LadderRung,
  MediaInfo,
  ServerPolicy,
  VerifiedCapabilities,
  VideoStream,
} from "../../src/types.js";

/** Wave C1 (LD-7): `routeHardware` gained a `device` parameter — §7.2's
 *  Stage-G residual guard demotes av1 rungs through src/av1.ts's shared
 *  primitive, which decides hevc-vs-h264 from `device.video`. Every pre-C1
 *  assertion below is unchanged apart from threading this h264-only device
 *  through: with no av1 rung anywhere in those ladders, the guard is a
 *  structural no-op. */
function videoEntry(codec: DeviceProfileVideoEntry["codec"]): DeviceProfileVideoEntry {
  return {
    codec,
    maxProfile: null,
    maxLevel: null,
    maxBitDepth: 10,
    maxWidth: 3840,
    maxHeight: 2160,
    maxFrameRate: 60,
    maxBitrateBps: null,
  };
}

function makeDevice(video: DeviceProfileVideoEntry[]): DeviceProfile {
  return {
    profileId: "hardware-spec-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video,
    hdr: { hdr10: true, hlg: true, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 6, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

const DEVICE_H264 = makeDevice([videoEntry("h264")]);
const DEVICE_AV1_HEVC = makeDevice([videoEntry("h264"), videoEntry("hevc"), videoEntry("av1")]);

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

function makeMedia(video: VideoStream[]): MediaInfo {
  return {
    fileId: "file-1",
    container: "mp4",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: video[0]?.bitrateBps ?? 5_000_000,
    video,
    audio: [],
    subtitle: [],
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
    segmentDurationSec: 6,
    hevcEncodePreferred: false,
    av1EncodePreferred: false,
    ...overrides,
  };
}

const DEFAULT_LADDER: LadderRung[] = [
  { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
  { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" },
  { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
  { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
];

const H264_ONLY_LADDER: LadderRung[] = DEFAULT_LADDER.slice(1); // no 2160p/hevc rung

const SOFTWARE_ONLY: VerifiedCapabilities = {
  backends: [{ backend: "software", decode: ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 }],
};

const FULL_HW: VerifiedCapabilities = {
  backends: [
    { backend: "nvenc", decode: ["h264", "hevc", "av1", "vp9", "mpeg2"], encode: ["h264", "hevc", "av1"], toneMap: ["cuda"], verifiedAtMs: 1 },
    { backend: "software", decode: ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
  ],
};

const ENCODE_ONLY: VerifiedCapabilities = {
  backends: [
    { backend: "nvenc", decode: [], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
    { backend: "software", decode: ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
  ],
};

describe("routeHardware: rule (i) — hardware decode+encode match", () => {
  it("full-hw covers h264 decode + h264 target -> hw-encoder-selected:nvenc, no toneMap when not required", () => {
    const media = makeMedia([makeVideoStream()]);
    const result = routeHardware(media, DEVICE_H264, 0, FULL_HW, makePolicy(), H264_ONLY_LADDER, false);
    expect(result.encoder).toBe("nvenc");
    expect(result.toneMap).toBeUndefined();
    expect(result.reasons).toEqual([
      { code: "hw-encoder-selected:nvenc", streamIndex: 0, detail: "decode+encode via nvenc" },
    ]);
    expect(result.ladder).toEqual(H264_ONLY_LADDER);
  });

  it("HW-ONLY RESTRICTION (rule i): a literal reading would let the bare `software` entry satisfy 'covers both' — software-only caps must NEVER produce hw-encoder-selected:software", () => {
    const media = makeMedia([makeVideoStream()]);
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 1 }), H264_ONLY_LADDER, false);
    expect(result.encoder).toBe("software");
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
    expect(result.reasons.every((r) => !r.code.startsWith("hw-encoder-selected"))).toBe(true);
  });

  it("multi-codec targets: a candidate must cover EVERY distinct target codec, not just one", () => {
    const media = makeMedia([makeVideoStream()]);
    const mixedLadder: LadderRung[] = [DEFAULT_LADDER[0]!, DEFAULT_LADDER[2]!]; // hevc(2160) + h264(1080)
    const result = routeHardware(media, DEVICE_H264, 0, FULL_HW, makePolicy(), mixedLadder, false);
    expect(result.encoder).toBe("nvenc"); // covers both h264 and hevc
  });

  it("a candidate covering decode but only SOME target codecs is rejected for rule (i)", () => {
    const media = makeMedia([makeVideoStream()]);
    const capsHevcOnlyEncode: VerifiedCapabilities = {
      backends: [
        { backend: "nvenc", decode: ["h264"], encode: ["hevc"], toneMap: [], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    const result = routeHardware(media, DEVICE_H264, 0, capsHevcOnlyEncode, makePolicy({ tier: 1 }), H264_ONLY_LADDER, false);
    // nvenc's encode ([hevc]) doesn't cover the h264-only target set -> rule
    // (i) fails; rule (ii) also fails the SAME encode-coverage check -> full
    // software.
    expect(result.encoder).toBe("software");
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });
});

describe("routeHardware: rule (ii) — encode-only hardware, decode falls to software", () => {
  it("encode-only's nvenc has no verified decode -> software-fallback:decode, encoder stays nvenc", () => {
    const media = makeMedia([makeVideoStream()]);
    const result = routeHardware(media, DEVICE_H264, 0, ENCODE_ONLY, makePolicy(), H264_ONLY_LADDER, false);
    expect(result.encoder).toBe("nvenc");
    expect(result.reasons).toEqual([
      { code: "software-fallback:decode", streamIndex: 0, detail: "encode via nvenc, decode via software" },
    ]);
  });

  it("rule (ii) ALSO requires the software backend to actually decode the source codec", () => {
    const media = makeMedia([makeVideoStream({ codec: "vc1" })]);
    const capsNoVc1Anywhere: VerifiedCapabilities = {
      backends: [
        { backend: "nvenc", decode: [], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 }, // no vc1
      ],
    };
    const result = routeHardware(media, DEVICE_H264, 0, capsNoVc1Anywhere, makePolicy({ tier: 1 }), H264_ONLY_LADDER, false);
    // Neither nvenc (no decode at all) nor software (doesn't decode vc1)
    // can actually decode vc1 -> falls all the way to rule (iii), which is
    // unconditional regardless.
    expect(result.encoder).toBe("software");
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });
});

describe("routeHardware: rule (iii) — full software, the unconditional last resort", () => {
  it("no caps.backends entry at all -> still resolves totally (encoder='software', never throws)", () => {
    const media = makeMedia([makeVideoStream()]);
    const emptyCaps: VerifiedCapabilities = { backends: [] };
    expect(() => routeHardware(media, DEVICE_H264, 0, emptyCaps, makePolicy({ tier: 1 }), H264_ONLY_LADDER, false)).not.toThrow();
    const result = routeHardware(media, DEVICE_H264, 0, emptyCaps, makePolicy({ tier: 1 }), H264_ONLY_LADDER, false);
    expect(result.encoder).toBe("software");
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });

  it("'unknown' source codec never matches ANY backend's decode list -> full software", () => {
    const media = makeMedia([makeVideoStream({ codec: "unknown" })]);
    const result = routeHardware(media, DEVICE_H264, 0, FULL_HW, makePolicy({ tier: 1 }), H264_ONLY_LADDER, false);
    expect(result.encoder).toBe("software");
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });
});

describe("routeHardware: tone-map fall-through (binding interpretation 3)", () => {
  const hwNoTonemap: VerifiedCapabilities = {
    backends: [
      { backend: "nvenc", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
      { backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
    ],
  };

  it("a candidate covering decode+encode but lacking a usable method falls through past rule (i) AND rule (ii) to full software", () => {
    const media = makeMedia([makeVideoStream()]);
    const result = routeHardware(media, DEVICE_H264, 0, hwNoTonemap, makePolicy({ allowToneMapCpu: "always", tier: 1 }), H264_ONLY_LADDER, true);
    expect(result.encoder).toBe("software");
    expect(result.toneMap).toBe("cpu-zscale");
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });

  it("fall-through within rule (i) lands on the NEXT hw candidate in array order, not straight to software", () => {
    const dualHw: VerifiedCapabilities = {
      backends: [
        { backend: "qsv", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
        { backend: "nvenc", decode: ["h264"], encode: ["h264"], toneMap: ["cuda"], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    const media = makeMedia([makeVideoStream()]);
    const result = routeHardware(media, DEVICE_H264, 0, dualHw, makePolicy({ allowToneMapCpu: "always" }), H264_ONLY_LADDER, true);
    expect(result.encoder).toBe("nvenc");
    expect(result.toneMap).toBe("cuda");
    expect(result.reasons.map((r) => r.code)).toEqual(["hw-encoder-selected:nvenc"]);
  });

  it("when tone-map is NOT required, video.toneMap stays unset even on a hw route with a real method available", () => {
    const media = makeMedia([makeVideoStream()]);
    const result = routeHardware(media, DEVICE_H264, 0, FULL_HW, makePolicy(), H264_ONLY_LADDER, false);
    expect(result.toneMap).toBeUndefined();
  });
});

describe("routeHardware: §8.3 tone-map method preference table", () => {
  it("videotoolbox -> 'videotoolbox'", () => {
    const caps: VerifiedCapabilities = {
      backends: [{ backend: "videotoolbox", decode: ["h264"], encode: ["h264"], toneMap: ["videotoolbox"], verifiedAtMs: 1 }],
    };
    const result = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, caps, makePolicy(), H264_ONLY_LADDER, true);
    expect(result.encoder).toBe("videotoolbox");
    expect(result.toneMap).toBe("videotoolbox");
  });

  it("nvenc -> 'cuda'", () => {
    const result = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, FULL_HW, makePolicy(), H264_ONLY_LADDER, true);
    expect(result.encoder).toBe("nvenc");
    expect(result.toneMap).toBe("cuda");
  });

  it("qsv -> 'opencl' when BOTH opencl and vulkan are verified (preference order, not merely 'some method exists')", () => {
    const caps: VerifiedCapabilities = {
      backends: [{ backend: "qsv", decode: ["h264"], encode: ["h264"], toneMap: ["opencl", "vulkan"], verifiedAtMs: 1 }],
    };
    const result = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, caps, makePolicy(), H264_ONLY_LADDER, true);
    expect(result.toneMap).toBe("opencl");
  });

  it("qsv -> 'vulkan' (the ELSE half) when opencl is absent", () => {
    const caps: VerifiedCapabilities = {
      backends: [{ backend: "qsv", decode: ["h264"], encode: ["h264"], toneMap: ["vulkan"], verifiedAtMs: 1 }],
    };
    const result = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, caps, makePolicy(), H264_ONLY_LADDER, true);
    expect(result.toneMap).toBe("vulkan");
  });

  it("vaapi mirrors qsv's opencl-else-vulkan preference", () => {
    const capsOpencl: VerifiedCapabilities = {
      backends: [{ backend: "vaapi", decode: ["h264"], encode: ["h264"], toneMap: ["opencl", "vulkan"], verifiedAtMs: 1 }],
    };
    expect(routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, capsOpencl, makePolicy(), H264_ONLY_LADDER, true).toneMap).toBe("opencl");

    const capsVulkanOnly: VerifiedCapabilities = {
      backends: [{ backend: "vaapi", decode: ["h264"], encode: ["h264"], toneMap: ["vulkan"], verifiedAtMs: 1 }],
    };
    expect(routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, capsVulkanOnly, makePolicy(), H264_ONLY_LADDER, true).toneMap).toBe(
      "vulkan",
    );
  });

  it("amf and d3d11va are ABSENT from the table -> never satisfy a tone-map requirement, even if they declare one", () => {
    const caps: VerifiedCapabilities = {
      backends: [
        { backend: "amf", decode: ["h264"], encode: ["h264"], toneMap: ["opencl"], verifiedAtMs: 1 }, // hypothetical, never in real fixtures
        { backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    const result = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, caps, makePolicy({ allowToneMapCpu: "always" }), H264_ONLY_LADDER, true);
    // amf is skipped in both rule (i) and (ii) despite covering decode+encode
    // AND (hypothetically) declaring a tone-map array — falls to software.
    expect(result.encoder).toBe("software");
    expect(result.toneMap).toBe("cpu-zscale");
  });

  describe("software -> 'cpu-zscale' iff allowToneMapCpu resolves true", () => {
    it("'always' resolves true regardless of tier", () => {
      for (const tier of [0, 1, 2] as const) {
        const result = routeHardware(
          makeMedia([makeVideoStream()]),
          DEVICE_H264,
          0,
          SOFTWARE_ONLY,
          makePolicy({ allowToneMapCpu: "always", tier }),
          H264_ONLY_LADDER,
          true,
        );
        expect(result.toneMap, `tier=${tier}`).toBe("cpu-zscale");
      }
    });

    it("'never' never resolves true, regardless of tier", () => {
      for (const tier of [0, 1, 2] as const) {
        const result = routeHardware(
          makeMedia([makeVideoStream()]),
          DEVICE_H264,
          0,
          SOFTWARE_ONLY,
          makePolicy({ allowToneMapCpu: "never", tier }),
          H264_ONLY_LADDER,
          true,
        );
        expect(result.toneMap, `tier=${tier}`).toBeUndefined();
      }
    });

    it("'tier-gated' resolves false ONLY at tier 0, true at tier 1 and 2", () => {
      const t0 = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ allowToneMapCpu: "tier-gated", tier: 0 }), H264_ONLY_LADDER, true);
      expect(t0.toneMap).toBeUndefined();
      const t1 = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ allowToneMapCpu: "tier-gated", tier: 1 }), H264_ONLY_LADDER, true);
      expect(t1.toneMap).toBe("cpu-zscale");
      const t2 = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ allowToneMapCpu: "tier-gated", tier: 2 }), H264_ONLY_LADDER, true);
      expect(t2.toneMap).toBe("cpu-zscale");
    });

    it("when tone-map is NOT required, no toneMap is ever set on the software route regardless of policy", () => {
      const result = routeHardware(makeMedia([makeVideoStream()]), DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ allowToneMapCpu: "always" }), H264_ONLY_LADDER, false);
      expect(result.toneMap).toBeUndefined();
    });
  });
});

describe("routeHardware: tier-cap grid (docs/PLAYBACK.md §8.3, only on the rule-iii software route)", () => {
  it("T0 + 1080p+ source + software route -> capped to <=480p rungs, tier-capped reason fires", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 0 }), DEFAULT_LADDER, false);
    expect(result.ladder).toEqual([
      { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" },
      { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" },
    ]);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode", "software-fallback:tier-capped"]);
  });

  it("T0 + 2160p source + software route -> ALSO capped (height boundary is >=1080, not merely '===1080')", () => {
    const media = makeMedia([makeVideoStream({ height: 2160, width: 3840 })]);
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 0 }), DEFAULT_LADDER, false);
    expect(result.ladder.every((r) => r.heightPx <= 480)).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain("software-fallback:tier-capped");
  });

  it("T0 + 720p source (< 1080) + software route -> NO cap at all", () => {
    const media = makeMedia([makeVideoStream({ height: 720, width: 1280 })]);
    const ladder720: LadderRung[] = [DEFAULT_LADDER[3]!, DEFAULT_LADDER[4]!, DEFAULT_LADDER[5]!];
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 0 }), ladder720, false);
    expect(result.ladder).toEqual(ladder720);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });

  it("T1 + 1080p+ source + software route -> NO cap (tier gate is T0-only)", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 1 }), DEFAULT_LADDER, false);
    expect(result.ladder).toEqual(DEFAULT_LADDER);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });

  it("T2 + 1080p+ source + software route -> NO cap", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 2 }), DEFAULT_LADDER, false);
    expect(result.ladder).toEqual(DEFAULT_LADDER);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });

  it("T0 + 1080p+ source + a HARDWARE route (rule i) -> NO cap, ever", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_H264, 0, FULL_HW, makePolicy({ tier: 0 }), DEFAULT_LADDER, false);
    expect(result.encoder).toBe("nvenc");
    expect(result.ladder).toEqual(DEFAULT_LADDER);
    expect(result.reasons.map((r) => r.code)).toEqual(["hw-encoder-selected:nvenc"]);
  });

  it("empty-filter keep-lowest: when EVERY rung is above 480p, keep exactly the lowest (post-swap) rung", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const above480Only: LadderRung[] = [
      { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" },
      { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" },
    ];
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 0 }), above480Only, false);
    expect(result.ladder).toEqual([{ heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" }]);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode", "software-fallback:tier-capped"]);
  });

  it("NO-OP case: the pre-cap ladder is ALREADY a single rung above 480p (nothing else survived Stage F) -> rescue lands on the SAME rung, tier-capped does NOT fire", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const singleAbove480: LadderRung[] = [{ heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" }];
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 0 }), singleAbove480, false);
    expect(result.ladder).toEqual(singleAbove480);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });

  it("empty ladder in -> empty ladder out, no tier-capped reason (nothing to remove)", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_H264, 0, SOFTWARE_ONLY, makePolicy({ tier: 0 }), [], false);
    expect(result.ladder).toEqual([]);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });
});

describe("routeHardware: platform-blindness (design law 4) — array order is honored, never re-sorted", () => {
  it("the FIRST array entry wins even when a LATER entry could also serve the same route", () => {
    const media = makeMedia([makeVideoStream()]);
    const capsThreeEqual: VerifiedCapabilities = {
      backends: [
        { backend: "nvenc", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
        { backend: "qsv", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
        { backend: "vaapi", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    expect(routeHardware(media, DEVICE_H264, 0, capsThreeEqual, makePolicy(), H264_ONLY_LADDER, false).encoder).toBe("nvenc");
  });

  it("REORDERING the SAME backends changes the winner — proves the choice is array-position-driven, not name-driven", () => {
    const media = makeMedia([makeVideoStream()]);
    const capsQsvFirst: VerifiedCapabilities = {
      backends: [
        { backend: "qsv", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
        { backend: "nvenc", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    expect(routeHardware(media, DEVICE_H264, 0, capsQsvFirst, makePolicy(), H264_ONLY_LADDER, false).encoder).toBe("qsv");
  });

  it("array iteration genuinely skips real non-matches (a codec-specific decode gap) to reach a LATER candidate", () => {
    const media = makeMedia([makeVideoStream({ codec: "vc1" })]);
    const capsVc1GapThenAmf: VerifiedCapabilities = {
      backends: [
        { backend: "nvenc", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 }, // no vc1
        { backend: "qsv", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 }, // no vc1
        { backend: "amf", decode: ["vc1"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 }, // vc1 decode
        { backend: "software", decode: ["h264", "vc1"], encode: ["h264"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    const result = routeHardware(media, DEVICE_H264, 0, capsVc1GapThenAmf, makePolicy(), H264_ONLY_LADDER, false);
    expect(result.encoder).toBe("amf");
    expect(result.reasons.map((r) => r.code)).toEqual(["hw-encoder-selected:amf"]);
  });
});

describe("routeHardware: decode-only backend defensive guard (binding interpretation 2)", () => {
  it("a backend with an EMPTY encode[] is never selected as an encoder, even with vacuously-empty ladder targets", () => {
    const media = makeMedia([makeVideoStream()]);
    const capsDecodeOnly: VerifiedCapabilities = {
      backends: [
        { backend: "d3d11va", decode: ["h264", "hevc"], encode: [], toneMap: [], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    // Empty ladder -> vacuous target set -> `targets.every(...)` would
    // trivially pass for ANY backend without the encode.length>0 guard.
    const result = routeHardware(media, DEVICE_H264, 0, capsDecodeOnly, makePolicy(), [], false);
    expect(result.encoder).toBe("software");
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });
});

describe("routeHardware: totality on defensive/degenerate inputs (docs/PLAYBACK.md §10 property 3)", () => {
  it("selection index that doesn't resolve to any real stream -> never throws, falls to full software", () => {
    const media = makeMedia([makeVideoStream({ index: 0 })]);
    expect(() => routeHardware(media, DEVICE_H264, 99, FULL_HW, makePolicy(), H264_ONLY_LADDER, false)).not.toThrow();
    const result = routeHardware(media, DEVICE_H264, 99, FULL_HW, makePolicy(), H264_ONLY_LADDER, false);
    expect(result.encoder).toBe("software");
  });

  it("null selection index -> never throws, falls to full software (no source codec to route)", () => {
    const media = makeMedia([makeVideoStream()]);
    const result = routeHardware(media, DEVICE_H264, null, FULL_HW, makePolicy(), H264_ONLY_LADDER, false);
    expect(result.encoder).toBe("software");
  });

  it("an unresolved stream also skips the tier cap (no source height to compare) even at T0 with a real ladder", () => {
    const media = makeMedia([makeVideoStream({ index: 0 })]);
    const result = routeHardware(media, DEVICE_H264, 99, SOFTWARE_ONLY, makePolicy({ tier: 0 }), DEFAULT_LADDER, false);
    expect(result.ladder).toEqual(DEFAULT_LADDER);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });
});

// ---------------------------------------------------------------------------
// Wave C1 (LD-7 / LD-16) — the §7.2 Stage-G RESIDUAL GUARD. `'hw'`
// eligibility admits av1 rungs, but §8.3's one-route resolution can still
// terminate at rule (iii) full-software (the av1-capable backend fails
// encode coverage for a MIXED target set). On that route only, at tier 0
// only, every av1 rung is demoted through src/av1.ts's shared primitive —
// BEFORE the existing >=1080p height cap runs. This closes unreachability
// leg 4: tier-0 `'hw'` eligibility whose route lands on software.
// ---------------------------------------------------------------------------

/** nvenc verifies av1 encode and NOTHING else — enough for eligibility
 *  `'hw'` (§7.2 reads `'av1' ∈ encode`), never enough to cover a
 *  `{av1, hevc}` target set, so §8.3's rules (i)/(ii) both skip it. */
const HW_AV1_ENCODE_ONLY: VerifiedCapabilities = {
  backends: [
    { backend: "nvenc", decode: ["h264", "hevc", "av1"], encode: ["av1"], toneMap: ["cuda"], verifiedAtMs: 1 },
    { backend: "software", decode: ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
  ],
};

/** The ladder such a box's §7.1 swap really produces: an untouched 2160p
 *  hevc rung plus sub-2160 av1 rungs — the mixed target set that forces
 *  rule (iii). Source is 1080p in these tests, so the tier cap is live. */
const MIXED_AV1_LADDER: LadderRung[] = [
  { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
  { heightPx: 1080, videoBitrateBps: 4_800_000, audioBitrateBps: 384_000, codec: "av1" },
  { heightPx: 720, videoBitrateBps: 1_800_000, audioBitrateBps: 160_000, codec: "av1" },
  { heightPx: 480, videoBitrateBps: 900_000, audioBitrateBps: 160_000, codec: "av1" },
];

/** The SAME hw-av1-encode-only box, but its SOFTWARE row's own av1 encode
 *  self-test PASSED (§7.3's D4 narrowing: `libsvtav1` really is present and
 *  really did encode a bitstream here). This is the ONLY shape in which a
 *  tier-1+ rule-(iii) route may keep its av1 rungs — the permitted software
 *  fallback is a VERIFIED software encoder, never an assumed one (design law
 *  4, C1 review finding 1). */
const HW_AV1_ENCODE_ONLY_SW_AV1: VerifiedCapabilities = {
  backends: [
    { backend: "nvenc", decode: ["h264", "hevc", "av1"], encode: ["av1"], toneMap: ["cuda"], verifiedAtMs: 1 },
    { backend: "software", decode: ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4"], encode: ["h264", "hevc", "av1"], toneMap: [], verifiedAtMs: 1 },
  ],
};

describe("routeHardware: §7.2 Stage-G residual guard (tier-0 software route)", () => {
  it("LEG 4 — T0 'hw' eligibility falling to rule (iii) demotes EVERY av1 rung, reason av1-rung-demoted", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, HW_AV1_ENCODE_ONLY, makePolicy({ tier: 0 }), MIXED_AV1_LADDER, false);
    expect(result.encoder).toBe("software");
    expect(result.ladder.some((r) => r.codec === "av1")).toBe(false);
    expect(result.reasons.map((r) => r.code)).toEqual([
      "software-fallback:encode",
      "av1-rung-demoted",
      "av1-rung-demoted",
      "av1-rung-demoted",
      "software-fallback:tier-capped",
    ]);
    expect(result.reasons.filter((r) => r.code === "av1-rung-demoted").map((r) => r.detail)).toEqual([
      "cause=tier0-software-route demotedTo=hevc heightPx=1080",
      "cause=tier0-software-route demotedTo=hevc heightPx=720",
      "cause=tier0-software-route demotedTo=hevc heightPx=480",
    ]);
  });

  it("the guard runs BEFORE the >=1080p height cap — the surviving 480p rung is the DEMOTED one", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, HW_AV1_ENCODE_ONLY, makePolicy({ tier: 0 }), MIXED_AV1_LADDER, false);
    expect(result.ladder).toEqual([
      { heightPx: 480, videoBitrateBps: 900_000, audioBitrateBps: 160_000, codec: "hevc" },
    ]);
  });

  it("TIER 1+ on the SAME rule-(iii) route KEEPS its av1 rungs when the SOFTWARE row itself verifies av1 — that IS the permitted software fallback", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, HW_AV1_ENCODE_ONLY_SW_AV1, makePolicy({ tier: 1 }), MIXED_AV1_LADDER, false);
    expect(result.encoder).toBe("software");
    expect(result.ladder).toEqual(MIXED_AV1_LADDER);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });

  it("a HARDWARE route (rule i/ii) at tier 0 never demotes — the guard is rule-(iii)-only", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const av1OnlyLadder = MIXED_AV1_LADDER.slice(1); // targets are exactly {av1}
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, HW_AV1_ENCODE_ONLY, makePolicy({ tier: 0 }), av1OnlyLadder, false);
    expect(result.encoder).toBe("nvenc");
    expect(result.ladder).toEqual(av1OnlyLadder);
    expect(result.reasons.map((r) => r.code)).toEqual(["hw-encoder-selected:nvenc"]);
  });

  it("demotes to h264 when the device declares no hevc entry", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const deviceAv1Only = makeDevice([videoEntry("h264"), videoEntry("av1")]);
    const result = routeHardware(media, deviceAv1Only, 0, HW_AV1_ENCODE_ONLY, makePolicy({ tier: 0 }), MIXED_AV1_LADDER, false);
    expect(result.ladder.every((r) => r.codec === "h264" || r.codec === "hevc")).toBe(true);
    expect(result.reasons.filter((r) => r.code === "av1-rung-demoted")[0]!.detail).toContain("demotedTo=h264");
  });

  it("an av1-FREE ladder on the same T0 rule-(iii) route is untouched (no av1-rung-demoted reason at all)", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, SOFTWARE_ONLY, makePolicy({ tier: 0 }), DEFAULT_LADDER, false);
    expect(result.reasons.some((r) => r.code === "av1-rung-demoted")).toBe(false);
  });

  it("distinct target codecs now range over LadderCodec — an av1-bearing ladder is coverable by a full-av1 backend", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, FULL_HW, makePolicy({ tier: 0 }), MIXED_AV1_LADDER, false);
    expect(result.encoder).toBe("nvenc");
    expect(result.ladder).toEqual(MIXED_AV1_LADDER);
  });
});

// ---------------------------------------------------------------------------
// C1 REVIEW FINDING 1 (MODERATE, owner-adopted 2026-08-11) — the SAME §7.2
// residual guard, second arm. The tier-0 arm above closes unreachability
// leg 4; this one closes the VERIFIED-CAPABILITIES hole the reviewer's
// repro found at tier 1+: eligibility `'hw'` is a fact about a HARDWARE
// backend, and the route can still collapse to rule (iii) — where the
// encoder is the SOFTWARE one, whose own av1 encode may never have been
// probe-verified. Keeping the rungs there hands the builder `libsvtav1` on
// a box that never proved it has it (design law 4: "verified capabilities
// only"; §7.2's own note that the `'software'` eligibility arm is
// capability-VERIFIED says the same thing about the same encoder).
//
// The tier law is untouched: tier 0 still demotes unconditionally on this
// route (cause=tier0-software-route, checked FIRST so every pre-finding
// assertion above — and matrix case 526 — stays byte-identical).
// ---------------------------------------------------------------------------
describe("routeHardware: §7.2 residual guard — tier-1+ rule-(iii) route whose SOFTWARE row lacks verified av1", () => {
  it("THE REPRO — tier 1, nvenc encode:[av1] only + software encode WITHOUT av1: every av1 rung demotes, cause=software-route-no-av1", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, HW_AV1_ENCODE_ONLY, makePolicy({ tier: 1 }), MIXED_AV1_LADDER, false);
    expect(result.encoder).toBe("software");
    expect(result.ladder.some((r) => r.codec === "av1")).toBe(false);
    expect(result.ladder).toEqual([
      { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 1080, videoBitrateBps: 4_800_000, audioBitrateBps: 384_000, codec: "hevc" },
      { heightPx: 720, videoBitrateBps: 1_800_000, audioBitrateBps: 160_000, codec: "hevc" },
      { heightPx: 480, videoBitrateBps: 900_000, audioBitrateBps: 160_000, codec: "hevc" },
    ]);
    expect(result.reasons.map((r) => r.code)).toEqual([
      "software-fallback:encode",
      "av1-rung-demoted",
      "av1-rung-demoted",
      "av1-rung-demoted",
    ]);
    expect(result.reasons.filter((r) => r.code === "av1-rung-demoted").map((r) => r.detail)).toEqual([
      "cause=software-route-no-av1 demotedTo=hevc heightPx=1080",
      "cause=software-route-no-av1 demotedTo=hevc heightPx=720",
      "cause=software-route-no-av1 demotedTo=hevc heightPx=480",
    ]);
  });

  it("tier 2 behaves identically — the rule is about the ROUTE's verified encoder, not about the tier", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, HW_AV1_ENCODE_ONLY, makePolicy({ tier: 2 }), MIXED_AV1_LADDER, false);
    expect(result.ladder.some((r) => r.codec === "av1")).toBe(false);
    expect(result.reasons.filter((r) => r.code === "av1-rung-demoted")).toHaveLength(3);
  });

  it("a caps set with NO software row at all counts as unverified — the route's encoder is still 'software'", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const noSoftwareRow: VerifiedCapabilities = { backends: [HW_AV1_ENCODE_ONLY.backends[0]!] };
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, noSoftwareRow, makePolicy({ tier: 1 }), MIXED_AV1_LADDER, false);
    expect(result.encoder).toBe("software");
    expect(result.ladder.some((r) => r.codec === "av1")).toBe(false);
    expect(result.reasons.filter((r) => r.code === "av1-rung-demoted")).toHaveLength(3);
  });

  it("TIER 0 PRECEDENCE — a tier-0 route whose software row DOES verify av1 still demotes, and still reports cause=tier0-software-route", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, HW_AV1_ENCODE_ONLY_SW_AV1, makePolicy({ tier: 0 }), MIXED_AV1_LADDER, false);
    expect(result.ladder.some((r) => r.codec === "av1")).toBe(false);
    expect(result.reasons.filter((r) => r.code === "av1-rung-demoted").map((r) => r.detail)).toEqual([
      "cause=tier0-software-route demotedTo=hevc heightPx=1080",
      "cause=tier0-software-route demotedTo=hevc heightPx=720",
      "cause=tier0-software-route demotedTo=hevc heightPx=480",
    ]);
  });

  it("a HARDWARE route (rule i/ii) at tier 1 never demotes, however unverified the software row is — the guard is rule-(iii)-only", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const av1OnlyLadder = MIXED_AV1_LADDER.slice(1); // targets are exactly {av1}, which nvenc covers
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, HW_AV1_ENCODE_ONLY, makePolicy({ tier: 1 }), av1OnlyLadder, false);
    expect(result.encoder).toBe("nvenc");
    expect(result.ladder).toEqual(av1OnlyLadder);
    expect(result.reasons.map((r) => r.code)).toEqual(["hw-encoder-selected:nvenc"]);
  });

  it("an av1-FREE ladder on a tier-1 rule-(iii) route with an av1-less software row is untouched (structural no-op)", () => {
    const media = makeMedia([makeVideoStream({ height: 1080 })]);
    const result = routeHardware(media, DEVICE_AV1_HEVC, 0, SOFTWARE_ONLY, makePolicy({ tier: 1 }), DEFAULT_LADDER, false);
    expect(result.ladder).toEqual(DEFAULT_LADDER);
    expect(result.reasons.map((r) => r.code)).toEqual(["software-fallback:encode"]);
  });
});
