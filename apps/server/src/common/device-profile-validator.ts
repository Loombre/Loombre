// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/device-profile-validator.ts
//
// Strict server-side validation of DeviceProfile (docs/PLAYBACK.md §2.2,
// STATE.md P2.3/P2.12): login's deviceProfile was previously only checked
// as "a plain object" — this compiles the ACTUAL shape (mirroring
// packages/contract/openapi.yaml's DeviceProfile schema, including its
// nested Container/VideoCodec/AudioCodec/SubtitleCodec enums 1:1) with Ajv
// and rejects anything that doesn't match. A malformed profile is never
// "best-guessed" — PLAYBACK.md §2.2 is explicit that this is reasoned as a
// 422 upstream of plan(), not patched inside it.
//
// The schema below is a hand-mirror of the contract, not a runtime YAML
// parse of openapi.yaml — the same "close enough to catch shape drift"
// approach apps/server/test/conformance.spec.ts already uses for
// TokenPair/Capabilities (see that file's header). apps/server has no YAML
// parser dependency; adding one for a single schema would be a new
// dependency for something the contract test suite already keeps honest.
//
// Compiled exactly ONCE, at construction (this service is a Nest
// singleton, constructed once per process boot) — never per-request
// (CLAUDE.md invariant 9, Tier-0: no CPU-heavy work on the request path).

import { Injectable } from "@nestjs/common";
// Named import, not `import Ajv from "ajv"`: under this repo's
// module/moduleResolution: NodeNext + esModuleInterop, ajv's default
// export type-checks as a namespace (not a constructable class) — a known
// ajv+NodeNext typings interaction. Ajv's dist also exports the class by
// name (`export declare class Ajv ...; export default Ajv;`), so importing
// the named binding sidesteps the synthetic-default confusion entirely
// while resolving to the exact same runtime value.
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

// Mirrors packages/contract/openapi.yaml components.schemas.{Container,
// VideoCodec,AudioCodec,SubtitleCodec} enums verbatim.
const CONTAINER_ENUM = ["mp4", "mkv", "webm", "avi", "ts", "mov", "flac", "mp3", "ogg", "m4a", "wav"];
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

/** Mirrors packages/contract/openapi.yaml components.schemas.DeviceProfile. */
export const DEVICE_PROFILE_SCHEMA = {
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

export type DeviceProfileValidationResult = { valid: true } | { valid: false; errors: string };

@Injectable()
export class DeviceProfileValidatorService {
  private readonly ajv: Ajv;
  private readonly validateFn: ValidateFunction;

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.validateFn = this.ajv.compile(DEVICE_PROFILE_SCHEMA);
  }

  validate(profile: unknown): DeviceProfileValidationResult {
    const valid = this.validateFn(profile);
    if (valid) return { valid: true };
    return { valid: false, errors: this.ajv.errorsText(this.validateFn.errors) };
  }
}
