// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/stages/hdr.ts (Stage C — docs/PLAYBACK.md §3, Phase 3
 * Step 2c; refusal moved out by step 7b fix F2). Lives in the package's
 * NORMAL (non-matrix) test project (vitest.config.ts's `include` covers
 * `test/**\/*.spec.ts`), separate from matrix/'s case-file burn-up.
 *
 * Coverage: every branch (dv5 both ways, dv7/8 three ways, hdr10/hlg both
 * ways, none), the strip-only-when-repackaging both-ways split, the
 * dvProfile-null conservative branch — all against the stage's OWN
 * (policy/caps-free since step 7b F2) signature — PLUS the tone-map
 * REFUSAL matrix, which as of step 7b fix F2 is a ROUTE-LEVEL fact decided
 * in src/plan.ts's Stage G assembly from stages/hardware.ts's full §8.3
 * resolution, so every refusal test here goes through a full `plan()`
 * call (Stage C itself no longer reads policy or caps at all). The
 * refused ⇒ empty-ladder pin also runs via `plan()` (a `StageResult` has
 * no ladder field — the ladder is a `src/plan.ts`-level output).
 */
import { describe, expect, it } from "vitest";
import { evaluateHdr } from "../../src/stages/hdr.js";
import { plan } from "../../src/plan.js";
import type {
  DeviceProfile,
  MediaInfo,
  PlanInput,
  ServerPolicy,
  VerifiedCapabilities,
  VideoStream,
} from "../../src/types.js";

