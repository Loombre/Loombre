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
import { CLIENT_PLAYBACK_ERROR_CODE } from "./playback-reasons.js";

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
 * d3-a5 (verify/browser-player-F1): synthesized reason code for "the server
 * ENDED this session while the client was still playing it" — eviction,
 * the idle sweep racing a wedged client, another device/tab ending it, an
 * admin DELETE. goFatal used to special-case only status 'failed', so an
 * ended session fell through to the client-blame copy ("Playback failed in
 * this browser") — a lie: the browser was fine, the server closed the
 * session out from under it. Same out-of-contract-enum precedent as
 * SESSION_FAILED_CODE above.
 */
export const SESSION_ENDED_CODE = "playback-session-ended";

/**
 * d4-a2.117: synthesized reason code for "the CREATE call itself failed
 * before any session existed" — a 5xx problem response or a network-layer
 * rejection from POST /playback/sessions. Not a plan refusal (the planner
 * never answered: 409/422/429 fold into `result.ok === false` upstream),
 * not a 404 (item-unavailable owns that), and not a client media failure
 * (the browser never touched a stream) — so neither the "refused" framing
 * nor CLIENT_PLAYBACK_ERROR_CODE's copy is honest for it. A CREATE-time
 * failure rather than a session-death code, but it lives in this file's
 * map because UnavailableScreen's first lookup (describeSessionFailureCode)
 * is the seam that renders synthesized non-plan codes, and the same
 * out-of-contract-enum precedent applies.
 */
export const SESSION_CREATE_FAILED_CODE = "playback-session-create-failed";

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
  // SPF-7 Phase B: the worker's ffmpeg failure classifier
  // (packages/shared/src/ffmpeg-failure.ts) sub-codes `transcode-failed`
  // used to fall back to unconditionally. Each of these five is a distinct
  // failure mode with its own recovery instinct; `transcode-failed` stays
  // as the classifier's own catch-all.
  "transcode-input-missing": {
    title: "The media file is missing",
    detail:
      "The server couldn't find this file where the library expects it — it may have moved or been deleted. Check the library on the server.",
    severity: "blocking",
  },
  "transcode-input-unreadable": {
    title: "The media file couldn't be read",
    detail:
      "The server found the file but couldn't read it — a permissions problem or a damaged file. Check the file and the server's read access to it.",
    severity: "blocking",
  },
  "transcode-decoder-unsupported": {
    title: "This format isn't supported by the server",
    detail: "The server's transcoder can't decode this file's video or audio format. Check the server's codec support.",
    severity: "blocking",
  },
  "transcode-encoder-init-failed": {
    title: "The server's encoder failed to start",
    detail:
      "The video encoder (hardware or software) couldn't start for this session. Retrying may work; if it keeps happening, the server machine needs attention.",
    severity: "blocking",
  },
  "transcode-disk-full": {
    title: "The server ran out of disk space",
    detail: "The server's conversion staging area is full. Free up space on the server and try again.",
    severity: "blocking",
  },
  "transcode-killed": {
    title: "The server stopped the conversion",
    detail:
      "The conversion process was killed, usually because the server ran out of memory. Retrying may work; if it keeps happening, the server may need more resources.",
    severity: "blocking",
  },
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
  // SPF-9/R3 (peer review): the admission-time reclamation path — the
  // server closed a paused/idle session to free its slot for another
  // viewer. Framed as a routine consequence of stepping away, not a
  // failure: the fix is simply to press play again.
  "evicted-for-admission": {
    title: "Session released for another viewer",
    detail: "Your session was closed to free the server for another viewer — it had been paused or idle for a while. Press play to start again.",
    severity: "blocking",
  },
  [SESSION_FAILED_CODE]: {
    title: "Playback session failed",
    detail: "The server reported this playback session as failed without a specific error code.",
    severity: "blocking",
  },
  // d3-a5: the THIRD error_code the system writes (packages/db/src/query/
  // playback-sessions.ts's idle sweep — finalizeSession with
  // errorCode 'heartbeat-timeout'). Without an entry, an idle-swept
  // session rendered the raw code plus the "copy map may be behind"
  // fallback (AQ handoff, new finding 2).
  "heartbeat-timeout": {
    title: "The session timed out",
    detail:
      "The server stopped hearing from this player and closed the session as idle. Go back and press play to start a fresh one.",
    severity: "blocking",
  },
  [SESSION_ENDED_CODE]: {
    title: "The server ended this playback session",
    detail:
      "The session was closed on the server side — another device or tab may have taken over, or the server shut it down. Go back and press play to start a fresh one.",
    severity: "blocking",
  },
  // d4-a2.117 — see SESSION_CREATE_FAILED_CODE above. The copy blames
  // neither the file nor the browser: nothing was planned and nothing was
  // streamed, so the only honest statement is that the request itself
  // didn't get through.
  [SESSION_CREATE_FAILED_CODE]: {
    title: "Couldn’t start a playback session",
    detail:
      "The server was unreachable or returned an unexpected error before playback could be planned — nothing was streamed, and nothing is wrong with this file or your browser. Check the connection and try again.",
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
 *  contract enum.
 *
 *  SPF-7 Phase B: `errorDetail` — the worker's sanitized, path-stripped
 *  stderr-tail line (packages/shared/src/ffmpeg-failure.ts, exposed
 *  additively on `PlaybackSession`) — becomes the reason's own `detail`,
 *  which UnavailableScreen.tsx's code line already renders (`reason.code ·
 *  stream N · detail`). `null`/`undefined` (no detail recorded) keeps the
 *  line exactly as before this field existed. */
export function sessionFailureReasons(errorCode: string | null | undefined, errorDetail?: string | null): PlanReason[] {
  return [{ code: errorCode ?? SESSION_FAILED_CODE, streamIndex: null, detail: errorDetail ?? null } as PlanReason];
}

/** The reasons array for a session the server ENDED (not failed) out from
 *  under a still-attached client — always exactly the one synthesized
 *  session-ended reason ('ended' rows never carry an errorCode:
 *  finalizeSession picks 'failed' whenever one exists). */
export function sessionEndedReasons(): PlanReason[] {
  return [{ code: SESSION_ENDED_CODE, streamIndex: null, detail: null } as PlanReason];
}

/** d4-a2.117: the reasons array for a create call that threw (5xx/network)
 *  — always exactly the one synthesized create-failed reason: no session
 *  exists to inspect and no server reasons were ever produced. */
export function sessionCreateFailedReasons(): PlanReason[] {
  return [{ code: SESSION_CREATE_FAILED_CODE, streamIndex: null, detail: null } as PlanReason];
}

// ── SPF-7 Phase B: client-side fatal-cause classification ──────────────────
//
// `goFatal` (VideoPlayer.tsx) used to render ONE generic code —
// `client-playback-error` (lib/playback-reasons.ts) — for every
// client-side unrecoverable failure, whichever attach mode raised it and
// whatever the browser/hls.js actually said. That dropped the hls.js
// error type/details/HTTP status, the MediaError code, and the segment
// URI on the floor. `describeClientFailure` below is the pure classifier
// that recovers them: goFatal calls it ONLY when the session inspect
// confirms the session is NOT server-failed (still active/suspended —
// see goFatal's own header), because a specific client code is honest
// only when nothing on the server side already explains the failure.
//
// Structural (not hls.js-typed) causes, same pattern as
// relocation-nudge.ts's `PlaylistReloader`: this module stays hls.js- and
// DOM-import-free so it is unit-testable without either.

/** `video.error` at the moment of an unrecoverable native media error, or
 *  the moment bounded recovery exhausted its budget while retrying one.
 *  `code: null` covers the (rare) case of an `error` event firing with no
 *  `MediaError` attached. */
export interface MediaErrorCause {
  kind: "media-error";
  code: number | null;
  message: string;
}

/** hls.js `ErrorData` for a fatal `NETWORK_ERROR` — structural mirror of
 *  the fields the detail line names (`data.details`, `data.response?.code`,
 *  `data.frag?.relurl` or `data.url`). */
export interface HlsNetworkErrorCause {
  kind: "hls-network-error";
  details: string;
  httpStatus: number | null;
  /** Basename of `data.frag?.relurl`, else `data.url`, else `null`. */
  resource: string | null;
}

/** hls.js `ErrorData` for a fatal `MEDIA_ERROR`. */
export interface HlsMediaErrorCause {
  kind: "hls-media-error";
  details: string;
  reason: string | null;
}

/** hls.js `ErrorData` for any fatal type this module has no dedicated
 *  branch for — the player's `default` switch case. */
export interface HlsOtherFatalCause {
  kind: "hls-fatal-error";
  type: string;
  details: string;
}

/** The direct-play/native-HLS attach effect's stall watchdog
 *  (`STALL_WATCHDOG_MS` = 10 s) gave up waiting for progress. */
export interface StalledCause {
  kind: "playback-stalled";
  positionSec: number;
}

export type ClientFailureCause = MediaErrorCause | HlsNetworkErrorCause | HlsMediaErrorCause | HlsOtherFatalCause | StalledCause;

export interface ClientFailureDescription {
  code: string;
  detail: string;
}

const MEDIA_ERROR_CODE_NAMES: Record<number, string> = {
  1: "client-media-aborted",
  2: "client-media-network-error",
  3: "client-media-decode-error",
  4: "client-media-src-not-supported",
};

function classify(cause: ClientFailureCause): ClientFailureDescription {
  switch (cause.kind) {
    case "media-error": {
      const name = cause.code !== null ? MEDIA_ERROR_CODE_NAMES[cause.code] : undefined;
      if (!name) return { code: CLIENT_PLAYBACK_ERROR_CODE, detail: "No MediaError was recorded on the element." };
      return { code: name, detail: `MediaError ${cause.code}: ${cause.message}` };
    }
    case "hls-network-error": {
      const status = cause.httpStatus ?? "?";
      return { code: "hls-network-error", detail: `${cause.details} · HTTP ${status} · ${cause.resource ?? "?"}` };
    }
    case "hls-media-error":
      return { code: "hls-media-error", detail: cause.reason ? `${cause.details} · ${cause.reason}` : cause.details };
    case "hls-fatal-error":
      return { code: "hls-fatal-error", detail: `${cause.type}/${cause.details}` };
    case "playback-stalled":
      return { code: "playback-stalled", detail: `no progress for 10 s at ${cause.positionSec.toFixed(1)}s` };
  }
}

/**
 * Turns a client-side fatal cause into the {code, detail} goFatal renders
 * as a synthesized `PlanReason` (see `clientFailureReasons` below).
 * `retries`, when given, is the bounded-recovery attempt count spent
 * before the budget was declared exhausted (`decideRecovery`'s `fatal`
 * verdict) — appended to the detail so the code line shows how many
 * in-place retries were tried before giving up. Omitted entirely for a
 * cause that reached goFatal WITHOUT going through recovery at all (an
 * unrecoverable MediaError, or an hls.js fatal type with no in-place
 * lever) — the code line would otherwise falsely claim retries that never
 * ran.
 */
export function describeClientFailure(cause: ClientFailureCause, retries?: number): ClientFailureDescription {
  const described = classify(cause);
  if (retries === undefined) return described;
  return { code: described.code, detail: `${described.detail} · after ${retries} retries` };
}

/** Basename of a URL/path-like string — the last `/`-delimited segment,
 *  query/hash stripped. Used to turn `data.frag.relurl` / `data.url` into
 *  the short segment name the hls-network-error detail line names. */
export function basename(pathOrUrl: string): string {
  const withoutQuery = pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl;
  const segments = withoutQuery.split("/");
  return segments[segments.length - 1] || pathOrUrl;
}

/** The reasons array UnavailableScreen renders for a client-side fatal
 *  cause — goFatal's replacement for the old, always-generic
 *  `clientPlaybackErrorReasons()` whenever the session inspect confirms
 *  the failure isn't server-side. `describeClientFailure`'s `detail`
 *  becomes the reason's `detail` (same seam `sessionFailureReasons` above
 *  uses for `errorDetail`), so UnavailableScreen's code line shows it. */
export function clientFailureReasons(cause: ClientFailureCause, retries?: number): PlanReason[] {
  const { code, detail } = describeClientFailure(cause, retries);
  return [{ code, streamIndex: null, detail } as PlanReason];
}
