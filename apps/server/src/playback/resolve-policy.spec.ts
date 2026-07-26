// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/resolve-policy.spec.ts
//
// Pure unit tests for resolveServerPolicy (docs/PLAYBACK.md §2.4, Phase 3
// §11 step 6b).
//
// Addendum A, lane S3: maxSimultaneousTranscodes/hevcEncodePreferred
// (operator-preference half)/allowToneMapCpu/ladderRungs moved from env/
// hardcoded resolution to caller-supplied `SettingsPolicyInputs` (the
// registry's own defaults, packages/shared/src/settings-registry.ts) —
// every test below now passes `DEFAULT_SETTINGS_INPUTS` (or a variant)
// explicitly instead of relying on this module's own removed internal
// defaulting, matching resolveServerPolicyFromSettings's real behavior
// (SettingsService.getEffective() already resolves tier-aware/env-pinned/
// DB/default precedence before this pure function ever runs).

import { describe, expect, it } from "vitest";
import type { VerifiedCapabilities } from "@loombre/playback-engine";
import {
  DEFAULT_LADDER_RUNGS,
  parseEnvBoolean,
  parseEnvTier,
  resolveServerPolicy,
  type SettingsPolicyInputs,
} from "./resolve-policy.js";

const NO_CAPS: VerifiedCapabilities = { backends: [] };
const HEVC_CAPS: VerifiedCapabilities = {
  backends: [{ backend: "videotoolbox", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: ["videotoolbox"], verifiedAtMs: 1 }],
};

const DEFAULT_SETTINGS_INPUTS: SettingsPolicyInputs = {
  maxSimultaneousTranscodes: 1,
  hevcEncodePreferred: true,
  allowToneMapCpu: "tier-gated",
  ladderRungs: DEFAULT_LADDER_RUNGS,
};

describe("parseEnvTier", () => {
  it("'1'/'2' parse; anything else (incl. unset) defaults to 0", () => {
    expect(parseEnvTier("1")).toBe(1);
    expect(parseEnvTier("2")).toBe(2);
    expect(parseEnvTier("0")).toBe(0);
    expect(parseEnvTier(undefined)).toBe(0);
    expect(parseEnvTier("bogus")).toBe(0);
  });
});

describe("parseEnvBoolean", () => {
  it("recognizes the standard boolean-like strings both directions", () => {
    expect(parseEnvBoolean("true", false)).toBe(true);
    expect(parseEnvBoolean("1", false)).toBe(true);
    expect(parseEnvBoolean("on", false)).toBe(true);
    expect(parseEnvBoolean("false", true)).toBe(false);
    expect(parseEnvBoolean("0", true)).toBe(false);
    expect(parseEnvBoolean("off", true)).toBe(false);
  });

  it("unset -> the caller's default; unrecognized -> also the default", () => {
    expect(parseEnvBoolean(undefined, true)).toBe(true);
    expect(parseEnvBoolean(undefined, false)).toBe(false);
    expect(parseEnvBoolean("bogus", true)).toBe(true);
  });
});

describe("resolveServerPolicy", () => {
  it("§2.4 documented defaults, tier 0, no env overrides", () => {
    const policy = resolveServerPolicy({}, NO_CAPS, DEFAULT_SETTINGS_INPUTS);
    expect(policy.allowTranscode).toBe(true);
    expect(policy.allowToneMapCpu).toBe("tier-gated");
    expect(policy.tier).toBe(0);
    expect(policy.preferredTextSubMode).toBe("hls-vtt");
    expect(policy.preserveAssStyling).toBe(false);
    expect(policy.audioTranscodeCodecPriority).toEqual(["opus", "aac"]);
    expect(policy.maxSimultaneousTranscodes).toBe(1); // tier-0 default
    expect(policy.ladderRungs).toEqual(DEFAULT_LADDER_RUNGS);
    expect(policy.segmentDurationSec).toBe(6);
    expect(policy.hevcEncodePreferred).toBe(false); // NO_CAPS never verifies hevc encode
  });

  it("tier-derived maxSimultaneousTranscodes defaults (1/2/4) are now the CALLER's job (SettingsService's own tier-aware registry default) — this module just echoes whatever it's handed", () => {
    expect(resolveServerPolicy({ tier: "0" }, NO_CAPS, { ...DEFAULT_SETTINGS_INPUTS, maxSimultaneousTranscodes: 1 }).maxSimultaneousTranscodes).toBe(1);
    expect(resolveServerPolicy({ tier: "1" }, NO_CAPS, { ...DEFAULT_SETTINGS_INPUTS, maxSimultaneousTranscodes: 2 }).maxSimultaneousTranscodes).toBe(2);
    expect(resolveServerPolicy({ tier: "2" }, NO_CAPS, { ...DEFAULT_SETTINGS_INPUTS, maxSimultaneousTranscodes: 4 }).maxSimultaneousTranscodes).toBe(4);
  });

  it("a settings-supplied maxSimultaneousTranscodes always wins, regardless of tier", () => {
    expect(resolveServerPolicy({ tier: "0" }, NO_CAPS, { ...DEFAULT_SETTINGS_INPUTS, maxSimultaneousTranscodes: 9 }).maxSimultaneousTranscodes).toBe(9);
  });

  it("LOOMBRE_ALLOW_TRANSCODE disables transcoding", () => {
    expect(resolveServerPolicy({ allowTranscode: "false" }, NO_CAPS, DEFAULT_SETTINGS_INPUTS).allowTranscode).toBe(false);
  });

  it("hevcEncodePreferred is true only when BOTH the operator preference setting AND verified caps agree", () => {
    expect(resolveServerPolicy({}, NO_CAPS, DEFAULT_SETTINGS_INPUTS).hevcEncodePreferred).toBe(false); // caps say no
    expect(resolveServerPolicy({}, HEVC_CAPS, DEFAULT_SETTINGS_INPUTS).hevcEncodePreferred).toBe(true); // both agree
    expect(
      resolveServerPolicy({}, HEVC_CAPS, { ...DEFAULT_SETTINGS_INPUTS, hevcEncodePreferred: false }).hevcEncodePreferred,
    ).toBe(false); // caps say yes, but operator preference says no
  });

  it("ladderRungs/allowToneMapCpu are always whatever settings hands in", () => {
    const policy = resolveServerPolicy({ tier: "2" }, HEVC_CAPS, DEFAULT_SETTINGS_INPUTS);
    expect(policy.ladderRungs).toEqual(DEFAULT_LADDER_RUNGS);
    expect(policy.allowToneMapCpu).toBe("tier-gated");

    const customRung = [DEFAULT_LADDER_RUNGS[0]!];
    const customized = resolveServerPolicy({}, HEVC_CAPS, { ...DEFAULT_SETTINGS_INPUTS, ladderRungs: customRung, allowToneMapCpu: "never" });
    expect(customized.ladderRungs).toEqual(customRung);
    expect(customized.allowToneMapCpu).toBe("never");
  });
});
