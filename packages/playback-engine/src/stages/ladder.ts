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
 *   (f) CODEC SELECTION FIRST (see "SWAP-BEFORE-CAPS" below) — ONE step
 *       with fixed precedence av1 > hevc > h264 (docs/PLAYBACK.md §7.1,
 *       LD-7, Wave C1; before C1 this step was "the hevc swap" alone).
 *       A rung with `heightPx < 2160` becomes
 *       `{ codec: 'av1', videoBitrateBps: round(videoBitrateBps * 0.6) }`
 *       (audioBitrateBps unchanged) IFF `src/av1.ts`'s `av1SwapApplies`
 *       holds — i.e. `policy.av1EncodePreferred` (the operator opt-in, §2.4)
 *       AND the device declares an `av1` entry AND `device.hls.supportsFmp4`
 *       (AV1 cannot ride `ts-hls`, §6 interp. M) AND
 *       `av1EncodeEligibility(caps, policy.tier) !== 'none'` (§7.2's LD-16
 *       gate — the ONLY place capability/tier is consulted). Rungs the AV1
 *       rule does NOT claim fall through to the hevc rule VERBATIM
 *       (`policy.hevcEncodePreferred` AND `device.video` has an entry with
 *       `codec === 'hevc'` -> hevc at ×0.75). The 2160p rung is NEVER
 *       touched by either rule regardless of the flags — the spec's own
 *       parenthetical only ever discusses rungs "below 2160"; a 2160p AV1
 *       rung is expressible as an explicit policy rung instead.
 *       *Tier-0 lens:* on Tier-0 the AV1 swap can only ever fire via `'hw'`
 *       eligibility, so on an N100-class box (QSV AV1 decode, no AV1 encode
 *       engine) the produced ladder is byte-identical to pre-C1.
 *   (g) AV1 DEMOTION NORMALIZATION (docs/PLAYBACK.md §7.1, new with Wave
 *       C1) — runs after (f), still BEFORE the cap filters. Any rung whose
 *       codec is `'av1'` at this point (which can ONLY mean an explicit
 *       `policy.ladderRungs` row, since (f) already checked the same gates)
 *       is DEMOTED when `src/av1.ts`'s `av1RungBlocker` returns a cause —
 *       conditions 2/3 above, NEVER condition 1: an explicit av1 rung IS
 *       the operator's preference for that rung, and the global flag governs
 *       only the automatic swap. `codec` becomes `'hevc'` if `device.video`
 *       declares an hevc entry, else `'h264'`; `heightPx` and BOTH bitrates
 *       are kept VERBATIM (the admin chose those numbers). Each demotion
 *       fires informational reason `av1-rung-demoted` (§4). Demote-don't-drop
 *       is deliberate — see `src/av1.ts`'s own header.
 *       *Tier-0 lens:* an admin who force-writes av1 rungs into a T0 box's
 *       table gets the same ladder shape encoded by the machine's REAL
 *       encoders — a serveable plan, never a melted box.
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
 *   (h) TIER-0 ADVERTISED-VARIANT CAP (docs/PLAYBACK.md §7.5, Wave C2 /
 *       LD-6 under LD-16) — NOT part of `buildLadder` at all. It is a
 *       separate exported function (`capAdvertisedVariants`, bottom of this
 *       file) that `src/plan.ts` calls at FINAL assembly, on the FINAL
 *       ladder: after (f)/(g), after (a)-(e), and after Stage G may have
 *       REPLACED the ladder with a tier-capped version. That placement is
 *       the whole point — the facts it needs (what Stage G actually routed)
 *       are not settled inside this function, exactly like the open-GOP
 *       flag's own final-assembly home. See `capAdvertisedVariants`'s own
 *       doc comment for the keep rule and the §7.5 arithmetic behind the
 *       constant.
 *
 * (a)-(d) are independent conjunctive filters — a rung survives iff ALL FOUR
 * hold — so the order they're checked in among themselves doesn't change the
 * final surviving set; only (e)'s fallback needs every other rule's verdict
 * first, and (f)'s swap-before-caps ordering (next paragraph) IS
 * spec-significant.
 *
 * SWAP-BEFORE-CAPS (binding interpretation constraint 3's own BIND, quoted):
 * "apply the swap FIRST (the rung the client actually receives is the hevc
 * one, so caps must evaluate the real bitrate)". Wave C1 extends the same
 * sentence to demotion: the rung the client actually receives is the
 * DEMOTED one, so every cap must evaluate that. This module therefore
 * transforms the table (steps f then g) BEFORE running steps (a)-(e) — every
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
import type {
  DeviceProfile,
  LadderRung,
  MediaInfo,
  NetworkConditions,
  ServerPolicy,
  VerifiedCapabilities,
} from "../types.js";
import type { PlanReason } from "../reasons.js";
import type { StageResult } from "./types.js";
import { AV1_BITRATE_FACTOR, av1DemotionReason, av1RungBlocker, av1SwapApplies, demoteAv1Rungs } from "../av1.js";

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
 * `buildLadder`'s return shape as of Wave C1 (LD-7). Step (g) is the first
 * ladder-construction rule that FIRES A REASON, so a bare `LadderRung[]`
 * no longer expresses everything the caller needs; `src/plan.ts` appends
 * `reasons` to the plan's own list at Stage-F position (before Stage G's
 * routing reasons — docs/PLAYBACK.md §4's "ordered by stage").
 */
