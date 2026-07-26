// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-reasons.test.ts

import { describe, expect, it } from "vitest";
import { describeReasonCode, resolveUnavailableReasons, TRANSCODE_SLOTS_EXHAUSTED_CODE } from "./playback-reasons.js";

describe("resolveUnavailableReasons", () => {
  it("passes through real reasons for a 409 unchanged", () => {
    const reasons = [{ code: "tone-map-refused-by-policy", streamIndex: 0, detail: null }];
    expect(resolveUnavailableReasons(409, reasons)).toEqual(reasons);
  });

  it("passes through real reasons for a 422 unchanged", () => {
    const reasons = [{ code: "subtitle-codec-unknown", streamIndex: 1, detail: "unknown" }];
    expect(resolveUnavailableReasons(422, reasons)).toEqual(reasons);
  });

  it("passes through an empty array unchanged for a 409 (UnavailableScreen's own 'no reason reported' fallback applies)", () => {
    expect(resolveUnavailableReasons(409, [])).toEqual([]);
  });

  it("synthesizes the transcode-slots-exhausted reason for a 429 with no server-provided reasons", () => {
    expect(resolveUnavailableReasons(429, [])).toEqual([{ code: TRANSCODE_SLOTS_EXHAUSTED_CODE, streamIndex: null, detail: null }]);
  });

  it("still prefers real reasons over the synthesized 429 fallback if the server ever sends any", () => {
    const reasons = [{ code: "transcode-disabled-by-policy", streamIndex: null, detail: null }];
    expect(resolveUnavailableReasons(429, reasons)).toEqual(reasons);
  });
});

describe("describeReasonCode(TRANSCODE_SLOTS_EXHAUSTED_CODE)", () => {
  it("has its own dedicated copy, distinct from the generic 'unrecognized code' fallback", () => {
    const copy = describeReasonCode(TRANSCODE_SLOTS_EXHAUSTED_CODE);
    expect(copy.title).not.toBe(TRANSCODE_SLOTS_EXHAUSTED_CODE);
    expect(copy.severity).toBe("blocking");
  });
});

// Phase 4 deliverable D (admin Sessions "why is this transcoding" reasons
// panel): the closed docs/PLAYBACK.md §4 reason-code enum, hand-mirrored
// from packages/contract/openapi.yaml's PlanReasonCode `oneOf` (verified
// against that schema at the time of writing — 20 fixed blocking-class +
// 4 fixed informational-class + the two pattern-typed families' fully
// enumerated concrete members: hw-encoder-selected:<7 backends per
// docs/PLAYBACK.md §8.2's candidate list> and
// software-fallback:<3 causes per that schema's own regex>). This is the
// admin reasons panel's ENTIRE reason-copy source (it reuses
// describeReasonCode — no separate admin-only copy map) — this test is
// the "import the closed enum and assert exhaustiveness" deliverable:
// every one of these 34 codes must resolve to its OWN dedicated copy, not
// silently fall through to the generic "Unrecognized reason code" fallback
// (which would be a copy-map coverage gap, not a real unrecognized code).
const BLOCKING_REASON_CODES = [
  "container-not-direct-playable",
  "video-codec-unsupported",
  "video-profile-unsupported",
  "video-level-exceeds-device",
  "video-bitdepth-unsupported",
  "video-resolution-exceeds-device",
  "video-framerate-exceeds-device",
  "video-interlaced",
  "hdr-tone-map-required",
  "dv-profile5-requires-tonemap",
  "tone-map-refused-by-policy",
  "audio-codec-unsupported",
  "audio-channels-exceed-device",
  "audio-passthrough-unsupported",
  "subtitle-format-requires-burn-in",
  "subtitle-burn-in-for-styling",
  "video-transcode-for-subtitle-burn-in",
  "bitrate-exceeds-network",
  "subtitle-codec-unknown",
  "transcode-disabled-by-policy",
] as const;

const FIXED_INFORMATIONAL_REASON_CODES = [
  "dv-stripped-to-hdr10",
  "subtitle-styling-lost",
  "audio-atmos-lost",
  "gapless-degraded",
] as const;

// docs/PLAYBACK.md §8.2's closed backend candidate list, matching
// packages/contract/openapi.yaml's PlanReasonCode pattern:
// '^hw-encoder-selected:(videotoolbox|qsv|vaapi|nvenc|amf|d3d11va|software)$'.
const HW_ENCODER_BACKENDS = ["videotoolbox", "qsv", "vaapi", "nvenc", "amf", "d3d11va", "software"] as const;
const HW_ENCODER_SELECTED_REASON_CODES = HW_ENCODER_BACKENDS.map((b) => `hw-encoder-selected:${b}`);

// PlanReasonCode pattern: '^software-fallback:(decode|encode|tier-capped)$'.
const SOFTWARE_FALLBACK_CAUSES = ["decode", "encode", "tier-capped"] as const;
const SOFTWARE_FALLBACK_REASON_CODES = SOFTWARE_FALLBACK_CAUSES.map((c) => `software-fallback:${c}`);

const CLOSED_REASON_ENUM = [
  ...BLOCKING_REASON_CODES,
  ...FIXED_INFORMATIONAL_REASON_CODES,
  ...HW_ENCODER_SELECTED_REASON_CODES,
  ...SOFTWARE_FALLBACK_REASON_CODES,
];

describe("describeReasonCode exhaustiveness over the closed docs/PLAYBACK.md §4 enum", () => {
  it("the mirrored enum has exactly 34 members (20 blocking + 4 fixed-informational + 7 hw-encoder-selected + 3 software-fallback)", () => {
    expect(BLOCKING_REASON_CODES).toHaveLength(20);
    expect(CLOSED_REASON_ENUM).toHaveLength(34);
    expect(new Set(CLOSED_REASON_ENUM).size).toBe(34); // no accidental duplicates
  });

  for (const code of CLOSED_REASON_ENUM) {
    it(`has dedicated (non-fallback) copy for "${code}"`, () => {
      const copy = describeReasonCode(code);
      expect(copy.title, `"${code}" fell through to the generic unrecognized-code fallback`).not.toBe(code);
      expect(copy.detail).not.toMatch(/this build's reason copy map may be behind/i);
      expect(["blocking", "informational"]).toContain(copy.severity);
    });
  }

  it("every BLOCKING-class code resolves to severity 'blocking'", () => {
    for (const code of BLOCKING_REASON_CODES) {
      expect(describeReasonCode(code).severity, code).toBe("blocking");
    }
  });

  it("every INFORMATIONAL-class code (fixed + both pattern families) resolves to severity 'informational'", () => {
    for (const code of [...FIXED_INFORMATIONAL_REASON_CODES, ...HW_ENCODER_SELECTED_REASON_CODES, ...SOFTWARE_FALLBACK_REASON_CODES]) {
      expect(describeReasonCode(code).severity, code).toBe("informational");
    }
  });

  it("a genuinely unknown code still falls through to the honest generic fallback (proves the test above isn't vacuous)", () => {
    const copy = describeReasonCode("totally-made-up-code-not-in-the-enum");
    expect(copy.title).toBe("totally-made-up-code-not-in-the-enum");
    expect(copy.detail).toMatch(/this build's reason copy map may be behind/i);
  });
});