function makeVideoStream(overrides: Partial<VideoStream> = {}): VideoStream {
  return {
    index: 0,
    codec: "hevc",
    profile: "main10",
    level: 123,
    width: 1920,
    height: 1080,
    bitDepth: 10,
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

function makeMedia(video: VideoStream[], overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    fileId: "file-1",
    container: "mp4",
    durationMs: 6_000_000,
    sizeBytes: 6_000_000_000,
    overallBitrateBps: 8_000_000,
    video,
    audio: [],
    subtitle: [],
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
        codec: "hevc",
        maxProfile: "main10",
        maxLevel: 153,
        maxBitDepth: 10,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: 60,
        maxBitrateBps: null,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
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
    segmentDurationSec: 6,
    hevcEncodePreferred: false,
    ...overrides,
  };
}

const SOFTWARE_ONLY_CAPS: VerifiedCapabilities = {
  backends: [{ backend: "software", decode: ["hevc"], encode: ["hevc"], toneMap: [], verifiedAtMs: 1 }],
};

// NOTE (step 7b F2): since refusal is ROUTE-level, a "hardware tone-map
// exists" fixture must actually be routable for the scenario's ladder
// targets (h264 below 2160p) — a vt entry that only encoded hevc would
// itself fall through to the refused software route, which is precisely
// the arm-A gap matrix case 447 pins.
const HARDWARE_TONEMAP_CAPS: VerifiedCapabilities = {
  backends: [
    { backend: "videotoolbox", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: ["videotoolbox"], verifiedAtMs: 1 },
    { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
  ],
};

describe("Stage C: evaluateHdr — selection / vacuous-pass branches", () => {
  it("videoStreamIndex null -> verdict direct-play, reasons [] (vacuous pass)", () => {
    const media = makeMedia([makeVideoStream({ hdr: "hdr10" })]); // would mismatch, but unselected
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    expect(evaluateHdr(media, device, null, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("media.video is empty (music mode) -> verdict direct-play, reasons [] regardless of index", () => {
    const media = makeMedia([]);
    const device = makeDevice();
    expect(evaluateHdr(media, device, 0, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("selection index does not resolve to any stream (defensive) -> vacuous pass, never throws", () => {
    const media = makeMedia([makeVideoStream({ index: 0 })]);
    const device = makeDevice();
    expect(evaluateHdr(media, device, 7, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("hdr === 'none' -> vacuous pass regardless of device HDR flags (PIN: not evaluated as a mismatch)", () => {
    const media = makeMedia([makeVideoStream({ hdr: "none" })]);
    // Every device flag false — an incorrect implementation that treated
    // 'none' as "matches nothing" would wrongly fire hdr-tone-map-required.
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    expect(evaluateHdr(media, device, 0, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });
});

describe("Stage C: hdr10 branch (both ways)", () => {
  it("device.hdr.hdr10 true -> silent copy, no reason", () => {
    const media = makeMedia([makeVideoStream({ hdr: "hdr10" })]);
    const device = makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } });
    expect(evaluateHdr(media, device, 0, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("device.hdr.hdr10 false -> hdr-tone-map-required, verdict transcode (and ONLY that — refusal is plan()-level since step 7b F2)", () => {
    const media = makeMedia([makeVideoStream({ hdr: "hdr10" })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    const result = evaluateHdr(media, device, 0, true);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons).toEqual([
      { code: "hdr-tone-map-required", streamIndex: 0, detail: "hdr=hdr10 device.hdr10=false" },
    ]);
  });
});

describe("Stage C: hlg branch (both ways)", () => {
  it("device.hdr.hlg true -> silent copy, no reason", () => {
    const media = makeMedia([makeVideoStream({ hdr: "hlg" })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: true, dolbyVision: false } });
    expect(evaluateHdr(media, device, 0, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("device.hdr.hlg false -> hdr-tone-map-required, verdict transcode", () => {
    const media = makeMedia([makeVideoStream({ hdr: "hlg" })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    const result = evaluateHdr(media, device, 0, true);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons).toEqual([
      { code: "hdr-tone-map-required", streamIndex: 0, detail: "hdr=hlg device.hlg=false" },
    ]);
  });

  it("hdr10 flag true does NOT rescue an hlg source, and vice versa (flags checked independently)", () => {
    const hlgSourceHdr10OnlyDevice = evaluateHdr(
      makeMedia([makeVideoStream({ hdr: "hlg" })]),
      makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } }),
      0,
      true,
    );
    expect(hlgSourceHdr10OnlyDevice.verdict).toBe("transcode");

    const hdr10SourceHlgOnlyDevice = evaluateHdr(
      makeMedia([makeVideoStream({ hdr: "hdr10" })]),
      makeDevice({ hdr: { hdr10: false, hlg: true, dolbyVision: false } }),
      0,
      true,
    );
    expect(hdr10SourceHlgOnlyDevice.verdict).toBe("transcode");
  });
});

describe("Stage C: dv profile 5 branch (both ways)", () => {
  it("device.dolbyVision true -> silent copy, no reason, regardless of 'no compatible base'", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 5, dvBlCompatId: null })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: true } });
    expect(evaluateHdr(media, device, 0, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("device.dolbyVision false -> dv-profile5-requires-tonemap, verdict transcode", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 5, dvBlCompatId: null })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    const result = evaluateHdr(media, device, 0, true);
    expect(result.verdict).toBe("transcode");
    expect(result.reasons).toEqual([
      { code: "dv-profile5-requires-tonemap", streamIndex: 0, detail: "dvProfile=5 device.dolbyVision=false" },
    ]);
  });

  it("device.hdr.hdr10 true does NOT rescue profile 5 — 'no compatible base' ignores the hdr10 flag entirely", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 5, dvBlCompatId: null })]);
    const device = makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } });
    const result = evaluateHdr(media, device, 0, true);
    expect(result.reasons.map((r) => r.code)).toEqual(["dv-profile5-requires-tonemap"]);
  });
});

describe("Stage C: dv profile 7/8 branch (three ways)", () => {
  for (const dvProfile of [7, 8] as const) {
    describe(`dvProfile ${dvProfile}`, () => {
      it("way 1 — device.dolbyVision true -> silent copy, regardless of dvBlCompatId", () => {
        const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile, dvBlCompatId: 1 })]);
        const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: true } });
        expect(evaluateHdr(media, device, 0, true)).toEqual({
          verdict: "direct-play",
          reasons: [],
        });
      });

      it("way 2 — dvBlCompatId marks a compatible BL AND device.hdr10 true -> dv-stripped-to-hdr10 (repackage required)", () => {
        const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile, dvBlCompatId: 1 })]);
        const device = makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } });
        const result = evaluateHdr(media, device, 0, false);
        expect(result.verdict).toBe("direct-play"); // no re-encode, informational only
        expect(result.reasons).toEqual([
          // LD-15: `elDropped` states whether a dual-layer enhancement
          // layer went with the RPU — true for profile 7 (BL+EL), false
          // for the single-layer profile 8. Carried in `detail` rather
          // than as a new reason code because PlanReasonCode is a closed
          // contract enum (docs/PLAYBACK.md §4).
          { code: "dv-stripped-to-hdr10", streamIndex: 0, detail: `dvProfile=${dvProfile} blCompatId=1 elDropped=${dvProfile === 7}` },
        ]);
      });

      it("way 3 — no compatible base layer (dvBlCompatId null) -> hdr-tone-map-required", () => {
        const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile, dvBlCompatId: null })]);
        const device = makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } });
        const result = evaluateHdr(media, device, 0, true);
        expect(result.verdict).toBe("transcode");
        expect(result.reasons).toEqual([
          {
            code: "hdr-tone-map-required",
            streamIndex: 0,
            detail: `dvProfile=${dvProfile} blCompatId=null device.hdr10=true`,
          },
        ]);
      });

      it("way 3 (variant) — compatible BL present but device.hdr10 false -> STILL hdr-tone-map-required (AND logic)", () => {
        const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile, dvBlCompatId: 1 })]);
        const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
        const result = evaluateHdr(media, device, 0, true);
        expect(result.verdict).toBe("transcode");
        expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required"]);
      });
    });
  }
});