export interface LadderBuildResult {
  ladder: LadderRung[];
  /** `av1-rung-demoted`, one per §7.1(g) demotion, in table order. */
  reasons: PlanReason[];
}

/**
 * §7 ladder construction (docs/PLAYBACK.md §7, this module's header). Pure
 * function of its own inputs; `src/plan.ts` decides WHETHER to call this at
 * all (video.action==='transcode' AND NOT refused).
 *
 * `caps` arrived with Wave C1: §7.1's codec selection is capability-gated
 * through `src/av1.ts`'s shared predicate, which reads `caps` + `policy.tier`
 * (§2.4's deliberate asymmetry — the AV1 tier law is enforced HERE, inside
 * the pure engine, never resolved by the caller).
 */
export function buildLadder(
  media: MediaInfo,
  device: DeviceProfile,
  network: NetworkConditions,
  policy: ServerPolicy,
  caps: VerifiedCapabilities,
  videoStreamIndex: number | null,
): LadderBuildResult {
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

  const applyAv1Swap = av1SwapApplies(policy, device, caps);
  const applyHevcSwap = policy.hevcEncodePreferred && deviceSupportsHevc(device);

  // Step (f) — ONE codec-selection step, precedence av1 > hevc > h264,
  // applied FIRST (see header's "SWAP-BEFORE-CAPS", which now covers
  // demotion too). A rung the AV1 rule claims never reaches the hevc rule;
  // rungs it does NOT claim fall through to the hevc rule VERBATIM.
  const swapped: LadderRung[] = policy.ladderRungs.map((rung) => {
    if (rung.heightPx < 2160) {
      if (applyAv1Swap) {
        return {
          heightPx: rung.heightPx,
          videoBitrateBps: Math.round(rung.videoBitrateBps * AV1_BITRATE_FACTOR),
          audioBitrateBps: rung.audioBitrateBps,
          codec: "av1",
        };
      }
      if (applyHevcSwap) {
        return {
          heightPx: rung.heightPx,
          videoBitrateBps: Math.round(rung.videoBitrateBps * 0.75),
          audioBitrateBps: rung.audioBitrateBps,
          codec: "hevc",
        };
      }
    }
    return rung;
  });

  // Step (g) — AV1 demotion normalization (docs/PLAYBACK.md §7.1). Runs
  // after (f), BEFORE the cap filters, so a demoted rung's VERBATIM bitrate
  // is the number every cap evaluates. Any rung still carrying `av1` here
  // can only be an explicit `policy.ladderRungs` row: the swap above
  // checked `av1RungBlocker` itself (via `av1SwapApplies`), so a
  // swap-produced rung is admissible by construction and this step is a
  // structural no-op for it.
  const blocker = av1RungBlocker(device, caps, policy.tier);
  const normalized = blocker === null ? { rungs: swapped, demotions: [] } : demoteAv1Rungs(swapped, device, blocker);
  const table = normalized.rungs;
  const reasons: PlanReason[] = normalized.demotions.map(av1DemotionReason);

  if (table.length === 0) return { ladder: [], reasons };

  // Steps (a)-(d) — independent conjunctive drop filters (binding
  // interpretation constraint 3).
  const survivors = table.filter((rung) => {
    if (sourceHeightPx !== null && rung.heightPx > sourceHeightPx) return false; // (a)
    if (rung.videoBitrateBps > sourceBitrateBps) return false; // (b)
    if (!network.isLocal && rung.videoBitrateBps > network.maxBitrateBps) return false; // (c)
    if (device.maxStreamBitrateBps !== null && rung.videoBitrateBps > device.maxStreamBitrateBps) return false; // (d)
    return true;
  });

  if (survivors.length > 0) return { ladder: survivors, reasons };

  // Step (e) — keep at least the lowest rung (from the post-swap,
  // post-normalization table) when every rung was dropped by (a)-(d).
  const lowest = table.reduce((min, rung) => (rung.videoBitrateBps < min.videoBitrateBps ? rung : min));
  return { ladder: [lowest], reasons };
}

