// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage F — Bitrate & ladder (docs/PLAYBACK.md §3, quoted verbatim):
 *
 *   "Stage F — Bitrate & ladder (§7). If final video verdict is copy AND
 *   `overallBitrateBps > network.maxBitrateBps` → transcode video, reason
 *   `bitrate-exceeds-network` (unless `network.isLocal` and bitrate ≤ device
 *   cap). Ladder is constructed whenever the decision is transcode."
 *
 * And docs/PLAYBACK.md §7 (quoted verbatim):
 *
 *   "`LadderRung { heightPx, videoBitrateBps, audioBitrateBps, codec }`.
 *   Instance default table (policy-overridable): 2160p/16M/hevc · 1080p/8M ·
 *   1080p/4M · 720p/3M · 480p/1.5M · 360p/0.8M (h264 below 2160 unless
 *   `hevcEncodePreferred` and device hevc → hevc, −25% bitrate). Construction
 *   rules: never exceed source height; never exceed source bitrate; drop
 *   rungs above `network.maxBitrateBps` (keep at least the lowest rung);
 *   master playlist lists all surviving rungs; each rung is a lazily started
 *   transcode pipeline — only the initially selected rung starts; a client
 *   ABR switch starts the sibling rung at the requested segment. `isLocal`
 *   networks skip the network cap but honor device caps."
 *
 * This is the LAST stage of the docs/PLAYBACK.md §11 step-2 sequence (Phase 3
 * Step 2f) — Stages A-E already each have their own real module;
 * `src/plan.ts` replaces its final `notYetImplementedStage()` call site
 * (Stage F) with `evaluateBitrate` from this module, and separately calls
 * `buildLadder` (also this module) to populate the §5 `ladder` output field.
 * `stages/not-implemented.ts` is left in place, unused, per this step's
 * binding instructions (no other stages/* module may be touched).
 *
 * ---------------------------------------------------------------------------
 * TWO EXPORTS, TWO CONCERNS (Phase 3 Step 2f binding interpretation
 * constraint 1):
 *   - `evaluateBitrate` implements ONLY §3 Stage F's REASON rule — a
 *     `StageResult` exactly like every other stage, feeding the ordinary
 *     max-severity aggregation in `src/plan.ts`.
 *   - `buildLadder` implements ONLY §7's ladder CONSTRUCTION rules — a bare
 *     `LadderRung[]`, called from `src/plan.ts`'s final assembly whenever
 *     `video.action === 'transcode'` (see that file's own comment for the
 *     tone-map-refused exception, binding interpretation constraint 3).
 * Neither function calls the other; `src/plan.ts` is the only place that
 * decides whether/when each runs.
 *
 * `videoAlreadyTranscoding` (binding interpretation constraint 1, verbatim):
 * "Stage F's reason rule needs the 'final video verdict is copy' fact:
 * thread a boolean `videoAlreadyTranscoding = (stageB.verdict==='transcode'
 * || stageC.verdict==='transcode' || subtitle strategy==='burn-in')` from
 * `src/plan.ts`; when true, `evaluateBitrate` NEVER fires (the re-encode's
 * ladder caps bitrate anyway)." This stage does not re-derive that fact
 * itself — it stays a pure function of its own inputs (mirrors every other
 * stage's `containerDirectPlayable`/`videoVerdict` threaded-boolean
 * convention, `stages/hdr.ts`/`stages/subtitle.ts`).
 *
 * ---------------------------------------------------------------------------
 * REASON RULE (binding interpretation constraint 2, verbatim): fires
 * `transcode` + `bitrate-exceeds-network` iff
 *   NOT videoAlreadyTranscoding
 *   AND a video stream is SELECTED (no video/music → vacuous pass; bitrate
 *       capping of audio-only is not a §3 Stage F concern)
 *   AND media.overallBitrateBps > network.maxBitrateBps
 *   AND NOT (network.isLocal AND withinDeviceCap)
 * where `withinDeviceCap = device.maxStreamBitrateBps === null OR
 * overallBitrateBps <= device.maxStreamBitrateBps`.
 *
 * Two PINNED consequences (binding interpretation constraint 2, both
 * directions — test/stages/ladder.spec.ts's truth table):
 *   - local network + overall > network.max + WITHIN device cap → NO reason
 *     (the §3 unless-clause holds: direct-play stays possible even though
 *     the network's OWN cap was exceeded — that is the entire point of
 *     `isLocal` "relaxing the bitrate rung cap", §2.3).
 *   - local network + overall > a non-null device cap → reason FIRES (the
 *     §3 unless-clause's SECOND half — "and bitrate ≤ device cap" — fails,
 *     so `isLocal` alone is not sufficient; a LAN client with a hard SoC
 *     decode-rate ceiling still needs Stage F's protection).
 *
 * No `streamIndex` on this reason (binding interpretation constraint 2): it
 * is a whole-file/network property, not a per-stream fact — mirrors Stage
 * A's (`stages/container.ts`) identical convention of a `streamIndex`-less
 * reason. `detail` names both operands (e.g. "overall=40000000
 * network=4000000") per the mission's encouragement. NOTE (surfaced per this
 * step's instructions): the matrix runner (`matrix/matrix.spec.ts`) only
 * ever asserts `reasons.map((r) => r.code)`, never the full reason object —
 * so seed case 006 cannot actually reveal a disagreement over `streamIndex`
 * presence either way; this module's choice to omit it is a construction
 * decision made on this stage's own reading of the spec, not something the
 * seed case's runner constrains one way or the other.
 *
 * ---------------------------------------------------------------------------
 * LADDER CONSTRUCTION (binding interpretation constraint 3 — `buildLadder`).
 * Table order is `policy.ladderRungs` as given (policy-overridable per §7;
 * this function never re-sorts it). Steps, in this EXACT order:
 *   (f) hevc swap FIRST (see "SWAP-BEFORE-CAPS" below) — every rung with
 *       `heightPx < 2160` becomes `{ codec: 'hevc', videoBitrateBps:
 *       round(videoBitrateBps * 0.75) }` (audioBitrateBps unchanged) IFF
 *       `policy.hevcEncodePreferred` AND `device.video` has at least one
 *       entry with `codec === 'hevc'`. The 2160p rung (already hevc in the
 *       documented default table) is NEVER touched by this step regardless
 *       of the flag — the spec's own parenthetical only ever discusses
 *       rungs "below 2160".
 *   (a) drop rungs with `heightPx > ` the selected video stream's `height`
 *       ("never exceed source height").
 *   (b) drop rungs with `videoBitrateBps > ` the source video bitrate, read
 *       as `stream.bitrateBps ?? media.overallBitrateBps` (comparator
 *       interpretation — reported per this step's instructions: §7's text
 *       says "source bitrate" without naming a field, and
 *       `VideoStream.bitrateBps` is nullable per §2.1, so the whole-file
 *       `overallBitrateBps` is the natural fallback — exactly the same
 *       fallback Stage F's OWN reason rule already uses as ITS source-bitrate
 *       fact).
 *   (c) drop rungs with `videoBitrateBps > network.maxBitrateBps` UNLESS
 *       `network.isLocal` (§7: "isLocal networks skip the network cap").
 *   (d) ALWAYS drop rungs with `videoBitrateBps > device.maxStreamBitrateBps`
 *       when that cap is non-null — regardless of `network.isLocal` (§7:
 *       "isLocal networks ... honor device caps").
 *   (e) if steps (a)-(d) dropped EVERY rung, keep exactly ONE rung: the
 *       (post-swap) table's lowest-`videoBitrateBps` rung, even though it
 *       may still violate whichever rule(s) caused the drop ("keep at least
 *       the lowest rung" — §7; "the ladder of a transcode is never empty
 *       except the refused case", this step's binding instructions).
 *
 * (a)-(d) are independent conjunctive filters — a rung survives iff ALL FOUR
 * hold — so the order they're checked in among themselves doesn't change the
 * final surviving set; only (e)'s fallback needs every other rule's verdict
 * first, and (f)'s swap-before-caps ordering (next paragraph) IS
 * spec-significant.
 *
 * SWAP-BEFORE-CAPS (binding interpretation constraint 3's own BIND, quoted):
 * "apply the swap FIRST (the rung the client actually receives is the hevc
 * one, so caps must evaluate the real bitrate)". This module therefore
 * transforms the table (step f) BEFORE running steps (a)-(e) — every
 * subsequent bitrate comparison (source-bitrate (b), network cap (c), device
 * cap (d), and the keep-lowest fallback (e)) reads the POST-swap
 * `videoBitrateBps`. A rung that would have been dropped by (c) or (d) in
 * its original (×1.0) form can therefore SURVIVE purely because the ×0.75
 * reduction brought it under the cap — pinned by test/stages/ladder.spec.ts's
 * ordered-swap proof and by dedicated matrix cases (see their `why:`
 * comments for the exact numbers).
 *
 * ---------------------------------------------------------------------------
 * SCOPE NOTE: `buildLadder` is called from `src/plan.ts` ONLY when
 * `video.action === 'transcode'` AND the plan does NOT carry a fired
 * `tone-map-refused-by-policy` reason (binding interpretation constraint 3 —
 * see that file's own comment, and Phase 3 Step 2c's original pin in
 * `test/stages/hdr.spec.ts`, now extended per this step's instructions to
 * assert the refusal ⇒ `ladder: []` guarantee against a REAL, non-degenerate
 * ladder table — proving the special-case actually suppresses real
 * construction, not merely a vacuously empty one). Audio-only transcodes and
 * copy/none video decisions never call this function at all —
 * `src/plan.ts` supplies `[]` directly for those, matching §5: "ladder (may
 * be empty for copy/audio-only decisions)".
 */
import type { DeviceProfile, LadderRung, MediaInfo, NetworkConditions, ServerPolicy } from "../types.js";
import type { PlanReason } from "../reasons.js";
import type { StageResult } from "./types.js";

/** §3 Stage F's `withinDeviceCap` sub-condition (binding interpretation
 *  constraint 2): a null device cap is unconstrained (always "within"). */
function isWithinDeviceCap(overallBitrateBps: number, maxStreamBitrateBps: number | null): boolean {
  return maxStreamBitrateBps === null || overallBitrateBps <= maxStreamBitrateBps;
}

/**
 * Stage F's reason rule (docs/PLAYBACK.md §3, this module's header). Pure
 * function of its own inputs only — `videoAlreadyTranscoding` is threaded in
 * from `src/plan.ts` rather than re-derived (binding interpretation
 * constraint 1).
 */
export function evaluateBitrate(
  media: MediaInfo,
  device: DeviceProfile,
  network: NetworkConditions,
  videoStreamIndex: number | null,
  videoAlreadyTranscoding: boolean,
): StageResult {
  // "when true, evaluateBitrate NEVER fires" — checked first, before even
  // looking at whether a video stream is selected (binding interpretation
  // constraint 1's own ordering: this is the OUTERMOST gate — the re-encode
  // that Stage B/C/E already forced will cap its own bitrate via the ladder
  // construction Stage F still performs, so re-firing the network reason on
  // top of it would be redundant, not additive).
  if (videoAlreadyTranscoding) {
    return { verdict: "direct-play", reasons: [] };
  }

  // "a video stream is SELECTED" (binding interpretation constraint 2) — no
  // video / music mode is a vacuous pass, mirroring every other stage's
  // identical selection-scoping convention (stages/video.ts, stages/hdr.ts,
  // stages/audio.ts, stages/subtitle.ts).
  if (videoStreamIndex === null || media.video.length === 0) {
    return { verdict: "direct-play", reasons: [] };
  }
  const stream = media.video.find((v) => v.index === videoStreamIndex);
  if (!stream) {
    // Defensive: a selection index that doesn't resolve to any stream is
    // structurally invalid input (matrix-meta.spec.ts's structural-sanity
    // check forbids it, and the property-test generators never produce it),
    // but plan() must stay TOTAL (docs/PLAYBACK.md §10 property 3) — same
    // vacuous-pass convention as every other stage's identical branch.
    return { verdict: "direct-play", reasons: [] };
  }

  const exceedsNetwork = media.overallBitrateBps > network.maxBitrateBps;
  const withinDeviceCap = isWithinDeviceCap(media.overallBitrateBps, device.maxStreamBitrateBps);
  const localException = network.isLocal && withinDeviceCap;

  if (exceedsNetwork && !localException) {
    const reason: PlanReason = {
      code: "bitrate-exceeds-network",
      detail: `overall=${media.overallBitrateBps} network=${network.maxBitrateBps}`,
    };
    return { verdict: "transcode", reasons: [reason] };
  }

  return { verdict: "direct-play", reasons: [] };
}

/** hevc-swap eligibility (binding interpretation constraint 3, step f):
 *  requires BOTH the policy flag and at least one hevc entry in
 *  `device.video` — §7's own text ties the swap to "device hevc", read as
 *  device.video declaring an hevc entry at all. This stage does not re-check
 *  any OTHER axis of that entry — Stage B already vetted the SOURCE stream's
 *  own codec compatibility; this is a hardware-capability fact about the
 *  ladder's ENCODE target, an entirely different codec than whatever the
 *  source happens to be. */
function deviceSupportsHevc(device: DeviceProfile): boolean {
  return device.video.some((entry) => entry.codec === "hevc");
}

/**
 * §7 ladder construction (docs/PLAYBACK.md §7, this module's header). Pure
 * function of its own inputs; `src/plan.ts` decides WHETHER to call this at
 * all (video.action==='transcode' AND NOT refused).
 */
export function buildLadder(
  media: MediaInfo,
  device: DeviceProfile,
  network: NetworkConditions,
  policy: ServerPolicy,
  videoStreamIndex: number | null,
): LadderRung[] {
  const stream = videoStreamIndex !== null ? media.video.find((v) => v.index === videoStreamIndex) : undefined;
  // Binding interpretation constraint 3(b): "stream.bitrateBps ??
  // media.overallBitrateBps" — falls back identically whether the stream's
  // OWN bitrateBps is null (§2.1: nullable field) or the stream itself
  // couldn't be resolved at all (defensive; plan() must stay TOTAL).
  const sourceBitrateBps = stream?.bitrateBps ?? media.overallBitrateBps;
  // Height has no such fallback field on MediaInfo — a genuinely unresolved
  // stream (defensive-only; never produced by any matrix case or property
  // generator, mirrors every other stage's identical defensive branch)
  // leaves rule (a) permissive (no height cap applied) rather than
  // inventing a source height that doesn't exist.
  const sourceHeightPx = stream ? stream.height : null;

  const applyHevcSwap = policy.hevcEncodePreferred && deviceSupportsHevc(device);

  // Step (f) — hevc swap, applied FIRST (see header's "SWAP-BEFORE-CAPS").
  const table: LadderRung[] = policy.ladderRungs.map((rung) => {
    if (applyHevcSwap && rung.heightPx < 2160) {
      return {
        heightPx: rung.heightPx,
        videoBitrateBps: Math.round(rung.videoBitrateBps * 0.75),
        audioBitrateBps: rung.audioBitrateBps,
        codec: "hevc",
      };
    }
    return rung;
  });

  if (table.length === 0) return [];

  // Steps (a)-(d) — independent conjunctive drop filters (binding
  // interpretation constraint 3).
  const survivors = table.filter((rung) => {
    if (sourceHeightPx !== null && rung.heightPx > sourceHeightPx) return false; // (a)
    if (rung.videoBitrateBps > sourceBitrateBps) return false; // (b)
    if (!network.isLocal && rung.videoBitrateBps > network.maxBitrateBps) return false; // (c)
    if (device.maxStreamBitrateBps !== null && rung.videoBitrateBps > device.maxStreamBitrateBps) return false; // (d)
    return true;
  });

  if (survivors.length > 0) return survivors;

  // Step (e) — keep at least the lowest rung (from the post-swap table) when
  // every rung was dropped by (a)-(d).
  const lowest = table.reduce((min, rung) => (rung.videoBitrateBps < min.videoBitrateBps ? rung : min));
  return [lowest];
}