describe("Stage C: strip-only-when-repackaging (binding interpretation constraint 3, both ways)", () => {
  it("containerDirectPlayable=false -> dv-stripped-to-hdr10 FIRES (repackage genuinely happens)", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 8, dvBlCompatId: 1 })]);
    const device = makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } });
    const result = evaluateHdr(media, device, 0, false);
    expect(result.reasons).toEqual([
      { code: "dv-stripped-to-hdr10", streamIndex: 0, detail: "dvProfile=8 blCompatId=1 elDropped=false" },
    ]);
  });

  it("containerDirectPlayable=true -> dv-stripped-to-hdr10 does NOT fire (no strip actually happens; silent copy)", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 8, dvBlCompatId: 1 })]);
    const device = makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } });
    const result = evaluateHdr(media, device, 0, true);
    expect(result).toEqual({ verdict: "direct-play", reasons: [] });
  });

  it("verdict for the strip branch is ALWAYS 'direct-play' severity (informational only) whether or not the reason fires", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 7, dvBlCompatId: 1 })]);
    const device = makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } });
    expect(evaluateHdr(media, device, 0, false).verdict).toBe("direct-play");
    expect(evaluateHdr(media, device, 0, true).verdict).toBe("direct-play");
  });
});

describe("Stage C: dvProfile null / unexpected-value conservative branch (binding interpretation constraint 2)", () => {
  it("dvProfile null, device.dolbyVision false -> treated as profile-5 branch: dv-profile5-requires-tonemap", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: null, dvBlCompatId: null })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    const result = evaluateHdr(media, device, 0, true);
    expect(result.reasons).toEqual([
      {
        code: "dv-profile5-requires-tonemap",
        streamIndex: 0,
        detail: "dvProfile=null device.dolbyVision=false (unrecognized profile, treated conservatively as profile 5 — no compatible base proven)",
      },
    ]);
  });

  it("dvProfile null, device.dolbyVision true -> silent copy (same short-circuit as canonical profile 5)", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: null, dvBlCompatId: null })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: true } });
    expect(evaluateHdr(media, device, 0, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });

  it("dvProfile 6 (unrecognized, not 5/7/8), device.dolbyVision false -> conservative profile-5 branch, detail names 6", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 6, dvBlCompatId: null })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } });
    const result = evaluateHdr(media, device, 0, true);
    expect(result.reasons).toEqual([
      {
        code: "dv-profile5-requires-tonemap",
        streamIndex: 0,
        detail: "dvProfile=6 device.dolbyVision=false (unrecognized profile, treated conservatively as profile 5 — no compatible base proven)",
      },
    ]);
  });

  it("dvProfile 6, device.dolbyVision true -> silent copy (never reaches the profile-7/8 branch even numerically closer)", () => {
    const media = makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 6, dvBlCompatId: 1 })]);
    const device = makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: true } });
    expect(evaluateHdr(media, device, 0, true)).toEqual({
      verdict: "direct-play",
      reasons: [],
    });
  });
});