// ---------------------------------------------------------------------------
// Step (h) — Tier-0 advertised-variant cap (docs/PLAYBACK.md §7.5, LD-6
// under LD-16, Wave C2). See this module's header block below for the full
// rule text; the short version is that the master playlist advertises
// `plan.ladder` and nothing else, so WHICH rungs a client may switch to is
// a PLAN decision the matrix can prove, never a session-layer filter that
// could drift from the plan the audit row stores.
// ---------------------------------------------------------------------------

/**
 * The Tier-0 advertised-variant count (owner-decision V1, docs/PLAYBACK.md
 * §7.5). A TIER LAW, deliberately NOT a `ServerPolicy` knob: a settings
 * checkbox that re-widened the advertised set on Tier-0 would be exactly
 * the "escape hatch is a checkbox" failure §7.2 refuses for AV1. The escape
 * hatch is the tier, same as it is there — Tier 1+ ladders are never
 * trimmed by this step at all (owner-decision V6).
 *
 * Why 3 (the arithmetic the owner signed, §7.5): encoding cost is
 * count-INVARIANT under §9.1's slot-handoff delivery model (exactly one
 * rung encodes at any instant, whatever the advertised count), so the cap
 * is not about concurrent load — the admission semaphore already bounds
 * that. The count's real Tier-0 cost is SWITCH CHURN: every ABR switch is a
 * full pipeline handoff (kill + observed exit + spawn + input open + seek +
 * encoder init + first GOP, 1-4 s on the reference box). Churn frequency is
 * governed by rung SPACING, and the top/geometric-mid/floor keep rule
 * guarantees ~2x+ adjacent ratios for every realistic table, so the
 * client's throughput estimate must halve or double to cross a boundary.
 * The default 6-rung table has adjacent ratios as low as 1.33x — inside
 * ordinary Wi-Fi variance, i.e. boundary-hovering, i.e. a handoff per
 * hover. 2 would leave a 5-10x cliff with no intermediate recovery step;
 * 4+ re-introduces a sub-2x boundary and buys no capability 3 lacks.
 */
export const TIER0_MAX_ADVERTISED_VARIANTS = 3;

/**
 * `capAdvertisedVariants`'s return shape — the same `{ ladder, reasons }`
 * pair `buildLadder` uses, for the same reason: step (h) can fire a reason
 * (`ladder-variant-capped`, §4/owner-decision V2) and the caller
 * (`src/plan.ts`'s final assembly) appends it to the plan's own list.
 */
export interface VariantCapResult {
  ladder: LadderRung[];
  /** Empty, or exactly ONE `ladder-variant-capped` (single-firing). */
  reasons: PlanReason[];
}

/** Bitrates come from a policy table an admin can configure; a 0 (or
 *  negative) value is degenerate but structurally legal, and `Math.log(0)`
 *  is `-Infinity`, which would poison every comparison below. Clamping to 1
 *  keeps the geometric-mid arithmetic finite without inventing a rung or
 *  reordering anything — `plan()` must stay TOTAL (§10 property 3). */
function logBitrate(rung: LadderRung): number {
  return Math.log(Math.max(1, rung.videoBitrateBps));
}

