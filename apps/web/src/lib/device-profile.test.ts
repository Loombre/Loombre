// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/device-profile.test.ts
//
// Validates buildDeviceProfile()'s output against a runtime-compiled Ajv
// schema mirroring packages/contract/openapi.yaml's DeviceProfile 1:1 (same
// approach apps/server/src/common/device-profile-validator.ts uses
// server-side — see that file's header for why a hand-mirrored schema, not
// a YAML parse, is the convention here). All MSE/canPlayType/matchMedia/
// mediaCapabilities browser APIs are mocked via ProbeEnv — jsdom's real
// canPlayType always returns '' (no codecs), so nothing here depends on it.

import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { buildDeviceProfile, type CanPlayTypeResult, type ProbeEnv } from "./device-profile.js";

// Mirrors apps/server/src/common/device-profile-validator.ts DEVICE_PROFILE_SCHEMA verbatim.
const CONTAINER_ENUM = [
  "mp4",
  "mkv",
  "webm",
  "avi",
  "ts",
  "mov",
  "flac",
  "mp3",
  "ogg",
  "m4a",
  "wav",
  "asf",
  "mpeg",
  "flv",
  "aac",
  "aiff",
];
const VIDEO_CODEC_ENUM = ["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4", "unknown"];
const AUDIO_CODEC_ENUM = [
  "aac",
  "ac3",
  "eac3",
  "truehd",
  "dts",
  "dtshd",
  "flac",
  "opus",
  "mp3",
  "vorbis",
  "pcm",
  "unknown",
];
const SUBTITLE_CODEC_ENUM = ["subrip", "ass", "webvtt", "mov_text", "pgs", "vobsub", "dvbsub", "unknown"];

const DEVICE_PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "profileId",
    "directPlayContainers",
    "hls",
    "video",
    "hdr",
    "audio",
    "subtitles",
    "maxStreamBitrateBps",
  ],
  properties: {
    profileId: { type: "string" },
    directPlayContainers: { type: "array", items: { type: "string", enum: CONTAINER_ENUM } },
    hls: {
      type: "object",
      additionalProperties: false,
      required: ["container", "supportsFmp4", "lowLatency"],
      properties: {
        container: { type: "string", enum: ["fmp4", "ts"] },
        supportsFmp4: { type: "boolean" },
        lowLatency: { type: "boolean" },
      },
    },
    video: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "codec",
          "maxProfile",
          "maxLevel",
          "maxBitDepth",
          "maxWidth",
          "maxHeight",
          "maxFrameRate",
          "maxBitrateBps",
        ],
        properties: {
          codec: { type: "string", enum: VIDEO_CODEC_ENUM },
          maxProfile: { type: ["string", "null"] },
          maxLevel: { type: ["number", "null"] },
          maxBitDepth: { type: "integer", enum: [8, 10] },
          maxWidth: { type: "integer", minimum: 1 },
          maxHeight: { type: "integer", minimum: 1 },
          maxFrameRate: { type: "number", minimum: 0 },
          maxBitrateBps: { type: ["integer", "null"] },
        },
      },
    },
    hdr: {
      type: "object",
      additionalProperties: false,
      required: ["hdr10", "hlg", "dolbyVision"],
      properties: {
        hdr10: { type: "boolean" },
        hlg: { type: "boolean" },
        dolbyVision: { type: "boolean" },
      },
    },
    audio: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["codec", "maxChannels", "passthrough"],
        properties: {
          codec: { type: "string", enum: AUDIO_CODEC_ENUM },
          maxChannels: { type: "integer", minimum: 1 },
          passthrough: { type: "boolean" },
        },
      },
    },
    subtitles: {
      type: "object",
      additionalProperties: false,
      required: ["renderText", "hlsVtt", "renderImage"],
      properties: {
        renderText: { type: "array", items: { type: "string", enum: SUBTITLE_CODEC_ENUM } },
        hlsVtt: { type: "boolean" },
        renderImage: { type: "boolean" },
      },
    },
    maxStreamBitrateBps: { type: ["integer", "null"] },
  },
} as const;

function validate(profile: unknown): { valid: boolean; errors: string } {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const fn = ajv.compile(DEVICE_PROFILE_SCHEMA);
  const valid = fn(profile);
  return { valid, errors: ajv.errorsText(fn.errors) };
}

