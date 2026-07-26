// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage D — Audio (docs/PLAYBACK.md §3, quoted verbatim):
 *
 *   "Stage D — Audio (per selected stream).
 *   1. Codec unsupported by device → transcode audio,
 *      `audio-codec-unsupported`.
 *   2. Channels > device max for that codec → transcode audio (downmix to
 *      device max, standard mixdown matrices, no dynamic-range compression
 *      by default), `audio-channels-exceed-device`.
 *   3. TrueHD/DTS-HD: copy ONLY when device entry has `passthrough:true`;
 *      else transcode, `audio-passthrough-unsupported`. Atmos flag lost on
 *      transcode → additional informational reason `audio-atmos-lost`.
 *   4. Target codec = first of `policy.audioTranscodeCodecPriority` present
 *      in device.audio. Target bitrate: 2ch→160k, 6ch→384k, 8ch→512k (opus
 *      scales 0.75×). Sample rate preserved ≤48k, else resample 48k.
 *   5. Music mode (no video streams): FLAC/ALAC copy when supported;
 *      gapless requires `direct-play` or fmp4 `direct-stream` — a music
 *      transcode carries reason `gapless-degraded` so clients can warn."
 *
 * Scope (Phase 3 Step 2d, orchestrator-locked binding interpretation
 * constraint 1 — mirrors Stage B/C's documented scoping EXACTLY): this
 * stage evaluates ONLY the SELECTED audio stream
 * (`selection.audioStreamIndex`). A null selection, a media with no audio
 * streams at all, or a selection index that — defensively — doesn't resolve
 * to any stream, is a VACUOUS PASS: verdict `'direct-play'`, zero reasons.
 * `plan()` must stay TOTAL (docs/PLAYBACK.md §10 property 3); this defensive
 * branch is not exercised by any matrix case (matrix-meta.spec.ts's
 * structural-sanity check requires every case's non-null selection index to
 * resolve to a real stream) — it is unit-tested only
 * (test/stages/audio.spec.ts), same as stages/video.ts's and
 * stages/hdr.ts's identical defensive branches.
 *
 * ---------------------------------------------------------------------------
 * Rule interaction (binding interpretation constraint 2, normative per seed
 * cases 004 and 009 — matrix/004-*.yaml, matrix/009-*.yaml, both NORMATIVE
 * and never edited by this stage's PR):
 *   - Rule 1 (no `device.audio` entry for the stream's codec) SHORT-CIRCUITS
 *     rules 2 and 3 — there is no entry to compare channels/passthrough
 *     against. Seed case 004's device (web-chrome) DOES declare a `truehd`
 *     entry (`maxChannels: 8, passthrough: false`), so rule 1 never fires
 *     there — that seed exercises rule 3, not rule 1's short-circuit; the
 *     short-circuit itself is proven by this module's own unit tests
 *     (mirroring stages/video.ts's seed-002-normative pattern, since no
 *     current seed case happens to isolate rule 1's short-circuit alone).
 *   - When an entry EXISTS: rule 2 (`stream.channels > entry.maxChannels`)
 *     and rule 3 (codec is `truehd` or `dtshd` AND `entry.passthrough !==
 *     true`) are INDEPENDENT checks that can BOTH fire, in that order (2
 *     then 3). Seed case 004 (web-chrome's truehd entry: `maxChannels: 8`,
 *     stream channels: 8 — exactly at the boundary, NOT exceeding) proves
 *     rule 2 does NOT fire merely because rule 3 does — the expected reason
 *     list is exactly `[audio-passthrough-unsupported, audio-atmos-lost]`,
 *     with no `audio-channels-exceed-device`. Plain `dts` is NEVER treated
 *     as DTS-HD — rules 1/2 only apply to it; rule 3's codec check is
 *     `truehd`/`dtshd` ONLY (matrix cases 218/219/221 pin this both ways:
 *     copying despite a passthrough:false device entry, and channel-exceed
 *     firing alone without a passthrough reason).
 *
 * Atmos (binding interpretation constraint 3): `stream.hasAtmos === true`
 * AND the stage's OWN verdict is `'transcode'` → append the informational
 * `audio-atmos-lost` reason AFTER every blocking reason this stage fired.
 * This is NOT scoped to rule 3 alone — seed case 004 is a rule-3-only
 * scenario, but the interpretation (and this module's implementation) fires
 * atmos-lost whenever ANY of this stage's rules escalated to transcode
 * (matrix case 211: rule 1 alone; case 229: rule 2 alone on an eac3 stream,
 * proving the Atmos check is codec-agnostic even though §2.1's own
 * `hasAtmos` field comment scopes real-world Atmos carriage to TrueHD/EAC3
 * JOC side data — this stage does not re-validate that scoping, it trusts
 * the input, matching compat-preview.ts's identical `hasAtmos && blocked`
 * shape). Atmos with a successful passthrough COPY → verdict stays
 * `'direct-play'` → no reasons at all (cases 206/207/212/213/217).
 *
 * Music mode / gapless (binding interpretation constraint 5): "music mode"
 * = `media.video.length === 0` (an EMPTY video array — NOT merely "no video
 * stream selected"; a movie with real video streams where the caller only
 * selected audio is not music mode, matching Stage B/C's own `video.length
 * === 0` vacuous-pass condition, not `videoStreamIndex === null` alone).
 * `gapless-degraded` (informational) fires when music mode AND this stage's
 * OWN verdict is `'transcode'` — appended AFTER `audio-atmos-lost` would be
 * (full order: blocking reason(s)..., `audio-atmos-lost`?, then
 * `gapless-degraded`?). Seed case 009 (music mode, flac 6ch vs a 2ch-capped
 * device) pins exactly `[audio-channels-exceed-device, gapless-degraded]`
 * (no atmos — the seed's stream has `hasAtmos: false`).
 *
 * 'ALAC' does not exist anywhere in the closed §2.1 `AudioCodec` enum — FLAC
 * is the only lossless member that enum declares. This is a spec-text
 * artifact (§3 Stage D.5 mentions "FLAC/ALAC" but §2.1 never defines an
 * ALAC codec value), not a silent omission: this module does not invent an
 * `'alac'` codec value, and FLAC's ordinary rule 1/2/3 handling already
 * covers "copy when supported" for the one lossless codec that actually
 * exists in the type.
 *
 * SURFACED, NOT RESOLVED (matches Step 2c's remux-question precedent —
 * flagged here and in the completion report for owner/spec review, per this
 * step's binding instructions, never silently resolved by this
 * implementation): strict §3 Stage D.5 text ties `gapless-degraded` to a
 * music TRANSCODE only ("a music transcode carries reason
 * gapless-degraded"). But the same sentence's OWN requirement — gapless
 * needs `direct-play` OR fmp4 `direct-stream` — is *also* violated by a
 * music `direct-stream` into `ts-hls` (`device.hls.supportsFmp4 === false`):
 * that combination breaks gapless exactly as thoroughly as an audio
 * transcode does, yet under the strict rule-5 text (which only look at
 * THIS stage's own verdict, never at the plan's eventual `container` field)
 * that case is reason-free. This module deliberately does NOT special-case
 * it — Stage D has no visibility into `device.hls.supportsFmp4` at all
 * (matrix cases 249/250 pin both the fmp4 and ts-hls direct-stream variants
 * as reason-free, identically, per strict text) — leaving the question open
 * for the orchestrator/spec owner exactly as instructed.
 *
 * Rule 4 (target codec/channels/bitrate selection) MATERIALIZES IN ASSEMBLY
 * (src/plan.ts), not as a Stage D reason — this stage's `StageResult` has no
 * field for it (docs/PLAYBACK.md §3 lists rule 4 as a plan-construction
 * detail, not a reason-emitting check; see src/plan.ts's own header comment
 * for the assembly-side implementation and its own documented
 * interpretations of the bitrate-band boundaries and the priority-codec
 * fallback). Sample-rate preservation/resample-to-48k (also rule 4) has NO
 * §5 `PlaybackPlanAudio` output field at all — it is `args/builder.ts`
 * (§11 step 4) territory; this stage emits nothing for it and doesn't need
 * the stream's `sampleRate` field at all.
 */
import type { AudioStream, DeviceProfile, MediaInfo } from "../types.js";
import type { PlanReason, PlanReasonCode } from "../reasons.js";
import type { StageResult } from "./types.js";

function reason(code: PlanReasonCode, streamIndex: number, detail?: string): PlanReason {
  const r: PlanReason = { code, streamIndex };
  if (detail !== undefined) r.detail = detail;
  return r;
}

/** Rule 3's codec gate: TrueHD/DTS-HD ONLY — plain `dts` (or anything else)
 *  is never subject to the bitstream-passthrough check (binding
 *  interpretation constraint 2 — "Plain `dts` is NOT DTS-HD"). */
function isBitstreamPassthroughCodec(codec: AudioStream["codec"]): boolean {
  return codec === "truehd" || codec === "dtshd";
}

/**
 * Stage D (docs/PLAYBACK.md §3). Evaluates only the SELECTED audio stream;
 * see this module's header for the full rule interaction, the atmos/gapless
 * append order, and the two spec-text notes (ALAC/rule-4 assembly split).
 */
export function evaluateAudio(media: MediaInfo, device: DeviceProfile, audioStreamIndex: number | null): StageResult {
  if (audioStreamIndex === null || media.audio.length === 0) {
    return { verdict: "direct-play", reasons: [] };
  }

  const stream = media.audio.find((a) => a.index === audioStreamIndex);
  if (!stream) {
    // Defensive: a selection index that doesn't resolve to any stream is
    // structurally invalid input (matrix-meta.spec.ts's structural-sanity
    // check forbids it for every matrix case, and the property-test
    // generators never produce it), but `plan()` must stay TOTAL
    // (docs/PLAYBACK.md §10 property 3) — treat as "no audio work", the
    // same vacuous pass as a null selection (mirrors stages/video.ts and
    // stages/hdr.ts exactly).
    return { verdict: "direct-play", reasons: [] };
  }

  const reasons: PlanReason[] = [];
  const entry = device.audio.find((a) => a.codec === stream.codec);

  if (!entry) {
    // Rule 1 — short-circuits rules 2 and 3 (binding interpretation
    // constraint 2): no entry to compare channels/passthrough against.
    reasons.push(reason("audio-codec-unsupported", stream.index, `codec=${stream.codec}`));
  } else {
    // Rule 2 and rule 3 are INDEPENDENT checks that can both fire, in this
    // order, when an entry exists (seed case 004: entry exists, channels
    // exactly at the entry's cap so rule 2 stays silent while rule 3 still
    // fires alone).
    if (stream.channels > entry.maxChannels) {
      reasons.push(
        reason(
          "audio-channels-exceed-device",
          stream.index,
          `channels=${stream.channels} max=${entry.maxChannels}`,
        ),
      );
    }
    if (isBitstreamPassthroughCodec(stream.codec) && entry.passthrough !== true) {
      reasons.push(
        reason(
          "audio-passthrough-unsupported",
          stream.index,
          `codec=${stream.codec} passthrough=${entry.passthrough}`,
        ),
      );
    }
  }

  const isTranscode = reasons.length > 0;

  // Atmos (binding interpretation constraint 3): fires alongside ANY
  // blocking reason this stage produced, not merely rule 3 — appended AFTER
  // every blocking reason, BEFORE gapless-degraded.
  if (stream.hasAtmos && isTranscode) {
    reasons.push(reason("audio-atmos-lost", stream.index));
  }

  // Rule 5 — music mode gapless degradation (binding interpretation
  // constraint 5): media.video.length === 0, NOT merely "no video
  // selected". Fires only alongside THIS stage's own transcode verdict;
  // appended last (after audio-atmos-lost).
  const isMusicMode = media.video.length === 0;
  if (isMusicMode && isTranscode) {
    reasons.push(reason("gapless-degraded", stream.index));
  }

  return { verdict: isTranscode ? "transcode" : "direct-play", reasons };
}
