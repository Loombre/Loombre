// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-recovery.ts
//
// browser-player-F1: the ONE bounded recovery policy BOTH of VideoPlayer's
// attach modes share. The direct-play/native-HLS attach effect had bounded
// recovery (task #6, 2026-08-10 opus review findings 1/2: at most
// MAX_RECOVERY_ATTEMPTS reattaches per stretch, no faster than one every
// RECOVERY_MIN_INTERVAL_MS, deferred — never dropped — inside the cooldown,
// then the fatal-unavailable path); the hls.js attach effect's ERROR
// handler retried NETWORK_ERROR fatals with `hls.startLoad()` unboundedly —
// a mid-session transcode failure (session status 'failed', playlists 404)
// spun an endless ~1/s retry loop behind an indefinite spinner with no
// failure surface at all. Both effects now ask `decideRecovery` the same
// question and route exhaustion to the same fatal destination
// (VideoPlayer's goFatal), which inspects the session server-side and
// renders UnavailableScreen with the session's errorCode when the server
// marked it failed (`sessionFailureReasons` below).
//
// Pure by design (CLAUDE.md working agreement / lane pattern:
// relocation-nudge.ts): the clock is an argument, timers stay in the
// component, so the whole policy is unit-testable without a DOM.

import type { components } from "@loombre/sdk";
import type { ReasonCopy } from "./playback-reasons.js";

type PlanReason = components["schemas"]["PlanReason"];

/** Per-attempt COOLDOWN (not a suppression window): a retry landing inside
 *  it is DEFERRED to when it expires, never dropped. */
export const RECOVERY_MIN_INTERVAL_MS = 4000;
/** Retries per "stretch"; a stretch that reaches real playback again
 *  (the element's own `playing` event) earns a fresh budget. */
export const MAX_RECOVERY_ATTEMPTS = 3;

export type RecoveryDecision =
  /** Run the retry — immediately when `delayMs` is 0, else after it. */
  | { action: "retry"; delayMs: number }
  /** Budget exhausted — no further in-place retry can be productive;
   *  route to the fatal-unavailable path. */
  | { action: "fatal" };

/**
 * The shared bounded-retry decision. `attemptsUsed` counts recovery
 * attempts already spent this stretch; `lastAttemptStampMs` is when the
 * most recent one ran (0 = never — `nowMs - 0` always clears the cooldown,
 * so the first attempt after a fresh attach is never held back by a
 * cooldown it never started).
 */
export function decideRecovery(attemptsUsed: number, lastAttemptStampMs: number, nowMs: number): RecoveryDecision {
  if (attemptsUsed >= MAX_RECOVERY_ATTEMPTS) return { action: "fatal" };
  const elapsed = nowMs - lastAttemptStampMs;
  return { action: "retry", delayMs: Math.max(0, RECOVERY_MIN_INTERVAL_MS - elapsed) };
}

/**
 * Synthesized reason code for "the server says this session FAILED but
 * recorded no errorCode" — outside the contract's closed PlanReasonCode
 * enum, following the exact precedent lib/playback-reasons.ts set with
 * TRANSCODE_SLOTS_EXHAUSTED_CODE / CLIENT_PLAYBACK_ERROR_CODE.
 */
export const SESSION_FAILED_CODE = "playback-session-failed";

/**
 * Human copy for the `playback_sessions.error_code` values the worker
 * writes when it marks a session failed (apps/worker/src/transcode/
 * exit-classify.ts — a free-form TEXT column, deliberately NOT a contract
 * enum, so this map is additive too). These are NOT PlanReasonCodes:
 * lib/playback-reasons.ts's map covers the §4 planning enum, this one
 * covers runtime session-death codes; UnavailableScreen consults this map
 * first and falls through to describeReasonCode for everything else. An
 * errorCode with no entry here renders describeReasonCode's honest
 * unrecognized-code fallback (raw code shown, "copy map may be behind").
 */
const SESSION_FAILURE_COPY: Record<string, ReasonCopy> = {
  "transcode-failed": {
    title: "Transcoding failed on the server",
    detail:
      "The server's transcoder crashed while preparing this stream. Go back and try again — if it keeps happening, the server's logs have the details.",
    severity: "blocking",
  },
  "transcode-encoder-malfunction": {
    title: "The server's video encoder is failing",
    detail:
      "The hardware video encoder kept dying and even the software fallback couldn't keep this session alive. Retrying may work; if it keeps happening, the server machine itself needs attention.",
    severity: "blocking",
  },
  [SESSION_FAILED_CODE]: {
    title: "Playback session failed",
    detail: "The server reported this playback session as failed without a specific error code.",
    severity: "blocking",
  },
};

/** UnavailableScreen's first lookup — `null` for every code that is not a
 *  known session-failure code, so plan reasons keep rendering through
 *  lib/playback-reasons.ts exactly as before. */
export function describeSessionFailureCode(code: string): ReasonCopy | null {
  return SESSION_FAILURE_COPY[code] ?? null;
}

/** The reasons array UnavailableScreen renders when the session inspect
 *  confirmed a server-side failure: the session's own errorCode, verbatim
 *  (so an unmapped future code still shows itself), or the synthesized
 *  code above when the server recorded none. The cast follows
 *  playback-reasons.ts's documented pattern for codes outside the closed
 *  contract enum. */
export function sessionFailureReasons(errorCode: string | null | undefined): PlanReason[] {
  return [{ code: errorCode ?? SESSION_FAILED_CODE, streamIndex: null, detail: null } as PlanReason];
}
