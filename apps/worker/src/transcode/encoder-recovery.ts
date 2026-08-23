// SPDX-License-Identifier: AGPL-3.0-only
/**
 * WHAT TO DO ABOUT A DEAD HARDWARE ENCODE SESSION (QA finding
 * browser-player-F2) — the pure policy half; exit-classify.ts is the
 * pure DETECTION half, and runner.ts's poll loop is the only thing that
 * has any I/O.
 *
 * THE LADDER, in order, and it only ever goes down:
 *
 *   1. A bounded number of FRESH-SESSION retries on the same hardware
 *      encoder. A VideoToolbox session death is intermittent by nature
 *      (the finding's own evidence: two later sessions on the same 4K file
 *      ran 18 minutes clean), and a respawn IS a fresh compression
 *      session, since the session lives inside the ffmpeg process this
 *      runtime replaces. Hardware is also the only way a 4K tone-map fits
 *      the Tier-0 CPU budget, so it is worth insisting on for a moment.
 *   2. SOFTWARE. If the hardware encoder keeps dying, the same rung
 *      encodes with libx264/libx265/libsvtav1 — slower, and on a big
 *      source possibly slower than realtime, but a degraded watch beats a
 *      dead one, and the segment-ahead throttle already tolerates an
 *      encoder that cannot race ahead.
 *   3. TERMINAL, with `transcode-encoder-malfunction` rather than the
 *      generic `transcode-failed`, so the client can say something true
 *      and an operator can tell machine health from a broken plan.
 *
 * WHY BOUNDED AT ALL. An unbounded retry on a repeating crash is the
 * seek-restart livelock in another costume (runner.ts's de-dup block has
 * the full story): spawn + input open + encoder init + a first GOP is the
 * most expensive thing this runtime does, and repeating it forever burns
 * exactly the Tier-0 CPU the admission cap exists to protect while
 * producing nothing. The budget below is a fixed per-SESSION count — not a
 * rate, not a window — so the worst case is arithmetic: at most
 * `MAX_ENCODER_MALFUNCTION_RETRIES + 1` extra spawns for the life of a
 * session, whatever the encoder does.
 *
 * (A session that survives a malfunction, plays on for an hour and then
 * hits an unrelated second one spends budget it "earned back" under a
 * rate-based policy. That is a deliberate simplification: a fixed count
 * needs no clock, which is what keeps this module pure and its whole
 * decision table enumerable in a unit test. If real-world sessions ever
 * exhaust the budget on genuinely independent events, the fix is to reset
 * `hardwareRetriesUsed` after N minutes of clean output — a change to this
 * one function, with the clock passed in as an argument.)
 */
import type { ToneMapMethod } from "@loombre/playback-engine";
import type { StoredPlan } from "./plan-shape.js";

/** Fresh-hardware-session attempts before the software fallback. Two, not
 *  one: the observed failure is intermittent, and not zero, because a
 *  4K HDR tone-map in software is a very different machine load. */
export const MAX_ENCODER_MALFUNCTION_RETRIES = 2;

/** Per-session recovery bookkeeping. Owned by runner.ts's
 *  `runTranscodeSession` closure — one instance per session, never shared,
 *  never persisted (a worker restart re-admits the session fresh, and a
 *  fresh process is exactly the state this bookkeeping describes). */
export interface EncoderRecoveryState {
  /** Fresh-session retries spent on the hardware encoder so far. */
  hardwareRetriesUsed: number;
  /** True once this session has been switched to the software encoder. */
  softwareFallbackActive: boolean;
}

export function newEncoderRecoveryState(): EncoderRecoveryState {
  return { hardwareRetriesUsed: 0, softwareFallbackActive: false };
}

export type EncoderRecoveryAction =
  /** Respawn on the same encoder — `attempt` is this retry's 1-based
   *  ordinal, which the caller writes back to `hardwareRetriesUsed`. */
  | { kind: "retry-hardware"; attempt: number }
  /** Respawn with `softwareFallbackPlan()`'s shape. */
  | { kind: "fall-back-to-software" }
  /** Nothing left to try — fail the session. */
  | { kind: "give-up" };

