// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `plan()` — the pure `PlaybackPlan` pipeline (docs/PLAYBACK.md §3).
 *
 * Phase 3 §11 step 3 scope: Stage G (hardware routing, `stages/hardware.ts`)
 * is now WIRED IN — every stage A-G is a real implementation. Stages A-F
 * landed across §11 step 2 (Phase 3 Steps 2a-2f: container, video, HDR,
 * audio, subtitle, bitrate/ladder); this step adds the last one, per
 * `stages/hardware.ts`'s own header for the full §8.3 selection rules,
 * tone-map method table, and tier-cap logic. `stages/not-implemented.ts`
 * (the permissive pass-through stub Stages B-F used before their own steps
 * landed) is DELETED — it had no remaining call sites (Step 2f's own header
 * already noted this), and Stage G was never stubbed by it in the first
 * place (docs/PLAYBACK.md §3: "only when transcoding video", which no stub
 * could ever produce).
 *
 * Phase 3 §11 step 4 addition: `ffmpegArgs` (docs/PLAYBACK.md §6) is now
 * REAL for every decision except direct-play and tone-map-refused transcode
 * (both stay `[]` — see the `ffmpegArgs` assembly comment below, near this
 * function's `return`), built by `args/builder.ts`'s pure `buildFfmpegArgs`.
 * `plan()` itself never inspects args content — it only decides WHETHER to
 * call the builder and, for a transcode, WHICH ladder rung (`topRung`,
 * computed in the Stage G block below) to build them for.
 *
 * Phase 3 step 7b fixes F1/F2 (assembly-level, orchestrator-locked):
 * - F2 (route-level tone-map refusal): Stage C (`stages/hdr.ts`) now ONLY
 *   determines that a tone-map is REQUIRED; the §3 refusal seam ("if Stage
 *   G yields no hardware method and `allowToneMapCpu` resolves to never")
 *   is decided HERE, from `routeHardware`'s full §8.3 resolution — see the
 *   Stage G block below. Step 2c's caps-global refusal check inside Stage C
 *   (P3.9(b)-era, pre-Stage-G) is deleted; matrix cases 447/448 pin the
 *   routes it got wrong. Refused plans keep Step 2c's output shape exactly:
 *   decision 'transcode', `tone-map-refused-by-policy` directly AFTER the
 *   Stage-C branch reason, `ladder: []`, `ffmpegArgs: []`, no
 *   encoder/targetCodec/toneMap, and NO Stage-G routing reason (nothing was
 *   selected).
 * - F1 (`policy.allowTranscode === false`, §2.4/§4/§10's transcode-disabled
 *   dimension — previously consumed nowhere, its §4 blocking code
 *   unemittable): when the aggregated decision is 'transcode' and the
 *   policy disallows it, the plan keeps decision 'transcode' (§3's "the
 *   engine NEVER emits unplayable" total-output pattern) and mirrors the
 *   tone-map-refused empty-output shape: `transcode-disabled-by-policy`
 *   appended LAST (an assembly-level policy verdict, not a stage axis —
 *   after every stage's reasons), `ladder: []`, `ffmpegArgs: []`, video
 *   encoder/targetCodec/toneMap unset (Stage G skipped — nothing to
 *   route), audio target* fields unset. The disabled check runs FIRST:
 *   tone-map refusal evaluation is moot on a disabled plan (Stage G never
 *   runs), so only `transcode-disabled-by-policy` is appended (BIND).
 *   direct-stream/remux/direct-play are UNAFFECTED — repackaging is not
 *   transcoding; copy-only HLS/remux stays allowed (matrix cases 453/489/
 *   505 pin the boundary).
 *
 * Stage F's own reason rule (docs/PLAYBACK.md §3) needs a "final video
 * verdict is copy" fact ahead of its own evaluation — `videoAlreadyTranscoding`
 * below, threaded into `evaluateBitrate` exactly like Stage C's
 * `containerDirectPlayable` and Stage E's `videoVerdict` threaded-boolean
 * convention (see `stages/ladder.ts`'s own header for the full reason-rule
 * text and the two pinned unless-clause directions). `buildLadder` (also
 * `stages/ladder.ts`) is called separately, from final assembly, only when
 * `video.action === 'transcode'` AND the plan does NOT carry a fired
 * `tone-map-refused-by-policy` reason (see the `ladder` assembly comment
 * below for the full predicate and the do-not-break history from Step 2c).
 * Stage G (`routeHardware`, `stages/hardware.ts`) runs immediately after,
 * under the SAME gate, and may REPLACE `ladder` with a tier-capped version
 * of the same table (its own header's binding interpretation 4) — the
 * `ladder` binding below is therefore `let`, not `const`, for the first time
 * this step.
 *
 * Stage E's return shape (`stages/subtitle.ts`'s `SubtitleStageOutput`) is
 * NOT a bare `StageResult` — it also carries the chosen `strategy` and
 * `streamIndex` (docs/PLAYBACK.md §5's `PlaybackPlanSubtitle`), since
 * `stages/types.ts` stays untouched this step (architecture requirement 1).
 * `plan()` destructures it below: `.result` feeds the ordinary stage-severity
 * aggregation exactly like every other stage, while `.strategy`/
 * `.streamIndex` assemble the §5 `subtitle` output field AND extend the
 * video-action rule with the burn-in fact (binding interpretation
 * constraint 6 — see the `video` assembly comment below, now extended AGAIN
 * by this step to include Stage F's own verdict).
 *
 * Stage D's rule 4 (target codec/channels/bitrate selection, docs/
 * PLAYBACK.md §3 Stage D.4) is an ASSEMBLY-level concern per Step 2d's
 * binding interpretation constraint 4 — `stages/audio.ts` only decides the
 * stage's verdict + reasons; `assembleAudio` below computes the §5
 * `PlaybackPlanAudio` target fields whenever that verdict is `'transcode'`.
 * See its own doc comment for the two documented interpretations (the
 * bitrate-band boundaries, and the priority-codec fallback when NEITHER
 * priority codec is present in `device.audio`).
 *
 * `plan()` is TOTAL as of Step 2a (docs/PLAYBACK.md §10 property 3): it
 * never throws on any structurally valid `PlanInput`. `NotImplementedError`
 * (src/index.ts) is no longer thrown from anywhere in this pipeline.
 */
import type {
  AudioCodec,
  DeviceProfile,
  LadderRung,
  MediaInfo,
  PlanInput,
  PlaybackPlan,
  PlaybackPlanAudio,
  PlaybackPlanSubtitle,
  PlaybackPlanVideo,
  PlanDecision,
  ServerPolicy,
  TrackSelection,
} from "./types.js";
import { isBlockingReasonCode, type PlanReason } from "./reasons.js";
import { evaluateContainer } from "./stages/container.js";
import { evaluateVideo } from "./stages/video.js";
import { evaluateHdr } from "./stages/hdr.js";
import { evaluateAudio } from "./stages/audio.js";
import { evaluateSubtitle } from "./stages/subtitle.js";
import { evaluateBitrate, buildLadder } from "./stages/ladder.js";
import { routeHardware } from "./stages/hardware.js";
import { STAGE_SEVERITY, severityToVerdict, type StageResult } from "./stages/types.js";
import { buildFfmpegArgs } from "./args/builder.js";

/**
 * Engine ruleset version, stamped onto every `PlaybackPlan` for audit rows
 * (docs/PLAYBACK.md §5/§9). Bump policy: MINOR per stage/step landing,
 * PATCH for decision-rule fixes that don't add/replace a stage (0.8.0 →
 * 0.8.1: step 7b's three audit-driven divergence fixes — F2 route-level
 * tone-map refusal, F1 allowTranscode enforcement, F4 vaapi burn-in
 * hwdownload/hwupload in the arg builder — no new stage; the golden count
 * grew 25 → 27 with F4's two vaapi burn-in scenarios. 0.8.1 → 0.8.2: the
 * step-7 owner-smoke REAL-EXECUTION fix for the videotoolbox tone-map
 * route — args/builder.ts interpretation D's two VT routes ((a) pure-hw
 * `-hwaccel_output_format videotoolbox_vld` + scale_vt fold, (b) hybrid
 * sw-chain fallback); ffmpegArgs-only change, no decision/reason/toneMap
 * flips, golden count 27 → 28 with the hybrid-deinterlace scenario).
 */
export const ENGINE_VERSION = "0.8.2";

/**
 * Stage D assembly (docs/PLAYBACK.md §3 Stage D.4, binding interpretation
 * constraint 4): "Target codec = first of `policy.audioTranscodeCodecPriority`
 * present in device.audio." INTERPRETATION: if NEITHER priority codec has a
 * device.audio entry, the plan stays TOTAL (docs/PLAYBACK.md §10 property 3)
 * by falling back to `priority[0]` — every real §10 device fixture declares
 * aac, so this branch is a defensive completeness net, not a normal path;
 * reported as an interpretation, not a silent choice (matrix case 244 pins
 * it against a device declaring neither opus nor aac).
 */
function pickAudioTargetCodec(policy: ServerPolicy, device: DeviceProfile): AudioCodec {
  for (const candidate of policy.audioTranscodeCodecPriority) {
    if (device.audio.some((entry) => entry.codec === candidate)) return candidate;
  }
  return policy.audioTranscodeCodecPriority[0] ?? "aac";
}

/**
 * Stage D.4's three bitrate anchors ("2ch→160k, 6ch→384k, 8ch→512k") are
 * read as BAND boundaries — ≤2ch, 3-6ch, ≥7ch — since the spec gives three
 * POINTS, not a full function over every channel count. INTERPRETATION,
 * reported per this step's instructions (matrix cases 241/242/243/244/245/
 * 246 exercise all three bands).
 */
function audioBitrateForChannels(channels: number): number {
  if (channels <= 2) return 160_000;
  if (channels <= 6) return 384_000;
  return 512_000;
}

/**
 * Assembles the §5 `PlaybackPlanAudio` output field. `stageD` is Stage D's
 * own `{verdict, reasons}` (`stages/audio.ts`) — this function never
 * re-derives the verdict, only consumes it. Target fields are computed ONLY
 * when `stageD.verdict === 'transcode'`; a copy/none action carries no
 * target* fields at all (§5 marks them optional).
 *
 * Sample-rate preservation/resample-to-48k (also rule 4) has NO §5 output
 * field — arg-builder (§11 step 4) territory; deliberately not computed or
 * emitted here.
 */
function assembleAudio(
  media: MediaInfo,
  device: DeviceProfile,
  policy: ServerPolicy,
  selection: TrackSelection,
  stageD: StageResult,
): PlaybackPlanAudio {
  const stream =
    selection.audioStreamIndex !== null
      ? media.audio.find((a) => a.index === selection.audioStreamIndex)
      : undefined;

  if (!stream) return { action: "none" };
  if (stageD.verdict !== "transcode") return { action: "copy" };

  const targetCodec = pickAudioTargetCodec(policy, device);
  const targetEntry = device.audio.find((entry) => entry.codec === targetCodec);
  const targetChannels = targetEntry ? Math.min(stream.channels, targetEntry.maxChannels) : stream.channels;
  const rawBitrateBps = audioBitrateForChannels(targetChannels);
  const targetBitrateBps = targetCodec === "opus" ? Math.round(rawBitrateBps * 0.75) : rawBitrateBps;

  return { action: "transcode", targetCodec, targetChannels, targetBitrateBps };
}

/**
 * `container` field mapping (docs/PLAYBACK.md §5 output contract +
 * architecture requirement 3 for this step): `'source'` for direct-play;
 * for direct-stream/transcode (both repackage into HLS — §6/§9's muxer is
 * shared by both), `'fmp4-hls'` when `device.hls.supportsFmp4` else
 * `'ts-hls'`; `'mp4'` for remux (a progressive file, §3 Final assembly).
 */
function decisionToContainer(decision: PlanDecision, device: DeviceProfile): PlaybackPlan["container"] {
  switch (decision) {
    case "direct-play":
      return "source";
    case "remux":
      return "mp4";
    case "direct-stream":
    case "transcode":
      return device.hls.supportsFmp4 ? "fmp4-hls" : "ts-hls";
  }
}

export function plan(input: PlanInput): PlaybackPlan {
  const { media, device, selection, mode } = input;

  // Reason ORDER CONTRACT (docs/PLAYBACK.md §4: "every fired reason
  // (ordered by stage, then axis)"): stage results are concatenated in this
  // fixed A,B,C,D,E,F order — never re-sorted, never interleaved. Each
  // stage module is itself responsible for the "then axis" ordering WITHIN
  // its own `reasons` array (Stage A only ever emits one reason, so there
  // is no intra-stage ordering decision to make yet).
  const stageA = evaluateContainer(media, device);
  const stageB = evaluateVideo(media, device, selection.videoStreamIndex);
  // Stage C (HDR): `containerDirectPlayable` is threaded in as a plain
  // boolean derived from Stage A's OWN verdict (binding interpretation
  // constraint 3 — stages/hdr.ts's header explains why the strip-reason
  // gating lives on this fact rather than the stage re-deriving container
  // membership itself). Stage A only ever verdicts 'direct-play' when the
  // container IS in device.directPlayContainers (stages/container.ts), so
  // this equality is exact, not an approximation.
  const containerDirectPlayable = stageA.verdict === "direct-play";
  // Step 7b fix F2: Stage C no longer reads policy/caps at all — tone-map
  // REFUSAL is decided below, at the Stage G assembly block, from the real
  // §8.3 route resolution.
  const stageC = evaluateHdr(media, device, selection.videoStreamIndex, containerDirectPlayable);
  const stageD = evaluateAudio(media, device, selection.audioStreamIndex);
  // Stage E (subtitle): returns a composed shape (`.result` + `.strategy` +
  // `.streamIndex`), not a bare StageResult — see stages/subtitle.ts's header
  // and this file's own header note. `videoVerdict` is Stage B's OWN verdict
  // (binding interpretation constraint 6), threaded in exactly like Stage
  // C's `containerDirectPlayable` above.
  const stageESubtitle = evaluateSubtitle(
    media,
    device,
    input.policy,
    selection.subtitleStreamIndex,
    containerDirectPlayable,
    stageB.verdict,
  );
  const stageE = stageESubtitle.result;
  // Stage F (bitrate/ladder — docs/PLAYBACK.md §3/§7, Phase 3 Step 2f):
  // `videoAlreadyTranscoding` is Stage F's OWN "final video verdict is copy"
  // fact (binding interpretation constraint 1, stages/ladder.ts's header) —
  // the SAME three-way disjunction the video.action assembly below already
  // needed for Stages B/C/E, computed once here and reused there. Stage F's
  // own verdict is deliberately excluded from this disjunction (it hasn't
  // run yet, and including it would be circular).
  const videoAlreadyTranscoding =
    stageB.verdict === "transcode" || stageC.verdict === "transcode" || stageESubtitle.strategy === "burn-in";
  const stageF = evaluateBitrate(media, device, input.network, selection.videoStreamIndex, videoAlreadyTranscoding);
  // Stage G (hardware routing) is assembly-level, not a `StageResult` at all
  // (it never contributes to severity — see stages/hardware.ts's header) —
  // it runs later, below, once `video.action` and `ladder` are known.

  const stages: StageResult[] = [stageA, stageB, stageC, stageD, stageE, stageF];
  const reasons: PlanReason[] = stages.flatMap((s) => s.reasons);

  const maxSeverity = stages.reduce((acc, s) => Math.max(acc, STAGE_SEVERITY[s.verdict]), 0);
  const aggregatedVerdict = severityToVerdict(maxSeverity);

  // Final assembly (docs/PLAYBACK.md §3 "Final assembly", quoted verbatim):
  // "mode==='download' and container-only change → remux (progressive
  // file)". "Container-only change" = the aggregated verdict only reached
  // direct-stream (never transcode — transcode always wins the max()) AND
  // every fired reason is Stage A's container reason (i.e. nothing else
  // contributed an escalation).
  //
  // RESOLVED (Phase 3 Step 2c orchestrator review; ENGINE_VERSION patch
  // bump 0.3.0→0.3.1 per the documented decision-rule-fix policy): Stage C
  // can contribute the INFORMATIONAL reason `dv-stripped-to-hdr10`
  // alongside Stage A's container reason. "Container-only change" is
  // judged on BLOCKING-class reasons only — §4's class split is the
  // authoritative structure (blocking-class forces severity;
  // informational-class never does), and the DV metadata strip is an
  // arg-builder action performed identically during a progressive-mp4
  // remux, so its presence does not make the change any less
  // container-only. Predicate: aggregated verdict reached exactly
  // direct-stream AND the (non-empty) set of BLOCKING reasons is exactly
  // {container-not-direct-playable}; informational reasons are ignored.
  // Pinned by matrix case 205 (download + dv8.1-compat + hdr10 device →
  // remux) and test/plan.spec.ts.
  const blockingReasons = reasons.filter((r) => isBlockingReasonCode(r.code));
  const containerOnlyChange =
    aggregatedVerdict === "direct-stream" &&
    blockingReasons.length > 0 &&
    blockingReasons.every((r) => r.code === "container-not-direct-playable");

  const decision: PlanDecision = mode === "download" && containerOnlyChange ? "remux" : aggregatedVerdict;

  const container = decisionToContainer(decision, device);

  // video action (architecture requirement 3; Step 2c binding interpretation
  // constraint 6 extended Step 2b's rule to Stage C; Step 2e extended it
  // AGAIN to Stage E; THIS step's binding interpretation constraint extends
  // it a THIRD time to Stage F): 'none' when the selection index is null or
  // the stream list is empty (nothing selected — matches Stage B/C/F's own
  // vacuous-pass condition in stages/video.ts / stages/hdr.ts /
  // stages/ladder.ts exactly); otherwise 'copy' unless Stage B verdicted
  // 'transcode', Stage C verdicted 'transcode', Stage E chose the 'burn-in'
  // subtitle strategy (`videoAlreadyTranscoding`, computed above for Stage
  // F's own gate and reused here verbatim), OR Stage F itself verdicted
  // 'transcode' (docs/PLAYBACK.md §3 Stage F: "transcode VIDEO" — the
  // bitrate-exceeds-network escalation is explicitly a video-track
  // decision, exactly like B/C/E's). `targetCodec`/`encoder`/`toneMap` stay
  // UNSET here at construction time — they are filled in BELOW, after the
  // ladder is built, by the Stage G block (`routeHardware`,
  // stages/hardware.ts) — this mirrors Stage D's `assembleAudio` pattern
  // (assembly-level fields computed after the stage's own verdict is known,
  // not inside the stage module itself). They stay unset for good on a
  // refused plan or a non-video transcode (Stage G's own gate, see below).
  const video: PlaybackPlanVideo = {
    action:
      selection.videoStreamIndex !== null && media.video.length > 0
        ? videoAlreadyTranscoding || stageF.verdict === "transcode"
          ? "transcode"
          : "copy"
        : "none",
  };
  // audio action + target* fields (architecture requirement 3 / this step's
  // binding interpretation constraints 1/4): 'none' mirrors Stage D's own
  // vacuous-pass condition (selection.audioStreamIndex null, or the index
  // doesn't resolve to a real stream); otherwise 'copy' unless Stage D
  // itself verdicted 'transcode', in which case `assembleAudio` computes
  // the target codec/channels/bitrate per rule 4 (see that function's doc
  // comment for the two documented interpretations). `let`, not `const`,
  // since step 7b fix F1: a transcode-disabled plan strips the target*
  // fields back off below (nothing will be transcoded, so reporting
  // targets would be false — mirrors the refused plan's unset video
  // fields).
  let audio: PlaybackPlanAudio = assembleAudio(media, device, input.policy, selection, stageD);

  // subtitle (architecture requirement 3 / 9 — Stage E's OWN chosen
  // strategy + streamIndex, no re-derivation here): `streamIndex` is present
  // iff `strategy !== 'none'`, which `stages/subtitle.ts`'s
  // `SubtitleStageOutput` already guarantees (never set to `undefined`, to
  // satisfy `exactOptionalPropertyTypes`).
  const subtitle: PlaybackPlanSubtitle =
    stageESubtitle.streamIndex !== undefined
      ? { strategy: stageESubtitle.strategy, streamIndex: stageESubtitle.streamIndex }
      : { strategy: stageESubtitle.strategy };

  // Transcode-disabled verdict (step 7b fix F1 — see this module's header):
  // an ASSEMBLY-level policy check, evaluated FIRST, before the ladder /
  // Stage G / tone-map-refusal block below. Only an aggregated 'transcode'
  // decision is in scope — direct-stream/remux/direct-play repackage or
  // serve untouched streams (repackaging is not transcoding; copy-only
  // HLS/remux stays allowed), so the knob has nothing to disable there.
  const transcodeDisabled = decision === "transcode" && !input.policy.allowTranscode;

  // ladder (docs/PLAYBACK.md §7, Phase 3 Step 2f; gates reworked by step 7b
  // fixes F1/F2): built via stages/ladder.ts's `buildLadder` inside the
  // Stage-G block below iff `video.action === 'transcode'` AND the
  // transcode is not policy-disabled. Audio-only transcodes, copy/none
  // video decisions, disabled plans, and (after routing) tone-map-REFUSED
  // plans all end at `[]` (§5: "ladder (may be empty for copy/audio-only
  // decisions)"; §3: the refused plan "emits transcode with `ladder: []`" —
  // Step 2c's pinned contract, unchanged in shape; only the refusal's
  // DERIVATION moved to the route level, so the built ladder is DISCARDED
  // when the route resolution comes back refused).
  let ladder: LadderRung[] = [];
  const toneMapRequired = reasons.some(
    (r) => r.code === "hdr-tone-map-required" || r.code === "dv-profile5-requires-tonemap",
  );
  let toneMapRefused = false;

  // Stage G — hardware routing (docs/PLAYBACK.md §3/§8.3, Phase 3 §11 step
  // 3, stages/hardware.ts's `routeHardware`) + the step 7b F2 route-level
  // tone-map refusal authority. Runs iff `video.action === 'transcode'`
  // AND not transcode-disabled (F1's BIND: the disabled check runs FIRST —
  // there is nothing to route, and tone-map refusal evaluation is moot on
  // a disabled plan). `toneMapRequired` is derived once from the reasons
  // Stages A-F already produced (either of Stage C's two tone-map-required
  // codes). REFUSAL (docs/PLAYBACK.md §3's "if Stage G yields no hardware
  // method and `allowToneMapCpu` resolves to never" seam, in full §8.3
  // terms): `routeHardware` resolves rules (i)/(ii) with per-candidate
  // method fall-through and then the software route's cpu-zscale policy
  // check — when a tone-map is required and that WHOLE resolution yields
  // no method (`routing.toneMap` unset), the plan is REFUSED:
  // `tone-map-refused-by-policy` is spliced in directly AFTER Stage C's
  // branch reason (the same position Step 2c's in-stage append produced —
  // seed case 144 pins [hdr-tone-map-required, tone-map-refused-by-policy]
  // exactly), the routing's reasons/encoder/ladder are DISCARDED (nothing
  // was selected — no hw-encoder-selected/software-fallback reason ever
  // lands on a refused plan, matrix case 420), and
  // encoder/targetCodec/toneMap stay unset with `ladder: []`.
  // On the non-refused path, `routeHardware` may REPLACE `ladder` with a
  // tier-capped version of the same table (its own header's binding
  // interpretation 4). Routing reasons append AFTER every Stage A-F reason
  // already in the array (docs/PLAYBACK.md §4: "ordered by stage, then
  // axis" — A..G is the stage order), and `video.encoder`/
  // `video.targetCodec`/`video.toneMap` are filled in here, the one place
  // in `plan.ts` that owns Stage G's assembly (mirrors `assembleAudio`'s
  // identical role for Stage D's rule 4).
  // `topRung` (declared here, one scope up, so §11 step 4's arg-builder
  // call after this `if` can still see it): the DEFAULT rung
  // `buildFfmpegArgs` targets for `plan()`'s own args ("DEFAULT rung = the
  // TOP surviving rung, matching video.targetCodec"). Stays `undefined`
  // for every decision that never reaches a real ladder
  // (copy/none/refused/disabled) — the arg builder is never called with a
  // `rung` in those cases anyway.
  let topRung: LadderRung | undefined;

  if (video.action === "transcode" && !transcodeDisabled) {
    const builtLadder = buildLadder(media, device, input.network, input.policy, selection.videoStreamIndex);
    const routing = routeHardware(
      media,
      selection.videoStreamIndex,
      input.caps,
      input.policy,
      builtLadder,
      toneMapRequired,
    );

    if (toneMapRequired && routing.toneMap === undefined) {
      // REFUSED (step 7b fix F2). The tier-gated/'never' resolution
      // semantics live unchanged in stages/hardware.ts's cpuToneMapAllowed
      // — by construction the only method-less outcome under
      // `toneMapRequired` is the software route with CPU tone-mapping
      // disallowed (hw candidates lacking a usable method fall through
      // rather than being selected).
      toneMapRefused = true;
      const branchIdx = reasons.findIndex(
        (r) => r.code === "hdr-tone-map-required" || r.code === "dv-profile5-requires-tonemap",
      );
      const stream =
        selection.videoStreamIndex !== null
          ? media.video.find((v) => v.index === selection.videoStreamIndex)
          : undefined;
      const refusal: PlanReason = {
        code: "tone-map-refused-by-policy",
        detail: `allowToneMapCpu=${input.policy.allowToneMapCpu} tier=${input.policy.tier}`,
      };
      if (stream !== undefined) refusal.streamIndex = stream.index;
      reasons.splice(branchIdx + 1, 0, refusal);
      // `ladder` stays [], `topRung` stays undefined, and none of
      // encoder/targetCodec/toneMap are ever set.
    } else {
      reasons.push(...routing.reasons);
      ladder = routing.ladder;
      video.encoder = routing.encoder;
      if (routing.toneMap !== undefined) {
        video.toneMap = routing.toneMap;
      }
      // targetCodec = the TOP surviving rung's codec, highest
      // videoBitrateBps (binding interpretation constraint 4,
      // stages/hardware.ts's header) — read from the FINAL (post-tier-cap)
      // ladder, not the pre-cap one.
      topRung = ladder.reduce<LadderRung | undefined>(
        (max, rung) => (max === undefined || rung.videoBitrateBps > max.videoBitrateBps ? rung : max),
        undefined,
      );
      if (topRung !== undefined) {
        video.targetCodec = topRung.codec;
      }
    }
  }

  if (transcodeDisabled) {
    // Step 7b fix F1: the blocking policy verdict lands LAST — after every
    // stage's reasons (it is an assembly-level verdict, not a stage axis;
    // Stage G was skipped, so no routing reason precedes it either), making
    // §4's previously-unemittable `transcode-disabled-by-policy` real. The
    // output mirrors the tone-map-refused shape exactly (the session layer
    // surfaces both identically): audio target* fields are stripped back
    // off here — Stage D's verdict (and its own reasons) stand, but no
    // transcode will run, so reporting target codec/channels/bitrate would
    // be false.
    reasons.push({
      code: "transcode-disabled-by-policy",
      detail: "policy.allowTranscode=false",
    });
    if (audio.action === "transcode") {
      audio = { action: "transcode" };
    }
  }

  // ffmpegArgs (docs/PLAYBACK.md §6, Phase 3 §11 step 4 — `args/builder.ts`'s
  // `buildFfmpegArgs`, now wired in). §5 mandates `[]` ONLY for direct-play;
  // step 4 extended that to the tone-map-refused case ("nothing to run" — a
  // refused plan has no encoder/method/ladder at all, so there is no ffmpeg
  // invocation to describe), and step 7b fix F1 extends it identically to
  // the transcode-disabled case (same refused-style empty-output shape;
  // also load-bearing: a disabled plan's audio target* fields are stripped,
  // so the builder MUST not be invoked). Every OTHER decision gets
  // REAL token-form args: `plan()`'s own call always uses `withSeek: false`
  // (this step's BIND — the session layer's seek-restart is the only
  // `withSeek: true` caller) and, for a transcode, the TOP surviving rung
  // computed above as `topRung`.
  //
  // SURFACED EDGE CASE (found by this step's own totality proof, reported —
  // not silently patched — since docs/PLAYBACK.md never addresses it): a
  // `video.action === 'transcode'` plan CAN still reach here with
  // `topRung === undefined` when `policy.ladderRungs` is itself configured
  // empty (`stages/ladder.ts`'s `buildLadder` returns `[]` immediately for
  // an empty input table, docs/PLAYBACK.md §7 has no "the instance ladder
  // itself is empty" case) — no property generator ever constructs this
  // (`matrix/lib/generators.ts`'s `genRandomPolicy` always supplies the real
  // 6-rung table), but several hand-written unit test fixtures across this
  // package deliberately do (e.g. `stages/hardware.ts`'s own `empty-ladder`
  // fixture, and multiple `test/*.spec.ts` policy literals), and nothing in
  // `ServerPolicy`'s type forbids an admin from configuring it for real.
  // `buildFfmpegArgs` has no rung to encode to in that case — rather than
  // throw (which would make `plan()` non-total, violating docs/PLAYBACK.md
  // §10 property 3 the moment ANY caller supplies this legitimately-typed
  // but degenerate policy), this is treated exactly like the tone-map-
  // refused case: "nothing to run", `ffmpegArgs: []`, even though `decision`
  // still reports `'transcode'`. Candidate docs/PLAYBACK.md §7 clarification
  // (an instance ladder table should probably never be empty by admin
  // config in the first place) — flagged for owner/spec review, not
  // resolved by adding a fabricated rung here.
  const hasUsableRung = video.action !== "transcode" || topRung !== undefined;
  const ffmpegArgs: string[] =
    decision === "direct-play" || toneMapRefused || transcodeDisabled || !hasUsableRung
      ? []
      : buildFfmpegArgs(
          input,
          // `rung` is genuinely OMITTED (not set to `undefined` —
          // `exactOptionalPropertyTypes`) when video isn't transcoding, per
          // every other optional-field convention this package already uses.
          video.action === "transcode" && topRung !== undefined
            ? { container, video, audio, subtitle, rung: topRung }
            : { container, video, audio, subtitle },
          { withSeek: false },
        );

  return {
    decision,
    reasons,
    container,
    video,
    audio,
    subtitle,
    ladder,
    ffmpegArgs,
    engineVersion: ENGINE_VERSION,
  };
}
