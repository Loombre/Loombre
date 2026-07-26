// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { validateVerifiedCapabilities } from "../../src/hwcaps/schema.js";

describe("validateVerifiedCapabilities", () => {
  it("accepts a minimal valid shape", () => {
    const result = validateVerifiedCapabilities({
      backends: [{ backend: "software", decode: ["h264"], encode: ["h264"], toneMap: [], verifiedAtMs: 123 }],
    });
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("accepts an empty backends array", () => {
    expect(validateVerifiedCapabilities({ backends: [] })).toEqual({ valid: true, violations: [] });
  });

  it("rejects a non-object", () => {
    expect(validateVerifiedCapabilities(null).valid).toBe(false);
    expect(validateVerifiedCapabilities("nope").valid).toBe(false);
    expect(validateVerifiedCapabilities(42).valid).toBe(false);
  });

  it("rejects a missing backends array", () => {
    const result = validateVerifiedCapabilities({});
    expect(result.valid).toBe(false);
    expect(result.violations[0]!.path).toBe("$.backends");
  });

  it("rejects an unknown backend value", () => {
    const result = validateVerifiedCapabilities({
      backends: [{ backend: "totally-made-up", decode: [], encode: [], toneMap: [], verifiedAtMs: 1 }],
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.path === "$.backends[0].backend")).toBe(true);
  });

  it("rejects a decode entry outside the VideoCodec set", () => {
    const result = validateVerifiedCapabilities({
      backends: [{ backend: "software", decode: ["h264", "betamax"], encode: [], toneMap: [], verifiedAtMs: 1 }],
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.path === "$.backends[0].decode[1]")).toBe(true);
  });

  it("rejects an encode entry outside {h264,hevc,av1} (e.g. 'vp9', which IS a valid decode codec but not an encode target)", () => {
    const result = validateVerifiedCapabilities({
      backends: [{ backend: "software", decode: [], encode: ["vp9"], toneMap: [], verifiedAtMs: 1 }],
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.path === "$.backends[0].encode[0]")).toBe(true);
  });

  it("rejects a toneMap entry outside {opencl,vulkan,videotoolbox,cuda,none}", () => {
    const result = validateVerifiedCapabilities({
      backends: [{ backend: "nvenc", decode: [], encode: [], toneMap: ["cpu-zscale"], verifiedAtMs: 1 }],
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.path === "$.backends[0].toneMap[0]")).toBe(true);
  });

  it("rejects a non-numeric / non-finite verifiedAtMs", () => {
    expect(
      validateVerifiedCapabilities({
        backends: [{ backend: "software", decode: [], encode: [], toneMap: [], verifiedAtMs: "123" }],
      }).valid,
    ).toBe(false);
    expect(
      validateVerifiedCapabilities({
        backends: [{ backend: "software", decode: [], encode: [], toneMap: [], verifiedAtMs: Number.NaN }],
      }).valid,
    ).toBe(false);
  });

  it("accepts every real HardwareBackend value", () => {
    for (const backend of ["videotoolbox", "qsv", "vaapi", "nvenc", "amf", "d3d11va", "software"]) {
      const result = validateVerifiedCapabilities({
        backends: [{ backend, decode: [], encode: [], toneMap: [], verifiedAtMs: 1 }],
      });
      expect(result.valid, `${backend} should be valid`).toBe(true);
    }
  });

  it("reports every violation, not just the first (fail-fast is not the contract)", () => {
    const result = validateVerifiedCapabilities({
      backends: [{ backend: "nope", decode: ["nope"], encode: ["nope"], toneMap: ["nope"], verifiedAtMs: "nope" }],
    });
    expect(result.violations.length).toBe(5);
  });
});
