// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for src/av1.ts — the ONE AV1 gate (docs/PLAYBACK.md §7.2,
 * LD-7/LD-16, Wave C1). Mirrors test/dv.spec.ts's role for the DV strip
 * predicate: this module is a shared predicate with TWO consumers
 * (`stages/ladder.ts`'s steps (f)/(g) and `stages/hardware.ts`'s Stage G
 * residual guard), and the whole point of it existing is that the two can
 * never drift apart. These tests pin the predicate itself; the consumers'
 * own specs pin that they call it rather than re-deriving.
 *
 * The four §7.2 unreachability legs are argued over `plan()` in
 * test/plan.spec.ts and pinned individually in the matrix
 * (matrix/520-527); what THIS file owns is the leg-2 arithmetic
 * ("on tier 0, eligibility is 'hw' or 'none' — never 'software'") stated
 * directly against the function, plus the demotion primitive's exact
 * output shape.
 */
import { describe, expect, it } from "vitest";
import {
  AV1_BITRATE_FACTOR,
  av1DemotionReason,
  av1EncodeEligibility,
  av1RungBlocker,
  av1SwapApplies,
  demoteAv1Rungs,
  softwareAv1EncodeVerified,
} from "../src/av1.js";
import type {
  DeviceProfile,
  DeviceProfileVideoEntry,
  LadderRung,
  ServerPolicy,
  VerifiedBackendCapability,
  VerifiedCapabilities,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function backend(overrides: Partial<VerifiedBackendCapability> & Pick<VerifiedBackendCapability, "backend">): VerifiedBackendCapability {
  return {
    decode: ["h264", "hevc", "av1"],
    encode: ["h264", "hevc"],
    toneMap: [],
    verifiedAtMs: 1_750_000_000_000,
    ...overrides,
  };
}

const CAPS_SOFTWARE_ONLY: VerifiedCapabilities = { backends: [backend({ backend: "software" })] };

/** Software ffmpeg whose libsvtav1 encode self-test PASSED (§7.3 D4: the
 *  software row's av1 entry means libsvtav1 specifically). */
const CAPS_SOFTWARE_AV1: VerifiedCapabilities = {
  backends: [backend({ backend: "software", encode: ["h264", "hevc", "av1"] })],
};

/** A real AV1 encode ENGINE (Arc/DG2-class qsv, RTX 40-class nvenc, ...). */
const CAPS_HW_AV1: VerifiedCapabilities = {
  backends: [
    backend({ backend: "nvenc", encode: ["h264", "hevc", "av1"], toneMap: ["cuda"] }),
    backend({ backend: "software" }),
  ],
};

/** The N100 reference box (§7.2's arithmetic): Quick Sync AV1 DECODE, no
 *  AV1 encode engine. */
const CAPS_N100: VerifiedCapabilities = {
  backends: [
    backend({ backend: "qsv", decode: ["h264", "hevc", "av1", "vp9", "mpeg2"], encode: ["h264", "hevc"], toneMap: ["opencl"] }),
    backend({ backend: "software" }),
  ],
};

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

function device(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    profileId: "av1-test-device",
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [videoEntry("av1"), videoEntry("hevc"), videoEntry("h264")],
    hdr: { hdr10: true, hlg: true, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 6, passthrough: false }],
    subtitles: { renderText: [], hlsVtt: false, renderImage: false },
    maxStreamBitrateBps: null,
    ...overrides,
  };
}

