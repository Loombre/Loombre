// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage B — Video (docs/PLAYBACK.md §3, quoted verbatim):
 *
 *   "Stage B — Video.
 *   1. Interlaced source → transcode (deinterlace), reason `video-interlaced`.
 *   2. Codec not in device.video → transcode, `video-codec-unsupported`.
 *   3. Codec supported but profile/level/bitDepth/resolution/framerate
 *      exceeds the device entry → transcode, one reason per exceeded axis:
 *      `video-profile-unsupported` | `video-level-exceeds-device` |
 *      `video-bitdepth-unsupported` | `video-resolution-exceeds-device` |
 *      `video-framerate-exceeds-device`.
 *   4. Else verdict `copy`."
 *
 * Scope (Phase 3 Step 2b, orchestrator-locked binding interpretation): this
 * stage evaluates ONLY the SELECTED video stream
 * (`selection.videoStreamIndex`). A null selection, or a media with no video
 * streams at all (or a selection index that — defensively — doesn't resolve
 * to any stream), means there is no video work to evaluate: VACUOUS PASS
 * (verdict `direct-play`, i.e. the "copy/no escalation" severity, zero
 * reasons). This is exactly what the Step 1 direct-play generator
 * (`matrix/lib/generators.ts`'s `genDirectPlayVideoInput`, which places
 * `profile: null, level: null` deliberately) and the future §10 cases with
 * `selection.videoStreamIndex: null` assume — breaking it would fail the
 * active direct-play-bias property test.
 *
 * Rule interaction (normative per seed cases 002 and 007 — matrix/002-*.yaml,
 * matrix/007-*.yaml, both NORMATIVE and never edited by this stage's PR):
 *   - Rule 1 (interlaced) and rule 2 (codec-unsupported) are INDEPENDENT
 *     checks — both can fire for the same stream. Seed case 007 (mpeg2,
 *     interlaced, codec absent from web-chrome's device.video) expects
 *     EXACTLY `[video-interlaced, video-codec-unsupported]` (after stage A's
 *     own container reason) — proving interlaced is never short-circuited by
 *     an unsupported codec.
 *   - Rule 2 firing (no device.video entry accommodates the stream's codec)
 *     DOES short-circuit rule 3's axis checks — you cannot "exceed" a device
 *     entry that doesn't exist. Seed case 002 (hevc vs constrained-tv, which
 *     only declares h264) expects EXACTLY `[video-codec-unsupported]` — no
 *     axis reasons follow it, because there is no hevc entry to compare
 *     profile/level/bitDepth/resolution/framerate against.
 *   - Reason order within the stage ("by stage, then axis" — docs/PLAYBACK.md
 *     §4): interlaced, then codec-unsupported, then the axis order EXACTLY
 *     as the §3 sentence lists them — profile, level, bitDepth, resolution,
 *     framerate.
 *
 * Null-axis semantics (VACUOUS PASS, binding interpretation constraint 4):
 * `stream.profile === null` OR the matched device entry's `maxProfile ===
 * null` → no profile check fires. Likewise `stream.level === null` OR
 * `maxLevel === null` → no level check. `bitDepth`/`width`/`height`/
 * `frameRate` are ALWAYS present on `VideoStream` (§2.1: non-nullable
 * fields), so their checks are unconditional numeric comparisons:
 * `bitDepth > maxBitDepth` → `video-bitdepth-unsupported`; `(width >
 * maxWidth OR height > maxHeight)` → exactly ONE
 * `video-resolution-exceeds-device` (never two reasons for one oversized
 * frame); `frameRate > maxFrameRate` → `video-framerate-exceeds-device`.
 *
 * Multiple `device.video` entries for the same codec (binding interpretation
 * constraint 6 — NOT exercised by any current fixture, checked at Step 2b
 * authoring time: every shared fixture in matrix/fixtures/devices.yaml and
 * every case-inline device declares at most one entry per codec): the stream
 * passes (no rule-3 reasons) if ANY entry for that codec accommodates every
 * axis. When NONE do, the reported reasons come from comparing against a
 * single SYNTHETIC "most permissive per axis" entry built from all of that
 * codec's entries (`mostPermissiveEntry` below) — never from an arbitrarily
 * chosen single real entry, and never by unioning per-entry reason sets
 * (which could wrongly blame an axis that some entry already accommodates).
 *
 * `maxBitrateBps` is NOT checked by this stage (docs/PLAYBACK.md §3 Stage
 * B.3's axis list excludes it, and §4's reason enum has no matching code —
 * bitrate-vs-network/device-cap is Stage F's dimension, `bitrate-exceeds-
 * network`).
 */
import type { DeviceProfile, DeviceProfileVideoEntry, MediaInfo, VideoCodec, VideoStream } from "../types.js";
import type { PlanReason, PlanReasonCode } from "../reasons.js";
import type { StageResult } from "./types.js";

function reason(code: PlanReasonCode, streamIndex: number, detail?: string): PlanReason {
  const r: PlanReason = { code, streamIndex };
  if (detail !== undefined) r.detail = detail;
  return r;
}

// ---------------------------------------------------------------------------
// Profile ladder (SPEC AMBIGUITY RESOLUTION — docs/PLAYBACK.md §3 Stage B.3
// says a stream "exceeds" the device entry's profile but never defines an
// ordering profile strings compare under; this is a candidate
// docs/PLAYBACK.md clarification PR, not a silent implementation choice).
//
// Resolution adopted here (per this step's binding interpretation constraint
// 5), verbatim:
//   h264: baseline < main < high < high10
//   hevc: main < main10
//   vp9:  profile0 < profile2
//   any other codec (av1, mpeg2, vc1, mpeg4, unknown): exact-string-match-
//     or-exceeds — there is no known ladder, so anything other than an exact
//     string match against the device's maxProfile is treated as exceeding
//     it.
// Conservative rule: a stream profile string that is NOT a member of its
// codec's ladder (and is not string-identical to the device's maxProfile)
// → `video-profile-unsupported`, with `detail` naming BOTH strings. This
// also covers the case where the device's OWN maxProfile isn't a ladder
// member (e.g. a malformed/exotic profile declaration): unrankable on either
// side is treated the same as "exceeds", never as "assume compatible".
// ---------------------------------------------------------------------------
const PROFILE_LADDERS: Partial<Record<VideoCodec, readonly string[]>> = {
  h264: ["baseline", "main", "high", "high10"],
  hevc: ["main", "main10"],
  vp9: ["profile0", "profile2"],
};

/** True iff `streamProfile` exceeds `maxProfile` for `codec` (profile axis
 *  only — caller is responsible for the null-vacuous-pass short-circuit). */
function profileExceeds(codec: VideoCodec, streamProfile: string, maxProfile: string): boolean {
  if (streamProfile === maxProfile) return false;
  const ladder = PROFILE_LADDERS[codec];
  if (ladder) {
    const streamRank = ladder.indexOf(streamProfile);
    const maxRank = ladder.indexOf(maxProfile);
    if (streamRank !== -1 && maxRank !== -1) {
      return streamRank > maxRank;
    }
  }
  // No ladder for this codec (exact-string-match-or-exceeds), or one/both
  // profile strings aren't members of the codec's ladder: conservative rule.
  return true;
}

/** All per-axis Stage B.3 checks against a SINGLE device entry, in the
 *  spec's exact axis order (profile, level, bitDepth, resolution,
 *  framerate). Returns [] iff the stream is fully accommodated by `entry`. */
function axisReasons(stream: VideoStream, entry: DeviceProfileVideoEntry): PlanReason[] {
  const reasons: PlanReason[] = [];

  if (stream.profile !== null && entry.maxProfile !== null) {
    if (profileExceeds(stream.codec, stream.profile, entry.maxProfile)) {
      reasons.push(
        reason("video-profile-unsupported", stream.index, `profile=${stream.profile} max=${entry.maxProfile}`),
      );
    }
  }

  if (stream.level !== null && entry.maxLevel !== null) {
    if (stream.level > entry.maxLevel) {
      reasons.push(reason("video-level-exceeds-device", stream.index, `level=${stream.level} max=${entry.maxLevel}`));
    }
  }

  if (stream.bitDepth > entry.maxBitDepth) {
    reasons.push(
      reason("video-bitdepth-unsupported", stream.index, `bitDepth=${stream.bitDepth} max=${entry.maxBitDepth}`),
    );
  }

  if (stream.width > entry.maxWidth || stream.height > entry.maxHeight) {
    reasons.push(
      reason(
        "video-resolution-exceeds-device",
        stream.index,
        `${stream.width}x${stream.height} max=${entry.maxWidth}x${entry.maxHeight}`,
      ),
    );
  }

  if (stream.frameRate > entry.maxFrameRate) {
    reasons.push(
      reason(
        "video-framerate-exceeds-device",
        stream.index,
        `frameRate=${stream.frameRate} max=${entry.maxFrameRate}`,
      ),
    );
  }

  return reasons;
}

/** The most permissive `maxProfile` across every same-codec entry: `null`
 *  (unconstrained — always the most permissive value) wins immediately if
 *  ANY entry declares it; otherwise the highest-ranked ladder member (first
 *  entry wins ties / unrankable values, deterministically — every current
 *  fixture declares at most one entry per codec, so this path is documented
 *  defensive completeness, not fixture-exercised behavior; see this
 *  module's header note on binding interpretation constraint 6). */
function mostPermissiveProfile(codec: VideoCodec, entries: readonly DeviceProfileVideoEntry[]): string | null {
  if (entries.some((e) => e.maxProfile === null)) return null;
  const ladder = PROFILE_LADDERS[codec];
  const first = entries[0];
  if (!first) return null;
  let best = first.maxProfile as string;
  if (!ladder) return best;
  let bestRank = ladder.indexOf(best);
  for (const entry of entries.slice(1)) {
    const candidate = entry.maxProfile as string;
    const rank = ladder.indexOf(candidate);
    if (rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

/** Synthesizes a single "most permissive per axis" device entry from every
 *  device.video entry matching the stream's codec (binding interpretation
 *  constraint 6). Only ever consulted when NO single real entry
 *  accommodates every axis — used purely to compute the reported reasons in
 *  that case, never to decide pass/fail (that's the `entries.some(...)`
 *  check in `evaluateVideo`). */
function mostPermissiveEntry(codec: VideoCodec, entries: readonly DeviceProfileVideoEntry[]): DeviceProfileVideoEntry {
  const maxLevel = entries.some((e) => e.maxLevel === null)
    ? null
    : Math.max(...entries.map((e) => e.maxLevel as number));

  return {
    codec,
    maxProfile: mostPermissiveProfile(codec, entries),
    maxLevel,
    maxBitDepth: Math.max(...entries.map((e) => e.maxBitDepth)) as 8 | 10,
    maxWidth: Math.max(...entries.map((e) => e.maxWidth)),
    maxHeight: Math.max(...entries.map((e) => e.maxHeight)),
    maxFrameRate: Math.max(...entries.map((e) => e.maxFrameRate)),
    // Not checked by this stage (module header) — value is irrelevant.
    maxBitrateBps: null,
  };
}

/**
 * Stage B (docs/PLAYBACK.md §3). Evaluates only the SELECTED video stream
 * (`videoStreamIndex`); see this module's header for the full rule
 * interaction, null-vacuous-pass, and multi-entry semantics.
 */
export function evaluateVideo(media: MediaInfo, device: DeviceProfile, videoStreamIndex: number | null): StageResult {
  if (videoStreamIndex === null || media.video.length === 0) {
    return { verdict: "direct-play", reasons: [] };
  }

  const stream = media.video.find((v) => v.index === videoStreamIndex);
  if (!stream) {
    // Defensive: a selection index that doesn't resolve to any stream is
    // structurally invalid input (matrix-meta.spec.ts's structural-sanity
    // check forbids it for every matrix case, and the property-test
    // generators never produce it), but `plan()` must stay TOTAL
    // (docs/PLAYBACK.md §10 property 3) — treat as "no video work", the
    // same vacuous pass as a null selection.
    return { verdict: "direct-play", reasons: [] };
  }

  const reasons: PlanReason[] = [];

  // Rule 1 — interlaced (independent of rule 2; see module header / seed 007).
  if (stream.interlaced) {
    reasons.push(reason("video-interlaced", stream.index));
  }

  // Rule 2 — codec supported at all?
  const entries = device.video.filter((v) => v.codec === stream.codec);
  if (entries.length === 0) {
    reasons.push(reason("video-codec-unsupported", stream.index, `codec=${stream.codec}`));
  } else if (!entries.some((entry) => axisReasons(stream, entry).length === 0)) {
    // Rule 3 — codec supported, but no single entry accommodates every
    // axis. Report against the synthetic "most permissive per axis" entry
    // (binding interpretation constraint 6).
    let reported = axisReasons(stream, mostPermissiveEntry(stream.codec, entries));
    if (reported.length === 0) {
      // Defensive fallback (reachable only via multiple same-codec entries
      // whose permissive axes don't overlap in any one real entry — e.g.
      // one entry covers width, another covers height, neither covers
      // both; the property-test generator's 0-3 same-codec device.video
      // entries can construct this, no current fixture does): the
      // per-axis-best synthetic entry can accommodate every axis even
      // though `entries.some(...)` above already proved every REAL entry
      // fails on at least one. Fall back to the first entry's own axis
      // reasons — guaranteed non-empty by that same proof — so a stage
      // that determined "no entry passes" never reports zero reasons
      // (docs/PLAYBACK.md §10 property 4, reason completeness).
      reported = axisReasons(stream, entries[0]!);
    }
    reasons.push(...reported);
  }
  // else: some entry accommodates every axis — rule 3 contributes nothing.

  return { verdict: reasons.length > 0 ? "transcode" : "direct-play", reasons };
}