/** A "supports everything" env: modern Chrome-like MSE/canPlayType/HDR/mediaCapabilities. */
function fullEnv(overrides: Partial<ProbeEnv> = {}): ProbeEnv {
  const probably: CanPlayTypeResult = "probably";
  const nothing: CanPlayTypeResult = "";
  return {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    videoCanPlayType: (type) => (type.includes("mp4") || type.includes("webm") ? probably : nothing),
    audioCanPlayType: (type) =>
      type.includes("mp4") ||
      type.includes("mpeg") ||
      type.includes("flac") ||
      type.includes("webm") ||
      type.includes("ogg") ||
      type.includes("wav")
        ? probably
        : nothing,
    isTypeSupported: (type) => type.includes("mp4") || type.includes("webm"),
    matchesHighDynamicRange: () => true,
    mediaCapabilities: {
      decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }),
    },
    ...overrides,
  };
}

/** A minimal / old-browser env: nothing supported, no mediaCapabilities. */
function bareEnv(overrides: Partial<ProbeEnv> = {}): ProbeEnv {
  return {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 Safari/605.1.15",
    videoCanPlayType: () => "",
    audioCanPlayType: () => "",
    isTypeSupported: () => false,
    matchesHighDynamicRange: () => false,
    mediaCapabilities: undefined,
    ...overrides,
  };
}

describe("buildDeviceProfile", () => {
  it("produces a profile that validates against the contract's DeviceProfile schema (full-capability env)", async () => {
    const profile = await buildDeviceProfile(fullEnv());
    const result = validate(profile);
    expect(result.errors).toBe("No errors");
    expect(result.valid).toBe(true);
  });

  it("produces a profile that validates against the contract's DeviceProfile schema (bare env)", async () => {
    const profile = await buildDeviceProfile(bareEnv());
    const result = validate(profile);
    expect(result.errors).toBe("No errors");
    expect(result.valid).toBe(true);
  });

  it("detects profileId from the user agent (Chrome checked before Safari, since Chrome's UA also contains Safari)", async () => {
    const profile = await buildDeviceProfile(fullEnv());
    expect(profile.profileId).toBe("web-chrome");

    const safariProfile = await buildDeviceProfile(
      bareEnv({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      }),
    );
    expect(safariProfile.profileId).toBe("web-safari");
  });

  it("never claims mkv/avi direct-play (no browser demuxes these containers natively)", async () => {
    const profile = await buildDeviceProfile(fullEnv());
    expect(profile.directPlayContainers).not.toContain("mkv");
    expect(profile.directPlayContainers).not.toContain("avi");
    expect(profile.directPlayContainers).toContain("mp4");
    expect(profile.directPlayContainers).toContain("webm");
  });

  it("reports an empty video/audio/container capability set honestly when nothing is supported", async () => {
    const profile = await buildDeviceProfile(bareEnv());
    expect(profile.video).toEqual([]);
    expect(profile.audio).toEqual([]);
    expect(profile.directPlayContainers).toEqual([]);
    expect(profile.hdr).toEqual({ hdr10: false, hlg: false, dolbyVision: false });
    expect(profile.hls.supportsFmp4).toBe(false);
  });

  it("never claims audio bitstream passthrough or dolbyVision (no web API exposes either)", async () => {
    const profile = await buildDeviceProfile(fullEnv());
    expect(profile.audio.every((a) => a.passthrough === false)).toBe(true);
    expect(profile.hdr.dolbyVision).toBe(false);
  });

  it("caps h264 maxBitDepth at 8 and only reports HDR when both display and 10-bit decode are confirmed", async () => {
    const profile = await buildDeviceProfile(fullEnv());
    const h264 = profile.video.find((v) => v.codec === "h264");
    expect(h264?.maxBitDepth).toBe(8);
    // hdr claimed true only because fullEnv() both reports a high-dynamic-range
    // display AND supports the 10-bit hevc/vp9/av1 codec strings.
    expect(profile.hdr.hdr10).toBe(true);

    const noHdrDisplay = await buildDeviceProfile(fullEnv({ matchesHighDynamicRange: () => false }));
    expect(noHdrDisplay.hdr.hdr10).toBe(false);
  });

  it("sets maxStreamBitrateBps to null unconditionally (web has no client-declared network cap)", async () => {
    expect((await buildDeviceProfile(fullEnv())).maxStreamBitrateBps).toBeNull();
    expect((await buildDeviceProfile(bareEnv())).maxStreamBitrateBps).toBeNull();
  });

  it("keeps subtitle rendering to what the player lane actually renders (srt/vtt text, no image burn-in)", async () => {
    const profile = await buildDeviceProfile(fullEnv());
    expect(profile.subtitles.renderText.sort()).toEqual(["subrip", "webvtt"]);
    expect(profile.subtitles.renderImage).toBe(false);
    expect(profile.subtitles.hlsVtt).toBe(true);
  });
});
