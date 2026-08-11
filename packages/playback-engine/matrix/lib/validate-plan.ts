// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Structural validator for PlaybackPlan (docs/PLAYBACK.md §5 output
 * contract) — the property-test harness's totality property (§10 property
 * 3) asserts every plan produced from a randomly-generated valid input
 * satisfies this validator: decision/container/action/strategy enum
 * membership, every reason code drawn from the closed §4 enum (including
 * the two parameterized `hw-encoder-selected:`/`software-fallback:`
 * prefixes), ladder rung shape, `ffmpegArgs` all strings, and a semver
 * `engineVersion`.
 *
 * Throws (with a descriptive message) on the first violation found — this
 * is a validator, not a boolean predicate, so property-test failures name
 * exactly what was wrong instead of just "invalid".
 */
import {
  BLOCKING_REASON_CODES,
  FIXED_INFORMATIONAL_REASON_CODES,
  type PlanReasonCode,
} from "../../src/reasons.js";
import type { LadderRung, PlaybackPlan } from "../../src/types.js";

const VALID_DECISIONS = new Set(["direct-play", "direct-stream", "remux", "transcode"]);
const VALID_CONTAINERS = new Set(["source", "fmp4-hls", "ts-hls", "mp4"]);
const VALID_VIDEO_ACTIONS = new Set(["copy", "transcode", "none"]);
const VALID_AUDIO_ACTIONS = new Set(["copy", "transcode", "none"]);
const VALID_SUBTITLE_STRATEGIES = new Set(["none", "embed", "hls-vtt", "burn-in"]);
const VALID_TARGET_VIDEO_CODECS = new Set(["h264", "hevc", "av1"]);
const VALID_ENCODERS = new Set(["videotoolbox", "qsv", "vaapi", "nvenc", "amf", "d3d11va", "software"]);
const VALID_TONE_MAP_METHODS = new Set(["opencl", "vulkan", "videotoolbox", "cuda", "cpu-zscale"]);
const VALID_LADDER_CODECS = new Set(["h264", "hevc", "av1"]);

// RFC-ish semver: MAJOR.MINOR.PATCH with optional -prerelease/+build.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function isPlanReasonCode(code: string): code is PlanReasonCode {
  if ((BLOCKING_REASON_CODES as readonly string[]).includes(code)) return true;
  if ((FIXED_INFORMATIONAL_REASON_CODES as readonly string[]).includes(code)) return true;
  if (code.startsWith("hw-encoder-selected:")) return true;
  if (code.startsWith("software-fallback:")) return true;
  return false;
}

function fail(message: string): never {
  throw new Error(`validatePlan: ${message}`);
}

function validateLadderRung(rung: LadderRung, i: number): void {
  if (rung === null || typeof rung !== "object") fail(`ladder[${i}] must be an object`);
  if (typeof rung.heightPx !== "number" || !Number.isFinite(rung.heightPx) || rung.heightPx <= 0) {
    fail(`ladder[${i}].heightPx must be a positive finite number, got ${JSON.stringify(rung.heightPx)}`);
  }
  if (
    typeof rung.videoBitrateBps !== "number" ||
    !Number.isFinite(rung.videoBitrateBps) ||
    rung.videoBitrateBps <= 0
  ) {
    fail(`ladder[${i}].videoBitrateBps must be a positive finite number, got ${JSON.stringify(rung.videoBitrateBps)}`);
  }
  if (
    typeof rung.audioBitrateBps !== "number" ||
    !Number.isFinite(rung.audioBitrateBps) ||
    rung.audioBitrateBps <= 0
  ) {
    fail(`ladder[${i}].audioBitrateBps must be a positive finite number, got ${JSON.stringify(rung.audioBitrateBps)}`);
  }
  if (!VALID_LADDER_CODECS.has(rung.codec)) {
    fail(`ladder[${i}].codec must be h264|hevc, got ${JSON.stringify(rung.codec)}`);
  }
}