// ---------------------------------------------------------------------------
// ROUTE-LEVEL tone-map refusal (step 7b fix F2 — docs/PLAYBACK.md §3's "if
// Stage G yields no hardware method and `allowToneMapCpu` resolves to never"
// seam, decided in src/plan.ts's Stage G assembly from stages/hardware.ts's
// full §8.3 resolution). Stage C no longer reads policy/caps, so every test
// here is a full plan() call. The tier-gated/'never' resolution semantics
// are UNCHANGED from Step 2c; what changed is the "no hardware method" half:
// it is now the ROUTED answer (per-candidate method fall-through + the
// software route's policy check), not a caps-global "does any backend have a
// non-empty toneMap array" heuristic — the two new arm-A/arm-B tests below
// (mirrors of matrix cases 447/448) pin exactly the routes the old
// heuristic got wrong.
// ---------------------------------------------------------------------------

const REAL_LADDER_TABLE = [
  { heightPx: 2160, videoBitrateBps: 16_000_000, audioBitrateBps: 384_000, codec: "hevc" as const },
  { heightPx: 1080, videoBitrateBps: 8_000_000, audioBitrateBps: 384_000, codec: "h264" as const },
  { heightPx: 1080, videoBitrateBps: 4_000_000, audioBitrateBps: 160_000, codec: "h264" as const },
  { heightPx: 720, videoBitrateBps: 3_000_000, audioBitrateBps: 160_000, codec: "h264" as const },
  { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "h264" as const },
  { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" as const },
];

/** hdr10 source vs SDR-only (but hevc-capable) device — the canonical
 *  tone-map-required scenario every refusal test below starts from. */
function makeMismatchPlanInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    media: makeMedia([makeVideoStream({ hdr: "hdr10" })], {
      audio: [
        {
          index: 1,
          codec: "aac",
          channels: 2,
          sampleRate: 48000,
          bitrateBps: 192_000,
          language: "eng",
          isDefault: true,
          hasAtmos: false,
        },
      ],
    }),
    device: makeDevice({ hdr: { hdr10: false, hlg: false, dolbyVision: false } }),
    network: { maxBitrateBps: 100_000_000, isLocal: true },
    policy: makePolicy({ allowToneMapCpu: "tier-gated", tier: 0, ladderRungs: REAL_LADDER_TABLE }),
    caps: SOFTWARE_ONLY_CAPS,
    selection: { videoStreamIndex: 0, audioStreamIndex: 1, subtitleStreamIndex: null },
    mode: "stream",
    ...overrides,
  };
}

function refusalFired(input: PlanInput): boolean {
  return plan(input)
    .reasons.some((r) => r.code === "tone-map-refused-by-policy");
}

