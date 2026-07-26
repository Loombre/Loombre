// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage E — Subtitles (docs/PLAYBACK.md §3, quoted verbatim):
 *
 *   "Stage E — Subtitles (selected subtitle only; none selected -> verdict
 *   none).
 *   TEXT codec:
 *     device.subtitles.hlsVtt && policy.preferredTextSubMode==='hls-vtt'
 *         -> 'hls-vtt' (segmented WebVTT side-track; ASS loses styling ->
 *           add reason 'subtitle-styling-lost' when codec==='ass'
 *           unless policy.preserveAssStyling -> then 'burn-in',
 *           reason 'subtitle-burn-in-for-styling')
 *     device renders codec natively in directPlayContainer -> 'embed' (copy)
 *     else -> 'burn-in', reason 'subtitle-format-requires-burn-in'
 *   IMAGE codec (pgs|vobsub|dvbsub|unknown):
 *     device.subtitles.renderImage && container playable -> 'embed'
 *     else -> 'burn-in', reason 'subtitle-format-requires-burn-in'
 *   `burn-in` FORCES video transcode (adds `video-transcode-for-subtitle-
 *   burn-in` if B verdict was copy). `hls-vtt` and `none` never force video
 *   work."
 *
 * And §2.1's kind partition: "`codec in {subrip, ass, webvtt, mov_text}` =
 * TEXT; `{pgs, vobsub, dvbsub}` = IMAGE. `unknown` of either kind -> treat as
 * IMAGE (conservative: burn-in path) with reason `subtitle-codec-unknown`."
 *
 * ---------------------------------------------------------------------------
 * Return shape (Phase 3 Step 2e architecture requirement 1) — `StageResult`
 * alone has no room for the CHOSEN strategy or the subtitle stream index
 * (docs/PLAYBACK.md §5's `PlaybackPlanSubtitle` output field), and
 * `stages/types.ts` is explicitly off-limits this step. `evaluateSubtitle`
 * therefore returns a composed shape, `{ result: StageResult, strategy,
 * streamIndex? }` — `src/plan.ts` destructures it: `result` feeds the
 * ordinary stage-severity/reasons aggregation exactly like every other
 * stage, while `strategy`/`streamIndex` assemble the §5 `subtitle` output
 * field AND (binding interpretation constraint 6) the `video.action`
 * burn-in fact. `streamIndex` is present iff `strategy !== 'none'` (binding
 * interpretation constraint 9) — never set to `undefined`, to satisfy
 * `exactOptionalPropertyTypes` (matches every other stage module's `reason()`
 * helper convention).
 *
 * Scope (mirrors Stage B/C/D's identical documented scoping): this stage
 * evaluates ONLY the SELECTED subtitle stream (`subtitleStreamIndex`). A
 * null selection, a media with no subtitle streams at all, or a selection
 * index that — defensively — doesn't resolve to any stream, is a VACUOUS
 * PASS: `strategy: 'none'`, verdict `'direct-play'`, zero reasons (binding
 * interpretation constraint 1 — this is the §3 sentence's own "none selected
 * -> verdict none" clause, read literally: `'none'` is a `SubtitleStrategy`
 * member, not a `StageVerdict` one, so the vacuous case's *stage* verdict is
 * `'direct-play'`, matching every other stage's identical vacuous-pass
 * convention).
 *
 * ---------------------------------------------------------------------------
 * `containerDirectPlayable` (thread exactly like `stages/hdr.ts`'s identical
 * parameter — see that module's header for why the stage stays pure while
 * still knowing this fact): whether Stage A's own verdict was `'direct-play'`
 * (`src/plan.ts` passes `stageA.verdict === 'direct-play'`). Consumed by
 * BOTH trees' embed branches ("device renders codec natively in
 * directPlayContainer" / "container playable") — an embed can only ever be a
 * silent copy of the original file's stream, which requires the container
 * itself to already be servable as-is.
 *
 * `videoVerdict` (Stage B's OWN verdict, `stages/video.ts`'s `StageResult.
 * verdict` — NOT the aggregated `video.action`, see below): consumed ONLY to
 * decide whether `video-transcode-for-subtitle-burn-in` gets appended
 * (binding interpretation constraint 6, quoting the spec precisely: "adds
 * `video-transcode-for-subtitle-burn-in` IF B VERDICT WAS COPY"). This is
 * deliberately Stage B's verdict alone, not `max(stageB, stageC)` / the
 * eventual `video.action` field — a source that is HDR-tone-map-required
 * (Stage C alone escalating) but otherwise codec/profile/level-compatible
 * (Stage B verdicting 'direct-play') still gets this reason appended when a
 * burn-in also fires, because Stage B itself never independently determined
 * the video stream needed re-encoding; test/stages/subtitle.spec.ts and
 * matrix case 302 (composition C+E) pin this literally-as-spec-says
 * reading against the "avoid it, video's transcoding either way" temptation.
 *
 * ---------------------------------------------------------------------------
 * SPEC INTERPRETATION (binding interpretation constraint 5) — `unknown` codec
 * ALWAYS resolves to `'burn-in'` with `subtitle-codec-unknown` REPLACING
 * `subtitle-format-requires-burn-in`, regardless of `device.subtitles.
 * renderImage`/container playability. The §2.1 parenthetical "conservative:
 * burn-in path" is read as OVERRIDING the IMAGE tree's embed branch entirely
 * for `unknown` specifically — embedding an unidentifiable stream on the
 * strength of a `renderImage` flag that says nothing about THIS format would
 * be reckless (matrix cases 293/294 pin this even when `renderImage: true`
 * AND the container is playable, i.e. exactly the condition that would
 * otherwise embed a genuine `pgs`/`vobsub`/`dvbsub` stream). Candidate
 * docs/PLAYBACK.md clarification PR — the IMAGE codec branch as literally
 * written lists `unknown` alongside `pgs|vobsub|dvbsub` as if it followed
 * the SAME renderImage-gated rule, but §2.1's own parenthetical (stated
 * immediately after the kind partition, closer to the reader than the IMAGE
 * branch text) says otherwise; this implementation follows §2.1's explicit
 * override.
 *
 * SPEC ARTIFACT (surfaced, not resolved — matches the Step-2c/2d precedent of
 * flagging rather than silently choosing): the "adds video-transcode-for-
 * subtitle-burn-in IF B verdict was copy" rule is evaluated purely against
 * Stage B's verdict with no carve-out for "there is no video stream at all"
 * (music mode / no video selected). Stage B's OWN vacuous-pass verdict for
 * that case is `'direct-play'` (`stages/video.ts`: `videoStreamIndex === null
 * || media.video.length === 0` -> `{ verdict: 'direct-play', reasons: [] }`)
 * — literally "was copy", not "was transcode" — so a burn-in-forcing
 * subtitle on an otherwise video-less (music) file DOES get this reason
 * appended by strict rule text, even though `src/plan.ts`'s `video.action`
 * assembly (architecture requirement 3) correctly stays `'none'` (there is
 * no video stream to transcode). The reason's presence and `video.action`'s
 * value therefore genuinely disagree on this one edge (a diagnostic claim
 * that repeating a transcode is needed, on a plan that has no video track to
 * transcode) — this module does NOT special-case "no video stream" to
 * suppress the reason, since the spec draws no such exception and Stage E
 * has no principled way to decide it belongs to a "video" concept it cannot
 * see (mirrors `stages/audio.ts`'s documented gapless-degraded surfaced
 * question in spirit). Matrix case 320 and test/stages/subtitle.spec.ts pin
 * the literal behavior AND its `video.action === 'none'` counterpart
 * explicitly, so the disagreement is visible, not accidental.
 */
import type {
  DeviceProfile,
  MediaInfo,
  ServerPolicy,
  SubtitleCodec,
  SubtitleStrategy,
  SubtitleStream,
} from "../types.js";
import type { PlanReason, PlanReasonCode } from "../reasons.js";
import type { StageResult, StageVerdict } from "./types.js";

function reason(code: PlanReasonCode, streamIndex: number, detail?: string): PlanReason {
  const r: PlanReason = { code, streamIndex };
  if (detail !== undefined) r.detail = detail;
  return r;
}

/** §2.1 kind partition: TEXT members only — everything else (including
 *  `unknown`) is handled by the IMAGE-or-unknown path below. */
const TEXT_CODECS: readonly SubtitleCodec[] = ["subrip", "ass", "webvtt", "mov_text"];

function isTextCodec(codec: SubtitleCodec): boolean {
  return (TEXT_CODECS as readonly string[]).includes(codec);
}

/**
 * Appends `video-transcode-for-subtitle-burn-in` (carrying the SUBTITLE
 * stream's own index — binding interpretation constraint 7: "it names the
 * cause") after `reasons`'s existing strategy-blocking entry, IFF Stage B's
 * own verdict was not already `'transcode'` (constraint 6). Shared by every
 * burn-in-resolving branch below so the B-verdict check is written once.
 */
function appendVideoTranscodeReasonIfNeeded(
  reasons: PlanReason[],
  streamIndex: number,
  videoVerdict: StageVerdict,
): void {
  if (videoVerdict !== "transcode") {
    reasons.push(reason("video-transcode-for-subtitle-burn-in", streamIndex));
  }
}

export interface SubtitleStageOutput {
  result: StageResult;
  strategy: SubtitleStrategy;
  streamIndex?: number;
}

function vacuousNone(): SubtitleStageOutput {
  return { result: { verdict: "direct-play", reasons: [] }, strategy: "none" };
}

function burnIn(streamIndex: number, strategyReason: PlanReason, videoVerdict: StageVerdict): SubtitleStageOutput {
  const reasons: PlanReason[] = [strategyReason];
  appendVideoTranscodeReasonIfNeeded(reasons, streamIndex, videoVerdict);
  return { result: { verdict: "transcode", reasons }, strategy: "burn-in", streamIndex };
}

function embed(streamIndex: number): SubtitleStageOutput {
  return { result: { verdict: "direct-play", reasons: [] }, strategy: "embed", streamIndex };
}

/**
 * TEXT codec tree (docs/PLAYBACK.md §3 Stage E, binding interpretation
 * constraint 3). Cascade order is literal:
 *   (a) device.subtitles.hlsVtt && policy.preferredTextSubMode==='hls-vtt'
 *       -> 'hls-vtt', EXCEPT ass + policy.preserveAssStyling -> 'burn-in'
 *       with subtitle-burn-in-for-styling (ass alone, not preserving,
 *       carries the informational subtitle-styling-lost instead).
 *   (b) else device.subtitles.renderText includes the codec AND the
 *       container is direct-playable -> 'embed'. Per constraint 3's literal
 *       note: this fires even when policy.preferredTextSubMode==='burn-in'
 *       — the cascade only asks "did (a) fire", never "what does the policy
 *       prefer" a second time.
 *   (c) else -> 'burn-in' with subtitle-format-requires-burn-in.
 */
function evaluateTextSubtitle(
  stream: SubtitleStream,
  device: DeviceProfile,
  policy: ServerPolicy,
  containerDirectPlayable: boolean,
  videoVerdict: StageVerdict,
): SubtitleStageOutput {
  const wantsHlsVtt = device.subtitles.hlsVtt && policy.preferredTextSubMode === "hls-vtt";

  if (wantsHlsVtt) {
    if (stream.codec === "ass" && policy.preserveAssStyling) {
      return burnIn(stream.index, reason("subtitle-burn-in-for-styling", stream.index), videoVerdict);
    }
    const reasons: PlanReason[] = [];
    if (stream.codec === "ass") {
      reasons.push(reason("subtitle-styling-lost", stream.index));
    }
    return { result: { verdict: "direct-play", reasons }, strategy: "hls-vtt", streamIndex: stream.index };
  }

  if (device.subtitles.renderText.includes(stream.codec) && containerDirectPlayable) {
    return embed(stream.index);
  }

  return burnIn(
    stream.index,
    reason("subtitle-format-requires-burn-in", stream.index, `codec=${stream.codec}`),
    videoVerdict,
  );
}

/**
 * IMAGE codec tree (`pgs`/`vobsub`/`dvbsub` — genuine IMAGE members only;
 * `unknown` is intercepted before this function is ever called, per the
 * module header's SPEC INTERPRETATION). docs/PLAYBACK.md §3:
 *   device.subtitles.renderImage && container playable -> 'embed'
 *   else -> 'burn-in' with subtitle-format-requires-burn-in.
 */
function evaluateImageSubtitle(
  stream: SubtitleStream,
  device: DeviceProfile,
  containerDirectPlayable: boolean,
  videoVerdict: StageVerdict,
): SubtitleStageOutput {
  if (device.subtitles.renderImage && containerDirectPlayable) {
    return embed(stream.index);
  }
  return burnIn(
    stream.index,
    reason("subtitle-format-requires-burn-in", stream.index, `codec=${stream.codec}`),
    videoVerdict,
  );
}

/**
 * Stage E (docs/PLAYBACK.md §3). Evaluates only the SELECTED subtitle stream;
 * see this module's header for the full cascade, the `unknown` override, the
 * `videoVerdict` (Stage B verdict, not aggregated `video.action`) gating for
 * `video-transcode-for-subtitle-burn-in`, and the documented surfaced
 * no-video-stream artifact.
 *
 * External subtitles (`isExternal`/`externalPath`, docs/PLAYBACK.md §10's
 * external-srt dimension, binding interpretation constraint 8): deliberately
 * NOT consulted anywhere in this function — the tree treats a sidecar
 * exactly like an embedded stream of the same `codec` (an external `.srt` IS
 * `codec: 'subrip'`, ordinary TEXT). Delivery/ingestion of the sidecar file
 * itself is session-layer (STATE.md P3.9(e)); this stage only ever picks a
 * strategy from the codec + device + policy + container facts.
 */
export function evaluateSubtitle(
  media: MediaInfo,
  device: DeviceProfile,
  policy: ServerPolicy,
  subtitleStreamIndex: number | null,
  containerDirectPlayable: boolean,
  videoVerdict: StageVerdict,
): SubtitleStageOutput {
  if (subtitleStreamIndex === null || media.subtitle.length === 0) {
    return vacuousNone();
  }

  const stream = media.subtitle.find((s) => s.index === subtitleStreamIndex);
  if (!stream) {
    // Defensive: a selection index that doesn't resolve to any stream is
    // structurally invalid input (matrix-meta.spec.ts's structural-sanity
    // check forbids it for every matrix case, and the property-test
    // generators never produce it), but `plan()` must stay TOTAL
    // (docs/PLAYBACK.md §10 property 3) — treat as "no subtitle work", the
    // same vacuous pass as a null selection (mirrors stages/video.ts,
    // stages/hdr.ts, and stages/audio.ts exactly).
    return vacuousNone();
  }

  if (stream.codec === "unknown") {
    return burnIn(
      stream.index,
      reason("subtitle-codec-unknown", stream.index, `codec=unknown`),
      videoVerdict,
    );
  }

  if (isTextCodec(stream.codec)) {
    return evaluateTextSubtitle(stream, device, policy, containerDirectPlayable, videoVerdict);
  }

  return evaluateImageSubtitle(stream, device, containerDirectPlayable, videoVerdict);
}
