// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared per-stage result contract — docs/PLAYBACK.md §3 preamble, quoted
 * verbatim:
 *
 *   "Stage order is normative. Each stage returns `{verdict, reasons[]}` and
 *   the final decision is the max severity across stages:
 *   `direct-play < direct-stream < transcode` (`remux` only in download
 *   mode)."
 *
 * Every stage module returns this shape — `stages/container.ts` (Stage A,
 * this step) today; `stages/video.ts` (B), `stages/hdr.ts` (C),
 * `stages/audio.ts` (D), `stages/subtitle.ts` (E), `stages/ladder.ts` (F),
 * `stages/hardware.ts` (G) in later Phase 3 steps, per docs/PLAYBACK.md §1's
 * module layout. `verdict` is the MINIMUM decision severity the stage's own
 * finding requires; `src/plan.ts`'s final assembly takes the max verdict
 * severity across every stage that ran (the "max severity across stages"
 * sentence above) to get the overall `PlaybackPlan.decision` candidate,
 * before the mode==='download' + container-only-change remux override.
 *
 * `'remux'` is deliberately NOT a `StageVerdict` member: no single stage
 * decides remux — it is a final-assembly-only override (§3 Final assembly:
 * "mode==='download' and container-only change → remux") applied once,
 * after the max-severity aggregation. Stages only ever speak in the three
 * severities that actually compose via max().
 */
import type { PlanReason } from "../reasons.js";

export type StageVerdict = "direct-play" | "direct-stream" | "transcode";

export interface StageResult {
  verdict: StageVerdict;
  reasons: PlanReason[];
}

/** Numeric severity for max() aggregation — direct-play < direct-stream <
 *  transcode, exactly the §3 preamble's ordering. */
export const STAGE_SEVERITY: Record<StageVerdict, number> = {
  "direct-play": 0,
  "direct-stream": 1,
  transcode: 2,
};

const SEVERITY_TO_VERDICT: StageVerdict[] = ["direct-play", "direct-stream", "transcode"];

/** Numeric severity (0/1/2) -> its StageVerdict name. Throws on an
 *  out-of-range severity — a defensive check, never expected to fire since
 *  every caller derives severity from STAGE_SEVERITY's own values. */
export function severityToVerdict(severity: number): StageVerdict {
  const verdict = SEVERITY_TO_VERDICT[severity];
  if (verdict === undefined) {
    throw new Error(`severityToVerdict: ${severity} is not a valid StageVerdict severity (0-2)`);
  }
  return verdict;
}