describe("route-level tone-map refusal matrix (step 7b F2 — policy resolution × route, via plan())", () => {
  it("allowToneMapCpu 'always' + software-only caps -> NOT refused, any tier (cpu-zscale resolves)", () => {
    for (const tier of [0, 1, 2] as const) {
      const input = makeMismatchPlanInput({
        policy: makePolicy({ allowToneMapCpu: "always", tier, ladderRungs: REAL_LADDER_TABLE }),
      });
      expect(refusalFired(input), `tier=${tier}`).toBe(false);
      expect(plan(input).video.toneMap, `tier=${tier}`).toBe("cpu-zscale");
    }
  });

  it("allowToneMapCpu 'tier-gated' + tier 0 + software-only caps -> REFUSED", () => {
    const input = makeMismatchPlanInput(); // defaults: tier-gated @ 0, software-only
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);
  });

  it("allowToneMapCpu 'tier-gated' + tier 1 or 2 + software-only caps -> NOT refused", () => {
    for (const tier of [1, 2] as const) {
      const input = makeMismatchPlanInput({
        policy: makePolicy({ allowToneMapCpu: "tier-gated", tier, ladderRungs: REAL_LADDER_TABLE }),
      });
      expect(refusalFired(input), `tier=${tier}`).toBe(false);
    }
  });

  it("allowToneMapCpu 'never' + software-only caps -> REFUSED, at every tier (tier is irrelevant to 'never')", () => {
    for (const tier of [0, 1, 2] as const) {
      const input = makeMismatchPlanInput({
        policy: makePolicy({ allowToneMapCpu: "never", tier, ladderRungs: REAL_LADDER_TABLE }),
      });
      const result = plan(input);
      expect(result.reasons.map((r) => r.code), `tier=${tier}`).toEqual([
        "hdr-tone-map-required",
        "tone-map-refused-by-policy",
      ]);
    }
  });

  it("allowToneMapCpu 'never' + a ROUTABLE hw backend with a usable method -> NOT refused (hardware method exists on the route)", () => {
    const input = makeMismatchPlanInput({
      policy: makePolicy({ allowToneMapCpu: "never", tier: 2, ladderRungs: REAL_LADDER_TABLE }),
      caps: HARDWARE_TONEMAP_CAPS,
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "hw-encoder-selected:videotoolbox"]);
    expect(result.video.toneMap).toBe("videotoolbox");
  });

  it("allowToneMapCpu 'tier-gated' + tier 0 + a ROUTABLE hw backend with a usable method -> NOT refused", () => {
    const input = makeMismatchPlanInput({ caps: HARDWARE_TONEMAP_CAPS });
    expect(refusalFired(input)).toBe(false);
  });

  it("ARM A (matrix 447's route): a toneMap-capable backend that CANNOT encode the targets -> REFUSED under 'never' (the old caps-global heuristic said unrefused)", () => {
    const capsToneMapNoEncode: VerifiedCapabilities = {
      backends: [
        { backend: "nvenc", decode: ["h264", "hevc"], encode: ["av1"], toneMap: ["cuda"], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    const input = makeMismatchPlanInput({
      policy: makePolicy({ allowToneMapCpu: "never", tier: 2, ladderRungs: REAL_LADDER_TABLE }),
      caps: capsToneMapNoEncode,
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);
    expect(result.ladder).toEqual([]);
    expect(result.video.encoder).toBeUndefined();
    expect(result.video.toneMap).toBeUndefined();
    expect(result.ffmpegArgs).toEqual([]);
  });

  it("ARM B (matrix 448's route): backend covers decode+encode but verifies NONE of its own §8.3-preferred methods -> REFUSED under 'never'", () => {
    const capsWrongMethod: VerifiedCapabilities = {
      backends: [
        // nvenc's §8.3 preference row is exactly [cuda]; a verified [opencl]
        // can never satisfy it, so the candidate falls through everywhere.
        { backend: "nvenc", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: ["opencl"], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    const input = makeMismatchPlanInput({
      policy: makePolicy({ allowToneMapCpu: "never", tier: 2, ladderRungs: REAL_LADDER_TABLE }),
      caps: capsWrongMethod,
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);
    expect(result.video.toneMap).toBeUndefined();
  });

  it("ARM B CONTROL: the identical wrong-method caps under 'always' land on the software route's cpu-zscale instead (NOT refused)", () => {
    const capsWrongMethod: VerifiedCapabilities = {
      backends: [
        { backend: "nvenc", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: ["opencl"], verifiedAtMs: 1 },
        { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1 },
      ],
    };
    const input = makeMismatchPlanInput({
      policy: makePolicy({ allowToneMapCpu: "always", tier: 1, ladderRungs: REAL_LADDER_TABLE }),
      caps: capsWrongMethod,
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "software-fallback:encode"]);
    expect(result.video.toneMap).toBe("cpu-zscale");
    expect(result.video.encoder).toBe("software");
  });

  it("refusal reason ALWAYS appears directly AFTER the branch's own reason (Step 2c's position, preserved by F2), on every firing branch", () => {
    const neverPolicy = makePolicy({ allowToneMapCpu: "never", tier: 2, ladderRungs: REAL_LADDER_TABLE });

    const hdr10 = plan(makeMismatchPlanInput({ policy: neverPolicy }));
    expect(hdr10.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);

    const dv5 = plan(
      makeMismatchPlanInput({
        media: makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 5, dvBlCompatId: null })], {
          audio: [
            { index: 1, codec: "aac", channels: 2, sampleRate: 48000, bitrateBps: 192_000, language: "eng", isDefault: true, hasAtmos: false },
          ],
        }),
        policy: neverPolicy,
      }),
    );
    expect(dv5.reasons.map((r) => r.code)).toEqual(["dv-profile5-requires-tonemap", "tone-map-refused-by-policy"]);

    const dv7NoCompat = plan(
      makeMismatchPlanInput({
        media: makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 7, dvBlCompatId: null })], {
          audio: [
            { index: 1, codec: "aac", channels: 2, sampleRate: 48000, bitrateBps: 192_000, language: "eng", isDefault: true, hasAtmos: false },
          ],
        }),
        policy: neverPolicy,
      }),
    );
    expect(dv7NoCompat.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);
  });

  it("the dv-stripped-to-hdr10 (silent copy / informational) branch never reaches refusal — no tone-map is required at all", () => {
    const input = makeMismatchPlanInput({
      media: makeMedia([makeVideoStream({ hdr: "dv", dvProfile: 8, dvBlCompatId: 1 })], {
        container: "mkv", // force repackage so the strip reason fires
        audio: [
          { index: 1, codec: "aac", channels: 2, sampleRate: 48000, bitrateBps: 192_000, language: "eng", isDefault: true, hasAtmos: false },
        ],
      }),
      device: makeDevice({ hdr: { hdr10: true, hlg: false, dolbyVision: false } }),
      policy: makePolicy({ allowToneMapCpu: "never", tier: 2, ladderRungs: REAL_LADDER_TABLE }),
    });
    const result = plan(input);
    expect(result.reasons.map((r) => r.code)).toEqual(["container-not-direct-playable", "dv-stripped-to-hdr10"]);
  });
});