/**
 * The whole decision, as a total function of the state plus one fact about
 * the session (is there a hardware encoder to fall back FROM). Pure — no
 * clock, no database, no process.
 */
export function planEncoderRecovery(
  state: EncoderRecoveryState,
  options: { softwareFallbackAvailable: boolean; maxHardwareRetries?: number },
): EncoderRecoveryAction {
  const maxHardwareRetries = options.maxHardwareRetries ?? MAX_ENCODER_MALFUNCTION_RETRIES;
  if (!state.softwareFallbackActive && state.hardwareRetriesUsed < maxHardwareRetries) {
    return { kind: "retry-hardware", attempt: state.hardwareRetriesUsed + 1 };
  }
  if (!state.softwareFallbackActive && options.softwareFallbackAvailable) {
    return { kind: "fall-back-to-software" };
  }
  // Already on software (a software encoder cannot suffer a VideoToolbox
  // session death, so getting here means something stranger is wrong), or
  // there was never a hardware encoder in this plan to step down from.
  return { kind: "give-up" };
}

/**
 * Is there a hardware encoder in this plan to fall back FROM? Only a
 * transcoding video action has an encoder at all — a `copy`/`none` action
 * never opens a compression session, so a malfunction OSStatus alongside
 * one is not something a different encoder would fix.
 */
export function softwareFallbackAvailable(plan: StoredPlan): boolean {
  return plan.video.action === "transcode" && plan.video.encoder !== undefined && plan.video.encoder !== "software";
}

/**
 * The SAME session, re-expressed for the software encoder. Returns a new
 * StoredPlan; the caller hands it to `rebuildSeekArgs`, which runs the
 * untouched, pure `@loombre/playback-engine` builder over it. The engine
 * is not consulted about the fallback and is not modified by it — the
 * fallback IS a different plan shape, which is the only lever a plan
 * consumer is allowed to pull (CLAUDE.md invariant 2).
 *
 * TWO fields move, and they move TOGETHER:
 *
 *   - `video.encoder` -> `'software'`, which is what makes the builder
 *     resolve `libx265`/`libx264`/`libsvtav1` from the rung's own codec
 *     (`VIDEO_ENCODER_NAMES.software`) and emit no `-hwaccel` at all.
 *   - `video.toneMap` -> `'cpu-zscale'` whenever it named a HARDWARE
 *     method. This is not tidiness, it is correctness: the builder pairs a
 *     hardware tone-map filter with a hardware decode surface, and a
 *     `scale_vt`/`tonemap_cuda`/`tonemap_opencl`/`libplacebo` filter
 *     handed software frames fails at filter-graph init. Software frames
 *     take the documented `zscale -> tonemap -> zscale` chain.
 *
 * Everything else — container, ladder, rung, audio, subtitle strategy,
 * track selection — is carried through untouched: a fallback is a change
 * of ENCODER, never a re-plan. `ffmpegArgs` (the initial spawn's argv) is
 * carried through too and is deliberately NOT rewritten here: it is only
 * ever used for run 0, and every recovery restart goes through
 * `restartAt` -> `rebuildSeekArgs`, which regenerates argv from this
 * shape.
 *
 * Non-mutating — the stored plan on the row is a fact about what the
 * session was admitted as, not scratch space.
 */
export function softwareFallbackPlan(plan: StoredPlan): StoredPlan {
  if (!softwareFallbackAvailable(plan)) return plan;
  const toneMap: ToneMapMethod | undefined =
    plan.video.toneMap !== undefined && plan.video.toneMap !== "cpu-zscale" ? "cpu-zscale" : plan.video.toneMap;
  return {
    ...plan,
    video: {
      ...plan.video,
      encoder: "software",
      ...(toneMap !== undefined ? { toneMap } : {}),
    },
  };
}