/**
 * Step (h) — the §7.5 Tier-0 advertised-variant cap, run at FINAL assembly
 * on the FINAL ladder: after §7.1's steps (f)/(g), after the cap filters
 * (a)-(e), and after any Stage-G replacement (`software-fallback:
 * tier-capped` dropping, the av1 residual demotion). It lives at final
 * assembly for the same reason the open-GOP flag does — the facts it needs
 * are not settled earlier.
 *
 * When `tier === 0` AND the ladder has more than
 * `TIER0_MAX_ADVERTISED_VARIANTS` rungs, it is trimmed to exactly that many
 * by a deterministic keep rule:
 *   1. the TOP rung — the `topRungOf` maximum, so `video.targetCodec` and
 *      the initially-encoded rung are untouched by the cap;
 *   2. the LOWEST rung — the same floor the network-cap filter already
 *      refuses to drop, the rescue rung a collapsing connection falls to;
 *   3. the rung minimizing `|ln(v) − (ln(top) + ln(lowest))/2|` — the
 *      geometric middle; a tie goes to the LOWER-bitrate candidate.
 *
 * Array ORDER IS PRESERVED (the ladder is emitted in policy-table order;
 * this trims elements, it never reorders). A ladder already at or below the
 * cap — every T0 full-software route today, since §8.3's tier cap already
 * leaves <= 2 rungs, and every <=-3-rung policy table — comes back
 * IDENTICAL with no reason fired, which is what makes those plans
 * byte-identical to their pre-C2 selves.
 *
 * Pure and non-mutating: the input array and its rungs are never touched.
 * `topRungOf`'s own first-maximum tie rule is mirrored exactly here (strict
 * `>` / strict `<`), so "the cap keeps the top rung" is true of the SAME
 * rung `src/plan.ts` reads `targetCodec` from, not merely of an equal one.
 */
export function capAdvertisedVariants(ladder: readonly LadderRung[], tier: ServerPolicy["tier"]): VariantCapResult {
  if (tier !== 0 || ladder.length <= TIER0_MAX_ADVERTISED_VARIANTS) {
    return { ladder: [...ladder], reasons: [] };
  }

  // (1)/(2) — top and floor. Strict comparisons keep the FIRST extreme, the
  // same tie rule `src/plan.ts`'s `topRung` reduce and step (e)'s
  // keep-lowest reduce already use.
  let topIdx = 0;
  let lowIdx = 0;
  for (let i = 1; i < ladder.length; i += 1) {
    if (ladder[i]!.videoBitrateBps > ladder[topIdx]!.videoBitrateBps) topIdx = i;
    if (ladder[i]!.videoBitrateBps < ladder[lowIdx]!.videoBitrateBps) lowIdx = i;
  }

  // (3) — the geometric middle, in log space so "midway between 8M and
  // 0.8M" means the 2.5M a bitrate ladder actually wants, not the 4.4M an
  // arithmetic mean would name. Candidates exclude the two rungs already
  // kept; ties break to the LOWER bitrate, then (bitrates being equal too)
  // to the earlier table position, so the result is total-ordered and
  // deterministic for every input.
  const target = (logBitrate(ladder[topIdx]!) + logBitrate(ladder[lowIdx]!)) / 2;
  let midIdx = -1;
  for (let i = 0; i < ladder.length; i += 1) {
    if (i === topIdx || i === lowIdx) continue;
    if (midIdx === -1) {
      midIdx = i;
      continue;
    }
    const d = Math.abs(logBitrate(ladder[i]!) - target);
    const best = Math.abs(logBitrate(ladder[midIdx]!) - target);
    if (d < best || (d === best && ladder[i]!.videoBitrateBps < ladder[midIdx]!.videoBitrateBps)) {
      midIdx = i;
    }
  }

  const keep = new Set([topIdx, lowIdx, midIdx]);
  const kept: LadderRung[] = [];
  const dropped: LadderRung[] = [];
  for (let i = 0; i < ladder.length; i += 1) {
    (keep.has(i) ? kept : dropped).push(ladder[i]!);
  }

  // Single-firing (owner-decision V2): one trim, one reason, `detail`
  // naming every dropped rung in table order so "where did my rungs go?"
  // is answerable from the stored plan alone.
  const reason: PlanReason = {
    code: "ladder-variant-capped",
    detail: `cap=${TIER0_MAX_ADVERTISED_VARIANTS} dropped=${dropped
      .map((r) => `${r.heightPx}p@${r.videoBitrateBps}`)
      .join(",")}`,
  };
  return { ladder: kept, reasons: [reason] };
}
