// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/device-profile-validator.spec.ts
//
// Strict-validation unit tests (STATE.md P2.3/P2.12, docs/PLAYBACK.md §2.2):
// a schema-valid web-chrome-shaped profile passes; missing required keys,
// wrong types, and extra/unknown properties are all rejected. Pure unit
// test — no Nest DI, no DB (mirrors hash.service.spec.ts's `new Service()`
// pattern).

import { describe, expect, it } from "vitest";
import { DeviceProfileValidatorService } from "./device-profile-validator.js";

function validProfile(): Record<string, unknown> {
  return {
    profileId: "web-chrome",
    directPlayContainers: ["mp4", "mkv"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [
      {
        codec: "h264",
        maxProfile: null,
        maxLevel: null,
        maxBitDepth: 8,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
        maxBitrateBps: 20_000_000,
      },
    ],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [{ codec: "aac", maxChannels: 2, passthrough: false }],
    subtitles: { renderText: ["subrip"], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

describe("DeviceProfileValidatorService", () => {
  const service = new DeviceProfileValidatorService();

  it("accepts a valid web-chrome-shaped profile", () => {
    const result = service.validate(validProfile());
    expect(result.valid).toBe(true);
  });

  it("rejects a profile missing a required top-level key (hdr)", () => {
    const profile = validProfile();
    delete profile["hdr"];
    const result = service.validate(profile);
    expect(result.valid).toBe(false);
  });

  it("rejects a profile missing a required nested key (hls.container)", () => {
    const profile = validProfile();
    delete (profile["hls"] as Record<string, unknown>)["container"];
    const result = service.validate(profile);
    expect(result.valid).toBe(false);
  });

  it("rejects wrong types (maxWidth as a string)", () => {
    const profile = validProfile();
    (profile["video"] as Array<Record<string, unknown>>)[0]!["maxWidth"] = "1920";
    const result = service.validate(profile);
    expect(result.valid).toBe(false);
  });

  it("rejects an unknown enum value (bogus video codec)", () => {
    const profile = validProfile();
    (profile["video"] as Array<Record<string, unknown>>)[0]!["codec"] = "bogus-codec";
    const result = service.validate(profile);
    expect(result.valid).toBe(false);
  });

  it("rejects extra/unknown top-level properties (additionalProperties: false)", () => {
    const profile = validProfile();
    profile["extraGarbageField"] = "not part of the schema";
    const result = service.validate(profile);
    expect(result.valid).toBe(false);
  });

  it("rejects extra/unknown nested properties", () => {
    const profile = validProfile();
    (profile["hdr"] as Record<string, unknown>)["notARealHdrField"] = true;
    const result = service.validate(profile);
    expect(result.valid).toBe(false);
  });

  it("rejects non-object input entirely", () => {
    expect(service.validate("not-an-object").valid).toBe(false);
    expect(service.validate(null).valid).toBe(false);
    expect(service.validate([1, 2, 3]).valid).toBe(false);
  });

  it("failure result carries a non-empty human-readable errors string", () => {
    const result = service.validate({});
    if (result.valid) throw new Error("expected invalid");
    expect(typeof result.errors).toBe("string");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