/** Throws on the first structural violation; returns void on a valid plan. */
export function validatePlan(plan: PlaybackPlan): void {
  if (plan === null || typeof plan !== "object") fail("plan must be an object");

  if (!VALID_DECISIONS.has(plan.decision)) {
    fail(`decision ${JSON.stringify(plan.decision)} not in the closed §5 enum`);
  }
  if (!VALID_CONTAINERS.has(plan.container)) {
    fail(`container ${JSON.stringify(plan.container)} not in the closed §5 enum`);
  }

  if (!Array.isArray(plan.reasons)) fail("reasons must be an array");
  // §5: "reasons REQUIRED, may be [] only for direct-play" — this bounds
  // NON-direct-play decisions (they must carry >=1 reason); it does NOT
  // force [] onto direct-play. INFORMATIONAL reasons are permitted on a
  // direct-play plan (Step 2c/2e orchestrator rulings: e.g. a
  // direct-playable container with an ASS sub going hls-vtt carries
  // subtitle-styling-lost while the decision stays direct-play — matrix
  // cases 278/322). What direct-play can NEVER carry is a BLOCKING-class
  // reason — §4's class split: blocking forces severity, so any blocking
  // reason contradicts a direct-play decision (this is also property 4's
  // contrapositive).
  if (plan.decision === "direct-play") {
    const blocking = plan.reasons.filter(
      (r) => typeof r.code === "string" && (BLOCKING_REASON_CODES as readonly string[]).includes(r.code),
    );
    if (blocking.length > 0) {
      fail(
        `direct-play must not carry blocking-class reasons (§4 class split), got ${JSON.stringify(blocking.map((r) => r.code))}`,
      );
    }
  } else if (plan.reasons.length === 0) {
    fail(`decision "${plan.decision}" must carry >=1 reason (§5: reasons may be [] only for direct-play)`);
  }
  plan.reasons.forEach((r, i) => {
    if (r === null || typeof r !== "object") fail(`reasons[${i}] must be an object`);
    if (typeof r.code !== "string" || !isPlanReasonCode(r.code)) {
      fail(`reasons[${i}].code ${JSON.stringify(r.code)} not in the closed §4 enum`);
    }
    if (r.streamIndex !== undefined && typeof r.streamIndex !== "number") {
      fail(`reasons[${i}].streamIndex must be a number when present`);
    }
    if (r.detail !== undefined && typeof r.detail !== "string") {
      fail(`reasons[${i}].detail must be a string when present`);
    }
  });

  if (plan.video === null || typeof plan.video !== "object" || !VALID_VIDEO_ACTIONS.has(plan.video.action)) {
    fail(`video.action ${JSON.stringify(plan.video?.action)} not in the closed §5 enum`);
  }
  if (plan.video.targetCodec !== undefined && !VALID_TARGET_VIDEO_CODECS.has(plan.video.targetCodec)) {
    fail(`video.targetCodec ${JSON.stringify(plan.video.targetCodec)} not h264|hevc`);
  }
  if (plan.video.encoder !== undefined && !VALID_ENCODERS.has(plan.video.encoder)) {
    fail(`video.encoder ${JSON.stringify(plan.video.encoder)} not a valid HardwareBackend`);
  }
  if (plan.video.toneMap !== undefined && !VALID_TONE_MAP_METHODS.has(plan.video.toneMap)) {
    fail(`video.toneMap ${JSON.stringify(plan.video.toneMap)} not a valid ToneMapMethod`);
  }
  if (plan.video.openGop !== undefined && typeof plan.video.openGop !== "boolean") {
    fail(`video.openGop must be a boolean when present, got ${JSON.stringify(plan.video.openGop)}`);
  }

  if (plan.audio === null || typeof plan.audio !== "object" || !VALID_AUDIO_ACTIONS.has(plan.audio.action)) {
    fail(`audio.action ${JSON.stringify(plan.audio?.action)} not in the closed §5 enum`);
  }
  if (
    plan.audio.targetChannels !== undefined &&
    (typeof plan.audio.targetChannels !== "number" || plan.audio.targetChannels <= 0)
  ) {
    fail("audio.targetChannels must be a positive number when present");
  }
  if (
    plan.audio.targetBitrateBps !== undefined &&
    (typeof plan.audio.targetBitrateBps !== "number" || plan.audio.targetBitrateBps <= 0)
  ) {
    fail("audio.targetBitrateBps must be a positive number when present");
  }

  if (
    plan.subtitle === null ||
    typeof plan.subtitle !== "object" ||
    !VALID_SUBTITLE_STRATEGIES.has(plan.subtitle.strategy)
  ) {
    fail(`subtitle.strategy ${JSON.stringify(plan.subtitle?.strategy)} not in the closed §5 enum`);
  }
  if (plan.subtitle.streamIndex !== undefined && typeof plan.subtitle.streamIndex !== "number") {
    fail("subtitle.streamIndex must be a number when present");
  }

  if (!Array.isArray(plan.ladder)) fail("ladder must be an array");
  plan.ladder.forEach(validateLadderRung);

  if (!Array.isArray(plan.ffmpegArgs) || !plan.ffmpegArgs.every((a) => typeof a === "string")) {
    fail("ffmpegArgs must be an array of strings");
  }

  if (typeof plan.engineVersion !== "string" || !SEMVER_RE.test(plan.engineVersion)) {
    fail(`engineVersion ${JSON.stringify(plan.engineVersion)} is not semver`);
  }
}