describe("refused ⇒ ladder [] pin (STATE.md P3.9(b) shape, refusal now route-derived — full plan() call)", () => {
  it("a refused tone-map scenario produces decision=transcode, the refusal reason, AND ladder===[] (against a REAL, non-empty ladder table)", () => {
    const result = plan(makeMismatchPlanInput());
    expect(result.decision).toBe("transcode");
    expect(result.reasons.map((r) => r.code)).toEqual(["hdr-tone-map-required", "tone-map-refused-by-policy"]);
    // THE PIN (Phase 3 Step 2c, carried through Step 2f and step 7b F2):
    // docs/PLAYBACK.md §3 — "it emits transcode with `ladder: []`" is part
    // of the refusal's OWN contract. Since F2 the refusal is derived FROM
    // the §8.3 route resolution, so src/plan.ts BUILDS the ladder first
    // (routeHardware needs its target codecs) and then DISCARDS it when
    // the resolution comes back method-less — proven here against a policy
    // whose `ladderRungs` is the real §7 default table (the control test
    // below shows the SAME table producing a non-empty ladder once refusal
    // is out of the picture), so the [] is a deliberate discard, not a
    // vacuously empty construction.
    expect(result.ladder).toEqual([]);
    expect(result.video.action).toBe("transcode");
  });

  it("video.action is 'transcode' when Stage C alone escalates (Stage B stays copy) — constraint 6 composition", () => {
    const result = plan(makeMismatchPlanInput());
    expect(result.video.action).toBe("transcode");
  });

  it("CONTROL: the identical scenario WITHOUT refusal (allowToneMapCpu 'always') builds a REAL non-empty ladder from the SAME table", () => {
    const result = plan(
      makeMismatchPlanInput({
        policy: makePolicy({ allowToneMapCpu: "always", tier: 0, ladderRungs: REAL_LADDER_TABLE }),
      }),
    );
    expect(result.decision).toBe("transcode");
    // why (Phase 3 §11 step 3, Stage G arrival): this scenario's `caps`
    // (SOFTWARE_ONLY_CAPS) declares only a `software` backend -> Stage G's
    // full-software route always fires `software-fallback:encode`; tier 0 +
    // this stream's 1080p height additionally trips the tier cap (the
    // pre-cap ladder still has 1080p/720p rungs above the 480p ceiling).
    expect(result.reasons.map((r) => r.code)).toEqual([
      "hdr-tone-map-required",
      "software-fallback:encode",
      "software-fallback:tier-capped",
    ]);
    expect(result.video.action).toBe("transcode");
    expect(result.ladder.length).toBeGreaterThan(0);
  });
});
