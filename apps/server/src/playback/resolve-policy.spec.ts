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
  maxSimultaneousTranscodes: 2,
  hevcEncodePreferred: true,
  // Wave C1: the registry default (owner-decision D5 — opt-in).
  av1EncodePreferred: false,
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
    expect(policy.maxSimultaneousTranscodes).toBe(2); // tier-0 default (SPF-8)
    expect(policy.ladderRungs).toEqual(DEFAULT_LADDER_RUNGS);
    expect(policy.segmentDurationSec).toBe(6);
    expect(policy.hevcEncodePreferred).toBe(false); // NO_CAPS never verifies hevc encode
  });

  it("tier-derived maxSimultaneousTranscodes defaults (SPF-8: 2/2/4) are now the CALLER's job (SettingsService's own tier-aware registry default) — this module just echoes whatever it's handed", () => {
    expect(resolveServerPolicy({ tier: "0" }, NO_CAPS, { ...DEFAULT_SETTINGS_INPUTS, maxSimultaneousTranscodes: 2 }).maxSimultaneousTranscodes).toBe(2);
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

  // ==========================================================================
  // Wave C1 / LD-7 — docs/PLAYBACK.md §2.4's DELIBERATE ASYMMETRY. hevc's
  // preference is resolved HERE (its only gate is a capability fact); av1's
  // is passed through VERBATIM, because AV1's gate is a TIER LAW that must
  // be enforced inside the pure engine, from caps + policy.tier, where the
  // matrix can prove its unreachability property. Resolving it here would
  // put the law's enforcement outside the tested function — the exact
  // failure class the shared-predicate fix exists to prevent.
  // ==========================================================================

  describe("av1EncodePreferred is passed through VERBATIM (§2.4's asymmetry)", () => {
    const AV1_CAPS: VerifiedCapabilities = {
      backends: [{ backend: "nvenc", decode: ["h264", "hevc", "av1"], encode: ["h264", "hevc", "av1"], toneMap: ["cuda"], verifiedAtMs: 1 }],
    };

    it("true stays true even when NO backend verifies av1 encode — never AND-ed with capability here", () => {
      const policy = resolveServerPolicy({}, NO_CAPS, { ...DEFAULT_SETTINGS_INPUTS, av1EncodePreferred: true });
      expect(policy.av1EncodePreferred).toBe(true);
    });

    it("false stays false even when a backend DOES verify av1 encode — never OR-ed with capability either", () => {
      const policy = resolveServerPolicy({}, AV1_CAPS, { ...DEFAULT_SETTINGS_INPUTS, av1EncodePreferred: false });
      expect(policy.av1EncodePreferred).toBe(false);
    });

    it("is independent of tier — a tier-0 server still forwards the raw preference (the engine, not this module, refuses)", () => {
      for (const tier of ["0", "1", "2"]) {
        const policy = resolveServerPolicy({ tier }, NO_CAPS, { ...DEFAULT_SETTINGS_INPUTS, av1EncodePreferred: true });
        expect(policy.av1EncodePreferred, `tier=${tier}`).toBe(true);
      }
    });

    it("CONTRAST: hevcEncodePreferred under the SAME caps IS resolved down to false", () => {
      const settings = { ...DEFAULT_SETTINGS_INPUTS, hevcEncodePreferred: true, av1EncodePreferred: true };
      const policy = resolveServerPolicy({}, NO_CAPS, settings);
      expect(policy.hevcEncodePreferred).toBe(false);
      expect(policy.av1EncodePreferred).toBe(true);
    });
  });
});
