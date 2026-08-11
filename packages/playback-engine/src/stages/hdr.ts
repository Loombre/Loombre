// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stage C — HDR (docs/PLAYBACK.md §3, quoted verbatim):
 *
 *   "Stage C — HDR (only when B verdict is copy or transcode-with-copy-
 *   possible). Evaluated on source `hdr`:
 *   - `dv` profile 5 (no compatible base): device.dolbyVision → copy; else
 *     tone-map REQUIRED, reason `dv-profile5-requires-tonemap`.
 *   - `dv` profile 7/8: device.dolbyVision → copy; else if dvBlCompatId
 *     marks an HDR10-compatible BL and device.hdr10 → copy base layer with
 *     reason `dv-stripped-to-hdr10` (metadata strip in arg builder, no
 *     re-encode); else tone-map required, `hdr-tone-map-required`.
 *   - `hdr10`/`hlg`: device supports matching flag → copy; else tone-map
 *     required, `hdr-tone-map-required`.
 *   Tone-map required → transcode. Method chosen in Stage G; if Stage G
 *   yields no hardware method and `allowToneMapCpu` resolves to never →
 *   decision = `unplayable-as-requested`? No: the engine NEVER emits
 *   unplayable; it emits transcode with `ladder: []` and reason
 *   `tone-map-refused-by-policy`, and the session layer surfaces the
 *   failure. This keeps the output contract total."
 *
 * ---------------------------------------------------------------------------
 * SPEC INTERPRETATION #1 (binding, orchestrator-locked, Phase 3 Step 2c) —
 * "only when B verdict is copy or transcode-with-copy-possible" is read as:
 * Stage C ALWAYS evaluates whenever a video stream is selected, full stop.
 * The parenthetical is NOT a gate on running this stage at all — an HDR
 * source being re-encoded for an entirely different (codec/profile/
 * interlace/etc) reason still needs its HDR handled for an SDR-only or
 * flag-mismatched target device; skipping Stage C just because Stage B
 * already forced a transcode would silently drop the tone-map requirement
 * from the reason list and from `video.toneMap`'s eventual Stage G input.
 * The HDR check is therefore orthogonal to Stage B's own verdict — this is
 * a CANDIDATE docs/PLAYBACK.md clarification PR, not a silent divergence:
 * flagged here, in matrix/README.md-style case `why:` comments (cases
 * 186/187), and in the Step 2c completion report. The only real gate this
 * stage honors is its OWN vacuous-pass condition below (no video selected /
 * `hdr === 'none'`), mirroring Stage B's (`stages/video.ts`) scoping.
 * ---------------------------------------------------------------------------
 *
 * SPEC INTERPRETATION #2 (binding interpretation constraint 2) — dvProfile
 * branch selection: exactly 7 or 8 uses the profile-7/8 branch; exactly 5
 * uses the profile-5 branch; `null` or any OTHER numeric value (e.g. a
 * probe returning 6, or a corrupt/future DV profile the probe hasn't been
 * taught yet) is treated CONSERVATIVELY as the profile-5 branch — "no
 * compatible base proven" is the safe assumption when the profile value
 * itself is unrecognized, since assuming a stripped-base-layer exists
 * without evidence could silently serve an unplayable stream. The fired
 * `dv-profile5-requires-tonemap` reason's `detail` names the actual
 * (unexpected) profile value in this fallback case, so admin/diagnostic UI
 * never has to guess why the "profile 5" reason fired for a profile-6 file.
 *
 * `dvBlCompatId !== null` is read as "marks an HDR10-compatible BL" per
 * binding interpretation constraint 2 (matching §2.1's own field comment —
 * "8.1 HDR10-compatible base layer detection" — and matrix seed case 010's
 * fixture, which sets `dvBlCompatId: 1` specifically to trigger the strip
 * branch). No allowlist of "which compat ids count" exists in the spec or
 * the seed fixture, so any non-null value marks it.
 *
 * ---------------------------------------------------------------------------
 * SPEC INTERPRETATION #3 (binding interpretation constraint 3) —
 * `dv-stripped-to-hdr10` fires ONLY when Stage A required container
 * repackaging (`containerDirectPlayable === false`, passed in by
 * `src/plan.ts` from Stage A's own verdict — see that module's header for
 * why the stage stays pure while still knowing this fact). Rationale
 * (quoted from the binding instructions): "the strip physically happens in
 * the arg builder during repackage; a direct-play plan serves the original
 * file untouched, an HDR10-capable device plays a compat-BL fine, and
 * claiming a strip happened would be false." When the container IS
 * direct-playable, this branch is a SILENT copy — same severity, zero
 * reasons — exactly like the ordinary hdr10/hlg matching-flag copy branch.
 * Either way (strip fires or not), the DV base layer itself is never
 * re-encoded, so this branch's `StageResult.verdict` is always
 * `'direct-play'` (no escalation contributed by Stage C itself) — only the
 * REASON differs.
 * ---------------------------------------------------------------------------
 *
 * Tone-map REFUSAL — MOVED OUT of this stage (Phase 3 step 7b fix F2,
 * orchestrator-locked; supersedes Step 2c's binding interpretation
 * constraint 4): this stage now ONLY determines that a tone-map is
 * REQUIRED (the branch reasons above, unchanged). Whether the requirement
 * can actually be SATISFIED — and therefore whether the plan is REFUSED
 * with `tone-map-refused-by-policy` — is decided at ROUTE level in
 * `src/plan.ts`'s Stage G assembly block, from `routeHardware`'s
 * (`stages/hardware.ts`) full §8.3 resolution: rules (i)/(ii) with
 * per-candidate method fall-through, then the software route's
 * `allowToneMapCpu` policy check. The Step 2c implementation approximated
 * §3's "if Stage G yields no hardware method" seam with a CAPS-GLOBAL
 * check here ("does ANY caps.backends entry have a non-empty toneMap
 * array") because P3.9(b) required the refused case to land WITH Stage C,
 * before Stage G existed; the step-7a audit (matrix cases 447/448) proved
 * that approximation wrong — a toneMap-bearing backend that cannot serve
 * the route (wrong encode coverage, or a method surface its own §8.3
 * preference row never names) left the plan UNREFUSED with no tone-map
 * filter at all. This stage consequently no longer reads `policy` or
 * `caps` — it is a pure function of media/device/selection facts only.
 *
 * Scope (mirrors Stage B's documented scoping in `stages/video.ts`): this
 * stage evaluates ONLY the SELECTED video stream (`videoStreamIndex`). A
 * null selection, a media with no video streams at all, or a selection
 * index that doesn't resolve to any stream (defensive — plan() must stay
 * TOTAL, docs/PLAYBACK.md §10 property 3) is a VACUOUS PASS: verdict
 * `'direct-play'`, zero reasons. Likewise `stream.hdr === 'none'` is a
 * vacuous pass — this is the "explicit none" branch matrix case
 * 198/199/200 exist specifically to pin (an incorrect implementation that
 * treated 'none' as "doesn't match any HDR flag" would wrongly fire
 * `hdr-tone-map-required` for every plain-SDR source; that bug is exactly
 * what those cases catch).
 */
import type { DeviceProfile, MediaInfo } from "../types.js";
import type { PlanReason, PlanReasonCode } from "../reasons.js";
import { dvHasEnhancementLayer, dvStripApplies } from "../dv.js";
import type { StageResult } from "./types.js";

function reason(code: PlanReasonCode, streamIndex: number, detail?: string): PlanReason {
  const r: PlanReason = { code, streamIndex };
  if (detail !== undefined) r.detail = detail;
  return r;
}

/**
 * Stage C (docs/PLAYBACK.md §3). Evaluates only the SELECTED video stream;
 * see this module's header for the full branch table and the binding spec
 * interpretations. Tone-map REFUSAL is NOT this stage's concern (step 7b
 * fix F2 — see the header's "Tone-map REFUSAL — MOVED OUT" section): it
 * only ever reports that a tone-map is REQUIRED.
 *
 * `containerDirectPlayable` (binding interpretation constraint 3): whether
 * Stage A's own verdict was `'direct-play'` (container membership only —
 * `src/plan.ts` passes `stageA.verdict === 'direct-play'`), threaded in as
 * a plain boolean so this stage stays a pure function of its own inputs
 * without importing `stages/container.ts` or re-deriving container
 * membership itself.
 */
export function evaluateHdr(
  media: MediaInfo,
  device: DeviceProfile,
  videoStreamIndex: number | null,
  containerDirectPlayable: boolean,
): StageResult {
  if (videoStreamIndex === null || media.video.length === 0) {
    return { verdict: "direct-play", reasons: [] };
  }

  const stream = media.video.find((v) => v.index === videoStreamIndex);
  if (!stream) {
    // Defensive vacuous pass — see stages/video.ts's identical note; a
    // selection index that doesn't resolve to any stream is structurally
    // invalid input that matrix-meta.spec.ts's structural-sanity check and
    // the property generators never produce, but plan() must stay TOTAL.
    return { verdict: "direct-play", reasons: [] };
  }

  if (stream.hdr === "none") {
    return { verdict: "direct-play", reasons: [] };
  }

  const reasons: PlanReason[] = [];

  if (stream.hdr === "dv") {
    const isProfile7or8 = stream.dvProfile === 7 || stream.dvProfile === 8;

    if (isProfile7or8) {
      if (device.hdr.dolbyVision) {
        // Silent copy — device natively plays Dolby Vision.
        return { verdict: "direct-play", reasons: [] };
      }

      // dvStripApplies() is the SINGLE definition of this condition,
      // shared verbatim with args/builder.ts (src/dv.ts) — the reason and
      // the ffmpeg flags that make it true can no longer drift apart,
      // which is exactly how `dv-stripped-to-hdr10` came to describe a
      // strip nothing performed (LD-3).
      const hasCompatibleBaseLayer = dvStripApplies(stream, device);
      if (hasCompatibleBaseLayer) {
        // Binding interpretation constraint 3: the strip only actually
        // HAPPENS (and is only truthfully reported) when Stage A required
        // container repackaging. A direct-play plan serves the source file
        // untouched — the HDR10-capable device already plays the
        // compatible base layer fine without any arg-builder intervention,
        // so reporting a strip there would be false.
        if (!containerDirectPlayable) {
          // LD-15: a dual-layer profile-7 source loses its ENHANCEMENT
          // LAYER as well as its RPU (the EL is meaningless without the
          // RPU that drives it). That is a materially different outcome
          // for the viewer than a single-layer profile-8.1 strip, so it is
          // reported — in `detail`, not as a new reason code: the
          // contract's PlanReasonCode is a closed enum whose additions are
          // contract PRs (docs/PLAYBACK.md §4), and `detail` is already
          // free-form and already carries the profile.
          const elDropped = dvHasEnhancementLayer(stream);
          reasons.push(
            reason(
              "dv-stripped-to-hdr10",
              stream.index,
              `dvProfile=${stream.dvProfile} blCompatId=${stream.dvBlCompatId} elDropped=${elDropped}`,
            ),
          );
        }
        // Either way: no re-encode, so Stage C's own verdict never
        // escalates past 'direct-play' for this branch.
        return { verdict: "direct-play", reasons };
      }

      // No compatible base layer proven (dvBlCompatId null, OR the device
      // lacks hdr10 support to consume it even if marked) -> tone-map.
      reasons.push(
        reason(
          "hdr-tone-map-required",
          stream.index,
          `dvProfile=${stream.dvProfile} blCompatId=${stream.dvBlCompatId ?? "null"} device.hdr10=${device.hdr.hdr10}`,
        ),
      );
      return { verdict: "transcode", reasons };
    }

    // Profile 5, OR null/any other unrecognized profile value (binding
    // interpretation constraint 2: conservative fallback — "no compatible
    // base proven").
    if (device.hdr.dolbyVision) {
      return { verdict: "direct-play", reasons: [] };
    }
    const isCanonicalProfile5 = stream.dvProfile === 5;
    reasons.push(
      reason(
        "dv-profile5-requires-tonemap",
        stream.index,
        isCanonicalProfile5
          ? "dvProfile=5 device.dolbyVision=false"
          : `dvProfile=${stream.dvProfile ?? "null"} device.dolbyVision=false (unrecognized profile, treated conservatively as profile 5 — no compatible base proven)`,
      ),
    );
    return { verdict: "transcode", reasons };
  }

  // hdr10 / hlg: device supports the matching flag -> silent copy; else
  // tone-map required.
  const deviceSupportsFlag = stream.hdr === "hdr10" ? device.hdr.hdr10 : device.hdr.hlg;
  if (deviceSupportsFlag) {
    return { verdict: "direct-play", reasons: [] };
  }

  reasons.push(
    reason("hdr-tone-map-required", stream.index, `hdr=${stream.hdr} device.${stream.hdr}=false`),
  );
  return { verdict: "transcode", reasons };
}
