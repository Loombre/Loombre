// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage G — Hardware routing (docs/PLAYBACK.md §3, quoted verbatim):
 *
 *   "Stage G — Hardware routing (only when transcoding video). See §8.3 for
 *   selection. Emits `hw-encoder-selected:<backend>` informational reason or
 *   `software-fallback:<cause>`."
 *
 * And docs/PLAYBACK.md §8.2/§8.3 (quoted verbatim):
 *
 *   "macOS: videotoolbox -> software. Windows: nvenc -> qsv -> amf ->
 *   d3d11va(decode-only) -> software. Linux: nvenc -> qsv -> vaapi ->
 *   software."
 *
 *   "Choose the first backend (platform order) whose VERIFIED caps cover
 *   BOTH the required decode codec and target encode codec; else first
 *   covering encode with software decode (`software-fallback:decode`); else
 *   full software (`software-fallback:encode`) - gated on tier: T0
 *   full-software transcode of >=1080p sources -> allowed only for the
 *   <=480p rungs, higher rungs dropped with reason
 *   `software-fallback:tier-capped`. Tone-map method preference per backend:
 *   videotoolbox->`videotoolbox`; nvenc->`cuda`; qsv/vaapi->`opencl`(else
 *   `vulkan`); software->CPU zscale only if `allowToneMapCpu` resolves
 *   true. Decode/encode stay on one device (no hw->sw->hw bounces) except
 *   when the filtergraph requires download (subtitle burn-in on vaapi:
 *   hwdownload -> overlay -> hwupload, exactly once)."
 *
 * Phase 3 §11 step 3 (STATE.md P3.3): this module runs against FAKED
 * `VerifiedCapabilities` fixture sets (`matrix/fixtures/caps.yaml`'s
 * full-hw/encode-only/macos-vt/software-only) until the real self-test probe
 * lands in step 5 — nothing here depends on how those fixtures were
 * produced, only on their §2.5 shape.
 *
 * `src/plan.ts` calls `routeHardware` (this module's only export) whenever
 * `video.action === 'transcode'` and the transcode is not policy-disabled
 * (step 7b fix F1) — and, since step 7b fix F2, this module's resolution IS
 * the single tone-map REFUSAL authority: when `toneMapRequired` holds and
 * the full §8.3 resolution below (rules i/ii with per-candidate method
 * fall-through, then the software route's `allowToneMapCpu` check) ends
 * with NO usable method, this module returns `toneMap` unset — `src/
 * plan.ts`'s assembly reads exactly that fact (`toneMapRequired &&
 * routing.toneMap === undefined`) as REFUSED, discards this module's
 * routing reasons/encoder/ladder wholesale, and emits the §3
 * `tone-map-refused-by-policy` transcode-with-empty-ladder shape instead
 * (Step 2c's caps-global refusal check inside `stages/hdr.ts` is DELETED —
 * matrix cases 447/448 pin the routes it got wrong). The "decode/encode
 * stay on one device (no hw->sw->hw bounces)" sentence's only EXCEPTION
 * named in §8.3 (vaapi subtitle-burn-in hwdownload/overlay/hwupload) is an
 * arg-builder filtergraph concern (docs/PLAYBACK.md §6, §11 step 4 +
 * step 7b fix F4 — see `args/builder.ts`'s header) — nothing this module
 * (which only ever picks a backend + tone-map method + tier cap) has any
 * occasion to model.
 *
 * ---------------------------------------------------------------------------
 * BINDING INTERPRETATION 1 — the engine is PLATFORM-BLIND (docs/PLAYBACK.md
 * design law 4: "Verified capabilities only... Driver marketing is not
 * capability"). This module never asks "what OS am I on" (it couldn't -
 * `plan()` reads no environment, docs/PLAYBACK.md §0 law 1) - "platform
 * order" from §8.2 is modeled entirely as `caps.backends`' OWN ARRAY ORDER:
 * the real self-test probe (step 5) is expected to emit candidates in
 * exactly that platform order, and the FAKED fixture sets already model
 * this (e.g. `full-hw` lists `nvenc` before `software`, `macos-vt` lists
 * `videotoolbox` before `software`). This module therefore NEVER re-sorts
 * `caps.backends` - `Array.prototype.filter`/`for...of` preserve the input
 * order verbatim, so "first backend (platform order) whose..." reduces to
 * "first element of `caps.backends` (excluding `software` for rules i/ii)
 * satisfying...".
 *
 * BINDING INTERPRETATION 2 — selection inputs (docs/PLAYBACK.md §8.3):
 *   - required DECODE codec = the SELECTED video stream's OWN `codec`
 *     (`media.video.find(v => v.index === videoStreamIndex)`).
 *   - target ENCODE codec(s) = the DISTINCT `codec` values of the SURVIVING
 *     ladder rungs, i.e. `ladder` as already constructed by Stage F's
 *     `buildLadder` (src/stages/ladder.ts) BEFORE this module's own tier-cap
 *     step runs (binding interpretation constraint 4/5's ordering - the
 *     backend is chosen against the PRE-tier-cap target set, then the tier
 *     cap is applied to the chosen route's ladder afterward). A backend must
 *     cover EVERY distinct target codec, not merely one of them (multi-codec
 *     ladders - e.g. a 2160p-source case surviving as `{hevc(2160),
 *     h264(1080)}` without the hevc-preferred whole-ladder swap - are the
 *     "backend must cover ALL of them" case this constraint calls out;
 *     reported as an interpretation per this step's instructions since §8.3
 *     only ever speaks of "target encode codec" in the singular). When the
 *     ladder is empty (only reachable via a deliberately empty
 *     `policy.ladderRungs` table - never produced by any real fixture or the
 *     property generators, which always supply the real 6-rung table).
 *     `targets.every(...)` is vacuously true for every candidate; this
 *     module additionally requires a candidate's OWN `encode` array be
 *     non-empty before it can be chosen as an "encoder" (see
 *     `HW_ENCODE_GUARD` below) specifically so a real decode-only backend
 *     (§8.2's `d3d11va(decode-only)`) can never be vacuously "selected" as an
 *     encoder purely because there happened to be zero targets to cover -
 *     reported as an interpretation (a defensive completeness guard, not
 *     fixture-exercised behavior).
 *
 *   Rule (i) considers HARDWARE backends ONLY (`backend !== 'software'`):
 *   first hw backend whose `decode` includes the source codec AND `encode`
 *   includes every target codec -> `hw-encoder-selected:<backend>`.
 *
 *   Rule (ii): else first hw backend whose `encode` covers all targets
 *   (decode falls to software - the SOFTWARE backend's OWN `decode` list
 *   must include the source codec, or this route isn't actually viable
 *   either) -> `software-fallback:decode`. The `encode-only` P3.3 fixture
 *   models exactly this: `nvenc` declares `decode: []` (self-test decode
 *   failed/unsupported) but a real `encode` list, paired with a `software`
 *   entry whose `decode` covers everything.
 *
 *   Rule (iii): else full software -> `software-fallback:encode`. This is
 *   the unconditional last resort (docs/PLAYBACK.md §8.1: the bundled ffmpeg
 *   software encoder/decoder is always assumed available - the ONLY
 *   fixture-verified fact rules (i)/(ii) need is a HARDWARE backend's own
 *   caps; software itself is never capability-gated here, mirroring every
 *   `caps.*.yaml` fixture's software entry, which always declares a broad
 *   decode/encode list). `encoder` is set to the literal `'software'`
 *   backend name regardless of whether `caps.backends` even lists a
 *   `software` entry (defensive - no fixture omits it, but the plan must
 *   stay TOTAL either way, docs/PLAYBACK.md §10 property 3).
 *
 * SPEC-LITERAL-READING NOTE (candidate docs/PLAYBACK.md clarification,
 * reported per this step's instructions, NOT silently resolved): a literal
 * reading of "choose the first backend... whose verified caps cover both..."
 * without the "HARDWARE backends only" restriction on rule (i) would let the
 * `software` entry itself satisfy "covers both" (every caps.yaml fixture's
 * software entry declares broad decode+encode lists) and emit the absurd
 * `hw-encoder-selected:software`. The hw-only restriction on rule (i) (and
 * symmetrically on rule (ii)'s "first backend... covering encode", which
 * would otherwise ALSO match `software` trivially and short-circuit before
 * ever reaching the real full-software fallback) is the binding fix adopted
 * here - `hwBackends` below filters `caps.backends` to `backend !==
 * 'software'` before either loop runs, so a bare `software` entry can only
 * ever be reached via rule (iii).
 *
 * ---------------------------------------------------------------------------
 * BINDING INTERPRETATION 3 - tone-map interaction (docs/PLAYBACK.md §8.3's
 * tone-map preference sentence + this step's own constraint 3): when Stage C
 * (src/stages/hdr.ts) required tone-mapping (an `hdr-tone-map-required` or
 * `dv-profile5-requires-tonemap` reason already fired - `src/plan.ts` passes
 * this fact in as `toneMapRequired`, computed once from the reasons Stage
 * A-F already produced) AND the plan is not refused (guaranteed by the
 * caller - see this module's top note), the CHOSEN backend must ALSO
 * provide a usable tone-map method, honoring THAT backend's OWN verified
 * `toneMap` list (never a different candidate's):
 *   videotoolbox -> 'videotoolbox' iff present in its own `toneMap` array.
 *   nvenc        -> 'cuda' iff present.
 *   qsv / vaapi  -> 'opencl' iff present, ELSE 'vulkan' iff present.
 *   amf / d3d11va -> NO METHOD (§8.3's preference table only ever names
 *     videotoolbox/nvenc/qsv/vaapi/software - amf and d3d11va are absent
 *     from it entirely, so this module treats them as never able to satisfy
 *     a tone-map requirement, regardless of what their own `toneMap` array
 *     might (hypothetically) declare; no current fixture gives either
 *     backend a non-empty `toneMap` array, so this branch is defensive
 *     completeness, not fixture-exercised behavior - reported as an
 *     interpretation).
 *   software     -> 'cpu-zscale' iff `policy.allowToneMapCpu` resolves true
 *     ('always', or 'tier-gated' with `tier >= 1`) - see rule (iii) below;
 *     this is the ONE case where the method depends on `policy`, not just
 *     `caps`.
 *
 * A rule (i)/(ii) CANDIDATE that satisfies decode+encode but has no usable
 * method under this table (per `toneMapRequired`) does NOT disqualify the
 * whole rule - it "falls through" to the NEXT candidate within the same
 * rule, then to the next rule, exactly like a decode/encode mismatch would
 * (constraint 3, verbatim: "rule (i)/(ii) candidates lacking a usable method
 * fall through"). `video.toneMap` is set only when a method is actually
 * chosen; it stays unset when no tone-map is needed at all.
 *
 * RESOLVED (step 7b fix F2; formerly the "SURFACED, NOT RESOLVED" gap this
 * header carried since Step 3): `stages/hdr.ts`'s old caps-global refusal
 * heuristic could conclude "not refused" (SOME backend somewhere had a
 * non-empty toneMap array) while this module's per-route resolution found
 * no usable method at all — leaving `video.toneMap` unset on an UNREFUSED
 * plan that still carried `hdr-tone-map-required` (un-tone-mapped HDR to
 * an SDR device). NOTE the gap was NOT "only reachable via the `unknown`
 * VideoCodec" as this header previously claimed — the step-7a audit
 * (matrix case 448) disproved that with an ordinary hevc source: any
 * disagreement between a backend's verified `toneMap` list and its OWN
 * §8.3 preference row (e.g. nvenc verifying only opencl), or a
 * toneMap-bearing backend that fails encode coverage for the target set
 * (case 447), reached it too. The fix: `src/plan.ts` now derives refusal
 * FROM this module's result (see the top note above), so "tone-map
 * required but no method resolved" is refused BY CONSTRUCTION — a
 * non-refused transcode plan carrying a tone-map-required reason always
 * has `video.toneMap` set.
 *
 * ---------------------------------------------------------------------------
 * BINDING INTERPRETATION 4 - tier cap (docs/PLAYBACK.md §8.3, this step's
 * own constraint 5): ONLY on the rule-(iii) full-software route, ONLY when
 * `policy.tier === 0`, ONLY when the SELECTED source video stream's `height`
 * is `>= 1080`: filter the chosen route's ladder to rungs with `heightPx <=
 * 480`; if that filter would empty the ladder, keep the lowest-bitrate rung
 * of the PRE-filter ladder instead (mirrors `stages/ladder.ts`'s OWN
 * keep-lowest fallback - "the ladder of a transcode is never empty"). The
 * informational `software-fallback:tier-capped` reason fires AFTER the
 * primary `software-fallback:encode` reason IFF the final (post-cap, post-
 * rescue) ladder actually DIFFERS from the pre-cap ladder - comparing the
 * RESCUED result against the original, not merely "did the intermediate
 * filter step produce an empty array", because a pre-cap ladder that had
 * already been narrowed (by Stage F's own device/network/height caps, or by
 * a restrictive `policy.ladderRungs`) down to exactly ONE rung above 480p
 * rescues back to that SAME single rung - nothing was actually removed, so
 * the informational reason must NOT fire (this module's `sameLadder` check
 * below implements exactly that comparison; it is the difference between
 * "the filter momentarily produced []" and "the client actually lost
 * rungs"). T1/T2 policies, hardware routes (rules i/ii), and sub-1080p
 * sources never reach this filter at all - `applyTierCap` returns the
 * INPUT ladder unchanged (and `tierCapped: false`) the moment any of those
 * hold, per docs/PLAYBACK.md §8.3's literal gating clause.
 *
 * ---------------------------------------------------------------------------
 * ASSEMBLY (docs/PLAYBACK.md §5, this step's constraint 4 - the actual
 * `video.targetCodec`/`video.encoder`/`video.toneMap` field writes happen in
 * `src/plan.ts`, mirroring Stage D's rule-4 assembly living in `plan.ts`
 * rather than in `stages/audio.ts`): this module returns the CHOSEN
 * `encoder`, an optional `toneMap`, the fired `reasons`, and the FINAL
 * (post-tier-cap) `ladder` - `src/plan.ts` derives `video.targetCodec` as
 * the TOP surviving rung (highest `videoBitrateBps`) of THAT final ladder
 * (reported as an interpretation per this step's instructions: docs/
 * PLAYBACK.md §5's `targetCodec` field is singular while a surviving ladder
 * can carry more than one distinct codec in the multi-codec-target scenario
 * constraint 2 above describes - the TOP rung's own codec is the natural
 * "primary" target, since it is the rung initially selected/started per §7's
 * lazy-rung-start model).
 */
import type {
  HardwareBackend,
  LadderRung,
  MediaInfo,
  ServerPolicy,
  ToneMapMethod,
  VerifiedBackendCapability,
  VerifiedCapabilities,
} from "../types.js";
import type { PlanReason, PlanReasonCode } from "../reasons.js";

function reason(code: PlanReasonCode, streamIndex: number | undefined, detail: string): PlanReason {
  const r: PlanReason = { code, detail };
  if (streamIndex !== undefined) r.streamIndex = streamIndex;
  return r;
}

/** §8.3's tone-map preference table, hardware half only (software's
 *  'cpu-zscale' branch is policy-gated, handled separately in rule iii).
 *  Backends absent from this table (amf, d3d11va) can never satisfy a
 *  tone-map requirement (binding interpretation 3). */
type HwToneMapMethod = "videotoolbox" | "cuda" | "opencl" | "vulkan";
const HW_TONE_MAP_PREFERENCE: Partial<Record<HardwareBackend, readonly HwToneMapMethod[]>> = {
  videotoolbox: ["videotoolbox"],
  nvenc: ["cuda"],
  qsv: ["opencl", "vulkan"],
  vaapi: ["opencl", "vulkan"],
};

/** First method from this backend's OWN preference list that its OWN
 *  verified `toneMap` array actually contains - `undefined` when the
 *  backend has no table entry at all, or none of its preferred methods are
 *  verified present. */
function pickToneMapMethod(backend: VerifiedBackendCapability): ToneMapMethod | undefined {
  const preference = HW_TONE_MAP_PREFERENCE[backend.backend];
  if (!preference) return undefined;
  for (const method of preference) {
    if (backend.toneMap.includes(method)) return method;
  }
  return undefined;
}

/** The DISTINCT `codec` values of the surviving ladder rungs (binding
 *  interpretation 2) - order-independent (a Set), since only "does the
 *  candidate cover every one of these" is ever asked of it. */
function distinctTargetCodecs(ladder: readonly LadderRung[]): ReadonlyArray<"h264" | "hevc"> {
  return Array.from(new Set(ladder.map((rung) => rung.codec)));
}

/** Rule (i)/(ii) shared guard (binding interpretation 2's defensive note):
 *  a candidate must actually declare `encode` capability at all before it
 *  can be "chosen" as an encoder - protects against a real decode-only
 *  backend (§8.2 `d3d11va`) being vacuously selected when `targets` happens
 *  to be empty (`[].every(...)` is trivially true). */
function encodeCoversTargets(backend: VerifiedBackendCapability, targets: readonly ("h264" | "hevc")[]): boolean {
  return backend.encode.length > 0 && targets.every((codec) => backend.encode.includes(codec));
}

function ladderSignature(ladder: readonly LadderRung[]): string {
  return JSON.stringify(ladder);
}

/** True iff `a` and `b` are the same rungs in the same order (used to
 *  decide whether the tier cap's filter+rescue actually changed anything -
 *  binding interpretation 4). */
function sameLadder(a: readonly LadderRung[], b: readonly LadderRung[]): boolean {
  return ladderSignature(a) === ladderSignature(b);
}

/**
 * §8.3 tier cap (binding interpretation 4). Returns the (possibly
 * unmodified) ladder plus whether anything was actually capped away. Only
 * ever called from the rule-(iii) full-software branch below.
 */
function applyTierCap(
  ladder: readonly LadderRung[],
  tier: ServerPolicy["tier"],
  sourceHeightPx: number | null,
): { ladder: LadderRung[]; tierCapped: boolean } {
  if (tier !== 0 || sourceHeightPx === null || sourceHeightPx < 1080 || ladder.length === 0) {
    return { ladder: [...ladder], tierCapped: false };
  }

  const filtered = ladder.filter((rung) => rung.heightPx <= 480);
  const final =
    filtered.length > 0
      ? filtered
      : [ladder.reduce((min, rung) => (rung.videoBitrateBps < min.videoBitrateBps ? rung : min))];

  return { ladder: final, tierCapped: !sameLadder(ladder, final) };
}

/** §8.3's `allowToneMapCpu` resolution for the SOFTWARE tone-map branch
 *  only (docs/PLAYBACK.md §2.4: "'tier-gated' (T0 -> never)" - tier 0 never
 *  resolves true under 'tier-gated'; any other tier does). Named separately
 *  from `stages/hdr.ts`'s own (structurally identical) resolution check
 *  because this module may not import that one (purity / single-purpose
 *  stage files - docs/PLAYBACK.md §1). */
function cpuToneMapAllowed(policy: ServerPolicy): boolean {
  return policy.allowToneMapCpu === "always" || (policy.allowToneMapCpu === "tier-gated" && policy.tier >= 1);
}

export interface HardwareRoutingResult {
  /** Informational reasons only, in emission order - never blocking-class
   *  (docs/PLAYBACK.md §4: Stage G's reasons are exactly `hw-encoder-
   *  selected:*` / `software-fallback:*`, both informational). */
  reasons: PlanReason[];
  /** The chosen backend (§5 `PlaybackPlanVideo.encoder`). Always set - a
   *  route is always chosen (rule iii is an unconditional last resort). */
  encoder: HardwareBackend;
  /** Set iff a tone-map method was actually resolved for the chosen route
   *  (binding interpretation 3); absent (never `undefined`, per
   *  `exactOptionalPropertyTypes`) when no tone-map was needed OR none could
   *  be resolved for the chosen route. */
  toneMap?: ToneMapMethod;
  /** The FINAL ladder - identical to the input `ladder` unless the rule-iii
   *  tier cap (binding interpretation 4) fired. `src/plan.ts` replaces its
   *  own `ladder` binding with this value. */
  ladder: LadderRung[];
}

/**
 * Stage G (docs/PLAYBACK.md §3/§8.3). `src/plan.ts` calls this ONLY when
 * `video.action === 'transcode'` and the plan is not tone-map-refused (see
 * this module's header). Pure function of its own inputs.
 *
 * @param media              For resolving the SELECTED video stream's own
 *                           codec + height (binding interpretations 2/4).
 * @param videoStreamIndex   `selection.videoStreamIndex`, as threaded
 *                           through every other stage.
 * @param caps               `VerifiedCapabilities` (§2.5) - the FAKED P3.3
 *                           fixture sets until step 5's real probe lands.
 * @param policy             For `tier` (tier cap + tier-gated tone-map) and
 *                           `allowToneMapCpu` (software tone-map gate).
 * @param ladder             Stage F's ALREADY-BUILT ladder
 *                           (`stages/ladder.ts`'s `buildLadder` output,
 *                           called by `src/plan.ts` before this function) -
 *                           this module reads its target codecs from it and
 *                           may replace it (tier cap) but never re-derives
 *                           it from scratch.
 * @param toneMapRequired    Whether Stage C (`stages/hdr.ts`) fired a
 *                           tone-map-required reason on THIS plan (`src/
 *                           plan.ts` computes this once from the reasons
 *                           Stages A-F already produced).
 */
export function routeHardware(
  media: MediaInfo,
  videoStreamIndex: number | null,
  caps: VerifiedCapabilities,
  policy: ServerPolicy,
  ladder: readonly LadderRung[],
  toneMapRequired: boolean,
): HardwareRoutingResult {
  const stream = videoStreamIndex !== null ? media.video.find((v) => v.index === videoStreamIndex) : undefined;
  // Defensive (never produced by any matrix case or property generator -
  // mirrors every other stage's identical "selection doesn't resolve"
  // branch): a `null` source codec can never satisfy any backend's `decode`
  // list, so this falls straight through rules (i)/(ii) to (iii) - plan()
  // stays TOTAL without a special-cased branch here.
  const sourceCodec = stream?.codec ?? null;
  const sourceHeightPx = stream?.height ?? null;

  const targets = distinctTargetCodecs(ladder);
  const hwBackends = caps.backends.filter((b) => b.backend !== "software");
  const softwareBackend = caps.backends.find((b) => b.backend === "software");

  // Rule (i): first HARDWARE backend covering BOTH decode and encode
  // (binding interpretation 2's hw-only restriction - see the
  // SPEC-LITERAL-READING NOTE in this module's header).
  for (const backend of hwBackends) {
    if (sourceCodec === null || !backend.decode.includes(sourceCodec)) continue;
    if (!encodeCoversTargets(backend, targets)) continue;

    if (!toneMapRequired) {
      return {
        reasons: [
          reason(`hw-encoder-selected:${backend.backend}`, stream?.index, `decode+encode via ${backend.backend}`),
        ],
        encoder: backend.backend,
        ladder: [...ladder],
      };
    }
    const method = pickToneMapMethod(backend);
    if (method) {
      return {
        reasons: [
          reason(
            `hw-encoder-selected:${backend.backend}`,
            stream?.index,
            `decode+encode via ${backend.backend}, toneMap=${method}`,
          ),
        ],
        encoder: backend.backend,
        toneMap: method,
        ladder: [...ladder],
      };
    }
    // Tone-map required but this candidate has no usable method - falls
    // through to the NEXT rule-(i) candidate (binding interpretation 3),
    // never disqualifying the rule as a whole.
  }

  // Rule (ii): first HARDWARE backend covering encode alone, decode falling
  // to software (which must itself be able to decode the source codec).
  for (const backend of hwBackends) {
    if (!encodeCoversTargets(backend, targets)) continue;
    if (sourceCodec === null || !softwareBackend?.decode.includes(sourceCodec)) continue;

    if (!toneMapRequired) {
      return {
        reasons: [
          reason(
            "software-fallback:decode",
            stream?.index,
            `encode via ${backend.backend}, decode via software`,
          ),
        ],
        encoder: backend.backend,
        ladder: [...ladder],
      };
    }
    const method = pickToneMapMethod(backend);
    if (method) {
      return {
        reasons: [
          reason(
            "software-fallback:decode",
            stream?.index,
            `encode via ${backend.backend}, decode via software, toneMap=${method}`,
          ),
        ],
        encoder: backend.backend,
        toneMap: method,
        ladder: [...ladder],
      };
    }
    // Falls through, exactly like rule (i) above.
  }

  // Rule (iii): full software - the unconditional last resort.
  const reasons: PlanReason[] = [
    reason("software-fallback:encode", stream?.index, "no hardware backend covers this route"),
  ];

  const { ladder: cappedLadder, tierCapped } = applyTierCap(ladder, policy.tier, sourceHeightPx);
  if (tierCapped) {
    reasons.push(
      reason(
        "software-fallback:tier-capped",
        stream?.index,
        `tier=${policy.tier} sourceHeightPx=${sourceHeightPx ?? "null"}`,
      ),
    );
  }

  const result: HardwareRoutingResult = {
    reasons,
    encoder: "software",
    ladder: cappedLadder,
  };
  if (toneMapRequired && cpuToneMapAllowed(policy)) {
    result.toneMap = "cpu-zscale";
  }
  return result;
}