function policy(overrides: Partial<ServerPolicy> = {}): ServerPolicy {
  return {
    allowTranscode: true,
    allowToneMapCpu: "tier-gated",
    tier: 1,
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

// ---------------------------------------------------------------------------
// av1EncodeEligibility (docs/PLAYBACK.md §7.2, the LD-16 gate verbatim)
// ---------------------------------------------------------------------------

describe("av1EncodeEligibility — 'hw' arm", () => {
  it("'hw' whenever ANY non-software backend verifies av1 encode, at EVERY tier", () => {
    for (const tier of [0, 1, 2] as const) {
      expect(av1EncodeEligibility(CAPS_HW_AV1, tier), `tier=${tier}`).toBe("hw");
    }
  });

  it("'hw' wins over 'software' when BOTH a hw backend and the software row verify av1", () => {
    const caps: VerifiedCapabilities = {
      backends: [
        backend({ backend: "vaapi", encode: ["av1"] }),
        backend({ backend: "software", encode: ["h264", "hevc", "av1"] }),
      ],
    };
    expect(av1EncodeEligibility(caps, 2)).toBe("hw");
  });

  it("a hw backend verifying av1 encode but nothing else is still 'hw' (encode coverage is Stage G's problem, not the gate's)", () => {
    const caps: VerifiedCapabilities = { backends: [backend({ backend: "amf", encode: ["av1"] }), backend({ backend: "software" })] };
    expect(av1EncodeEligibility(caps, 0)).toBe("hw");
  });
});

describe("av1EncodeEligibility — 'software' arm (tier >= 1 AND probe-verified)", () => {
  it("'software' at tier 1 and tier 2 when the SOFTWARE row's own verified encode list includes av1", () => {
    expect(av1EncodeEligibility(CAPS_SOFTWARE_AV1, 1)).toBe("software");
    expect(av1EncodeEligibility(CAPS_SOFTWARE_AV1, 2)).toBe("software");
  });

  it("LEG 2 (the LD-16 law) — tier 0 NEVER yields 'software', even with a verified software av1 encoder", () => {
    expect(av1EncodeEligibility(CAPS_SOFTWARE_AV1, 0)).toBe("none");
  });

  it("design law 4 — a software row that did NOT verify av1 encode is 'none', never an assumption", () => {
    expect(av1EncodeEligibility(CAPS_SOFTWARE_ONLY, 1)).toBe("none");
    expect(av1EncodeEligibility(CAPS_SOFTWARE_ONLY, 2)).toBe("none");
  });
});

describe("av1EncodeEligibility — 'none' arm", () => {
  it("the N100 reference box (qsv av1 DECODE, no av1 encode engine) is 'none' at tier 0 — §7.2's arithmetic", () => {
    expect(av1EncodeEligibility(CAPS_N100, 0)).toBe("none");
  });

  it("the same N100 box is STILL 'none' at tier 1/2 — decode capability is not encode capability", () => {
    expect(av1EncodeEligibility(CAPS_N100, 1)).toBe("none");
    expect(av1EncodeEligibility(CAPS_N100, 2)).toBe("none");
  });

  it("an EMPTY caps set (a completed probe that verified nothing, W1/D-1) is 'none' at every tier", () => {
    for (const tier of [0, 1, 2] as const) {
      expect(av1EncodeEligibility({ backends: [] }, tier), `tier=${tier}`).toBe("none");
    }
  });

  it("videotoolbox can never contribute 'hw' — no av1_videotoolbox encoder exists, so the probe never lists av1 (§7.3)", () => {
    const caps: VerifiedCapabilities = {
      backends: [backend({ backend: "videotoolbox", encode: ["h264", "hevc"], toneMap: ["videotoolbox"] }), backend({ backend: "software" })],
    };
    for (const tier of [0, 1, 2] as const) {
      expect(av1EncodeEligibility(caps, tier), `tier=${tier}`).toBe("none");
    }
  });
});

// ---------------------------------------------------------------------------
// av1RungBlocker — §7.1's conditions 2 + 3 (NEVER condition 1)
// ---------------------------------------------------------------------------

describe("av1RungBlocker — null means an av1 rung is admissible", () => {
  it("device declares av1 + fmp4 AND eligibility is 'hw' -> null at tier 0", () => {
    expect(av1RungBlocker(device(), CAPS_HW_AV1, 0)).toBeNull();
  });

  it("device declares av1 + fmp4 AND eligibility is 'software' -> null at tier 1", () => {
    expect(av1RungBlocker(device(), CAPS_SOFTWARE_AV1, 1)).toBeNull();
  });

  it("does NOT consult policy.av1EncodePreferred — an EXPLICIT av1 rung IS the operator's preference (§7.1(g))", () => {
    // The function takes no policy at all: condition 1 is structurally
    // absent from the blocker, which is exactly the spec's requirement.
    expect(av1RungBlocker.length).toBe(3);
  });
});

describe("av1RungBlocker — the three ladder-side causes", () => {
  it("device declares NO av1 entry -> 'device-no-av1' (even with real hw av1 encode)", () => {
    const d = device({ video: [videoEntry("hevc"), videoEntry("h264")] });
    expect(av1RungBlocker(d, CAPS_HW_AV1, 2)).toBe("device-no-av1");
  });

  it("device declares av1 but CANNOT take fmp4 -> 'device-no-av1' (AV1 has no MPEG-TS stream_type, §6 interp. M)", () => {
    const d = device({ hls: { container: "ts", supportsFmp4: false, lowLatency: false } });
    expect(av1RungBlocker(d, CAPS_HW_AV1, 2)).toBe("device-no-av1");
  });

  it("tier 0 with no HARDWARE av1 encoder -> 'tier0-no-hw-av1' (the LD-16 refusal, even when software could)", () => {
    expect(av1RungBlocker(device(), CAPS_SOFTWARE_AV1, 0)).toBe("tier0-no-hw-av1");
    expect(av1RungBlocker(device(), CAPS_N100, 0)).toBe("tier0-no-hw-av1");
  });

  it("tier 1/2 with NO av1 encoder anywhere -> 'no-av1-encoder'", () => {
    expect(av1RungBlocker(device(), CAPS_SOFTWARE_ONLY, 1)).toBe("no-av1-encoder");
    expect(av1RungBlocker(device(), CAPS_N100, 2)).toBe("no-av1-encoder");
  });

  it("the DEVICE cause takes precedence when both a device and a capability condition fail", () => {
    const d = device({ video: [videoEntry("h264")] });
    expect(av1RungBlocker(d, CAPS_SOFTWARE_ONLY, 0)).toBe("device-no-av1");
  });
});

// ---------------------------------------------------------------------------
// av1SwapApplies — condition 1 AND the blocker (§7.1 swap gate)
// ---------------------------------------------------------------------------

describe("av1SwapApplies — the swap gate is the blocker PLUS the operator flag", () => {
  it("false when the operator has not opted in, however capable the box is", () => {
    expect(av1SwapApplies(policy({ av1EncodePreferred: false, tier: 2 }), device(), CAPS_HW_AV1)).toBe(false);
  });

  it("true on an opted-in, av1-capable, fmp4 device at tier 0 via 'hw' eligibility", () => {
    expect(av1SwapApplies(policy({ av1EncodePreferred: true, tier: 0 }), device(), CAPS_HW_AV1)).toBe(true);
  });

  it("false on an opted-in TIER-0 box with only SOFTWARE av1 — the LD-16 law, from the shared predicate", () => {
    expect(av1SwapApplies(policy({ av1EncodePreferred: true, tier: 0 }), device(), CAPS_SOFTWARE_AV1)).toBe(false);
  });

  it("true at tier 1 with software av1 (the permitted software fallback)", () => {
    expect(av1SwapApplies(policy({ av1EncodePreferred: true, tier: 1 }), device(), CAPS_SOFTWARE_AV1)).toBe(true);
  });

  it("NO-DRIFT STRUCTURE — the swap fires iff the flag is on AND the blocker is null, for every combination", () => {
    const caps = [CAPS_SOFTWARE_ONLY, CAPS_SOFTWARE_AV1, CAPS_HW_AV1, CAPS_N100];
    const devices = [device(), device({ video: [videoEntry("h264")] }), device({ hls: { container: "ts", supportsFmp4: false, lowLatency: false } })];
    for (const c of caps) {
      for (const d of devices) {
        for (const tier of [0, 1, 2] as const) {
          for (const pref of [true, false]) {
            const p = policy({ tier, av1EncodePreferred: pref });
            expect(av1SwapApplies(p, d, c)).toBe(pref && av1RungBlocker(d, c, tier) === null);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// demoteAv1Rungs — the shared demotion primitive
// ---------------------------------------------------------------------------

const AV1_1080: LadderRung = { heightPx: 1080, videoBitrateBps: 5_000_000, audioBitrateBps: 160_000, codec: "av1" };
const AV1_720: LadderRung = { heightPx: 720, videoBitrateBps: 2_000_000, audioBitrateBps: 160_000, codec: "av1" };
const H264_360: LadderRung = { heightPx: 360, videoBitrateBps: 800_000, audioBitrateBps: 160_000, codec: "h264" };

describe("demoteAv1Rungs — demote, never drop (§7.1(g))", () => {
  it("demotes to hevc when the device declares an hevc entry, keeping every other field VERBATIM", () => {
    const { rungs, demotions } = demoteAv1Rungs([AV1_1080, H264_360], device(), "no-av1-encoder");
    expect(rungs).toEqual([
      { heightPx: 1080, videoBitrateBps: 5_000_000, audioBitrateBps: 160_000, codec: "hevc" },
      H264_360,
    ]);
    expect(demotions).toEqual([{ heightPx: 1080, demotedTo: "hevc", cause: "no-av1-encoder" }]);
  });

  it("demotes to h264 when the device declares NO hevc entry", () => {
    const d = device({ video: [videoEntry("av1"), videoEntry("h264")] });
    const { rungs } = demoteAv1Rungs([AV1_720], d, "device-no-av1");
    expect(rungs).toEqual([{ heightPx: 720, videoBitrateBps: 2_000_000, audioBitrateBps: 160_000, codec: "h264" }]);
  });

  it("the admin's bitrate is kept VERBATIM — never rescaled by the swap factor or anything else", () => {
    const { rungs } = demoteAv1Rungs([AV1_1080], device(), "tier0-no-hw-av1");
    expect(rungs[0]!.videoBitrateBps).toBe(AV1_1080.videoBitrateBps);
    expect(rungs[0]!.audioBitrateBps).toBe(AV1_1080.audioBitrateBps);
    expect(rungs[0]!.heightPx).toBe(AV1_1080.heightPx);
  });

  it("rung COUNT and heights stay stable — demote-don't-drop keeps a configured ladder serveable", () => {
    const table = [AV1_1080, AV1_720, H264_360];
    const { rungs } = demoteAv1Rungs(table, device(), "tier0-software-route");
    expect(rungs).toHaveLength(3);
    expect(rungs.map((r) => r.heightPx)).toEqual([1080, 720, 360]);
  });

  it("a demoted rung that becomes field-identical to another table rung is DROPPED, not duplicated", () => {
    const twin: LadderRung = { heightPx: 720, videoBitrateBps: 2_000_000, audioBitrateBps: 160_000, codec: "hevc" };
    const { rungs, demotions } = demoteAv1Rungs([AV1_720, twin], device(), "no-av1-encoder");
    expect(rungs).toEqual([twin]);
    // The demotion still HAPPENED — the admin's av1 rung is gone either way,
    // so the reason must still be reported.
    expect(demotions).toEqual([{ heightPx: 720, demotedTo: "hevc", cause: "no-av1-encoder" }]);
  });

  it("a table with NO av1 rung is returned byte-identical, with zero demotions", () => {
    const table = [H264_360, { heightPx: 480, videoBitrateBps: 1_500_000, audioBitrateBps: 160_000, codec: "hevc" as const }];
    const { rungs, demotions } = demoteAv1Rungs(table, device(), "tier0-software-route");
    expect(rungs).toEqual(table);
    expect(demotions).toEqual([]);
  });

  it("an EMPTY table stays empty", () => {
    expect(demoteAv1Rungs([], device(), "device-no-av1")).toEqual({ rungs: [], demotions: [] });
  });

  it("is PURE — the input array and its rungs are never mutated", () => {
    const table = [AV1_1080, H264_360];
    const snapshot = JSON.stringify(table);
    demoteAv1Rungs(table, device(), "no-av1-encoder");
    expect(JSON.stringify(table)).toBe(snapshot);
  });
});

describe("av1DemotionReason — the §4 detail contract, formatted in ONE place", () => {
  it("emits code av1-rung-demoted with cause/demotedTo/heightPx in the documented order", () => {
    expect(av1DemotionReason({ heightPx: 1080, demotedTo: "hevc", cause: "tier0-software-route" })).toEqual({
      code: "av1-rung-demoted",
      detail: "cause=tier0-software-route demotedTo=hevc heightPx=1080",
    });
  });

  it("covers every cause the two consumers can produce", () => {
    const causes = [
      "tier0-no-hw-av1",
      "device-no-av1",
      "no-av1-encoder",
      "tier0-software-route",
      "software-route-no-av1",
    ] as const;
    for (const cause of causes) {
      const reason = av1DemotionReason({ heightPx: 720, demotedTo: "h264", cause });
      expect(reason.code).toBe("av1-rung-demoted");
      expect(reason.detail).toBe(`cause=${cause} demotedTo=h264 heightPx=720`);
    }
  });
});

// ---------------------------------------------------------------------------
// softwareAv1EncodeVerified — §7.2's verified-capabilities arm (C1 review
// finding 1). Exported from this module rather than written inline in
// stages/hardware.ts so "software can really encode av1 on this box" has
// exactly ONE definition, shared with av1EncodeEligibility's own software
// arm.
// ---------------------------------------------------------------------------
describe("softwareAv1EncodeVerified — the software row's OWN probe-verified av1 encode", () => {
  it("true when the software row lists av1", () => {
    expect(softwareAv1EncodeVerified(CAPS_SOFTWARE_AV1)).toBe(true);
  });

  it("false when the software row lists h264/hevc only", () => {
    expect(softwareAv1EncodeVerified(CAPS_SOFTWARE_ONLY)).toBe(false);
  });

  it("false when only a HARDWARE backend verifies av1 — this predicate never reads hw rows", () => {
    expect(softwareAv1EncodeVerified(CAPS_HW_AV1)).toBe(false);
    // ...while the eligibility gate, which DOES read them, says 'hw'.
    expect(av1EncodeEligibility(CAPS_HW_AV1, 0)).toBe("hw");
  });

  it("false for an empty caps set — 'software' is rule (iii) DOCTRINE, so a missing row is unverified, never assumed-capable", () => {
    expect(softwareAv1EncodeVerified({ backends: [] })).toBe(false);
  });

  it("is tier-BLIND: the same caps answer identically at every tier (the route, not the tier, makes it decisive)", () => {
    expect(softwareAv1EncodeVerified(CAPS_SOFTWARE_AV1)).toBe(true);
    // The tier question lives in av1EncodeEligibility, which layers it ON
    // TOP of this predicate rather than duplicating the encode lookup.
    expect(av1EncodeEligibility(CAPS_SOFTWARE_AV1, 0)).toBe("none");
    expect(av1EncodeEligibility(CAPS_SOFTWARE_AV1, 1)).toBe("software");
  });
});

describe("AV1_BITRATE_FACTOR (owner-decision D3)", () => {
  it("is 0.6 — the h264-baseline parity convention one generation past hevc's 0.75", () => {
    expect(AV1_BITRATE_FACTOR).toBe(0.6);
  });
});
