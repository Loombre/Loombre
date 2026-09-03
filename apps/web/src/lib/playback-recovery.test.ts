// SPDX-License-Identifier: AGPL-3.0-only
// browser-player-F1: the shared bounded-recovery policy + session-failure
// reason synthesis — see playback-recovery.ts's header. The component-level
// halves (which attach effect calls what, and when) live in
// components/player/VideoPlayer.test.tsx's "hls.js fatal-error recovery"
// and native-branch recovery describes.

import { describe, expect, it } from "vitest";
import {
  basename,
  clientFailureReasons,
  decideRecovery,
  describeClientFailure,
  describeSessionFailureCode,
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_MIN_INTERVAL_MS,
  SESSION_ENDED_CODE,
  SESSION_FAILED_CODE,
  sessionEndedReasons,
  sessionFailureReasons,
} from "./playback-recovery.js";

describe("decideRecovery", () => {
  it("the first attempt after a fresh attach runs immediately — the 0 'never' stamp can't hold it back", () => {
    expect(decideRecovery(0, 0, 1_000_000)).toEqual({ action: "retry", delayMs: 0 });
  });

  it("an attempt inside the cooldown is DEFERRED by exactly the remainder, never dropped", () => {
    const stamp = 100_000;
    const now = stamp + 1_500;
    expect(decideRecovery(1, stamp, now)).toEqual({ action: "retry", delayMs: RECOVERY_MIN_INTERVAL_MS - 1_500 });
  });

  it("an attempt at/after the cooldown runs immediately", () => {
    const stamp = 100_000;
    expect(decideRecovery(2, stamp, stamp + RECOVERY_MIN_INTERVAL_MS)).toEqual({ action: "retry", delayMs: 0 });
    expect(decideRecovery(2, stamp, stamp + RECOVERY_MIN_INTERVAL_MS + 5_000)).toEqual({ action: "retry", delayMs: 0 });
  });

  it(`the budget is exhausted at exactly ${MAX_RECOVERY_ATTEMPTS} attempts — then fatal, regardless of elapsed time`, () => {
    expect(decideRecovery(MAX_RECOVERY_ATTEMPTS, 0, Number.MAX_SAFE_INTEGER)).toEqual({ action: "fatal" });
    expect(decideRecovery(MAX_RECOVERY_ATTEMPTS + 5, 0, Number.MAX_SAFE_INTEGER)).toEqual({ action: "fatal" });
  });
});

describe("sessionFailureReasons", () => {
  it("carries the session's errorCode verbatim (Cluster F's distinct codes must reach the screen)", () => {
    expect(sessionFailureReasons("transcode-failed")).toEqual([
      { code: "transcode-failed", streamIndex: null, detail: null },
    ]);
    expect(sessionFailureReasons("transcode-encoder-malfunction")[0]?.code).toBe("transcode-encoder-malfunction");
  });

  it("synthesizes the generic session-failed code when the server recorded none", () => {
    expect(sessionFailureReasons(null)[0]?.code).toBe(SESSION_FAILED_CODE);
    expect(sessionFailureReasons(undefined)[0]?.code).toBe(SESSION_FAILED_CODE);
  });
});

describe("describeSessionFailureCode", () => {
  it("maps the worker's two error codes to distinct blocking copy", () => {
    const failed = describeSessionFailureCode("transcode-failed");
    const malfunction = describeSessionFailureCode("transcode-encoder-malfunction");
    expect(failed?.severity).toBe("blocking");
    expect(malfunction?.severity).toBe("blocking");
    expect(failed?.title).not.toBe(malfunction?.title);
    expect(failed?.title).toContain("Transcoding failed");
    expect(malfunction?.title.toLowerCase()).toContain("encoder");
  });

  it("maps the synthesized no-errorCode code", () => {
    expect(describeSessionFailureCode(SESSION_FAILED_CODE)?.title).toBe("Playback session failed");
  });

  it("returns null for anything else, so plan reasons keep rendering through playback-reasons.ts", () => {
    expect(describeSessionFailureCode("video-codec-unsupported")).toBeNull();
    expect(describeSessionFailureCode("transcode-slots-exhausted")).toBeNull();
    expect(describeSessionFailureCode("")).toBeNull();
  });
});

// d3-a5 (verify/browser-player-F1): a session the SERVER closed mid-playback
// (eviction, the idle sweep, another device taking the slot) is not a client
// failure — goFatal used to fall through to clientPlaybackErrorReasons()
// ("Playback failed in this browser") for every non-'failed' inspect result,
// blaming the browser for a server-side session end.
describe("session-ended copy (d3-a5)", () => {
  it("synthesizes a session-ended reason DISTINCT from the session-failed one", () => {
    expect(sessionEndedReasons()).toEqual([{ code: SESSION_ENDED_CODE, streamIndex: null, detail: null }]);
    expect(SESSION_ENDED_CODE).not.toBe(SESSION_FAILED_CODE);
  });

  it("maps the session-ended code to copy that names the server's session end, never this browser", () => {
    const copy = describeSessionFailureCode(SESSION_ENDED_CODE);
    expect(copy?.severity).toBe("blocking");
    expect(copy?.title.toLowerCase()).toContain("ended");
    expect(copy?.detail.toLowerCase()).not.toContain("browser");
  });

  it("maps the idle sweeper's 'heartbeat-timeout' errorCode (the third code the system writes) to honest copy, not the raw-code fallback", () => {
    // packages/db/src/query/playback-sessions.ts's sweep finalizes idle
    // sessions with status 'failed' + errorCode 'heartbeat-timeout' — with
    // no entry here the screen rendered the raw code plus "this build's
    // reason copy map may be behind" (AQ handoff, new finding 2).
    const copy = describeSessionFailureCode("heartbeat-timeout");
    expect(copy).not.toBeNull();
    expect(copy?.severity).toBe("blocking");
    expect(copy?.title).not.toBe("heartbeat-timeout");
  });
});

// SPF-7 Phase B: sessionFailureReasons gains errorDetail — the worker's
// sanitized, path-stripped stderr-tail line — as the reason's own `detail`,
// which UnavailableScreen's code line already renders.
describe("sessionFailureReasons errorDetail (SPF-7 Phase B)", () => {
  it("threads errorDetail into the reason's detail field", () => {
    expect(sessionFailureReasons("transcode-disk-full", "no space left on device")).toEqual([
      { code: "transcode-disk-full", streamIndex: null, detail: "no space left on device" },
    ]);
  });

  it("null/undefined errorDetail (or omitting it entirely) keeps detail null, exactly as before this field existed", () => {
    expect(sessionFailureReasons("transcode-failed", null)[0]?.detail).toBeNull();
    expect(sessionFailureReasons("transcode-failed", undefined)[0]?.detail).toBeNull();
    expect(sessionFailureReasons("transcode-failed")[0]?.detail).toBeNull();
  });
});

// SPF-7 Phase B: the worker's ffmpeg failure classifier
// (packages/shared/src/ffmpeg-failure.ts) sub-codes, plus the
// admission-time eviction code — each needs its own distinct copy, not a
// shared/generic one, and the eviction copy is R6's corrected framing.
describe("SPF-7 Phase B worker sub-code copy", () => {
  const codes = [
    "transcode-input-missing",
    "transcode-input-unreadable",
    "transcode-decoder-unsupported",
    "transcode-encoder-init-failed",
    "transcode-disk-full",
    "transcode-killed",
  ];

  it("every worker sub-code has its own distinct, non-fallback copy", () => {
    const titles = new Set<string>();
    for (const code of codes) {
      const copy = describeSessionFailureCode(code);
      expect(copy, `${code} has no copy entry`).not.toBeNull();
      expect(copy?.severity).toBe("blocking");
      titles.add(copy!.title);
    }
    expect(titles.size, "every sub-code must have its own distinct title").toBe(codes.length);
  });

  it("evicted-for-admission carries the R3-corrected 'released for another viewer' framing", () => {
    const copy = describeSessionFailureCode("evicted-for-admission");
    expect(copy).not.toBeNull();
    expect(copy?.title).toBe("Session released for another viewer");
    expect(copy?.detail).toBe(
      "Your session was closed to free the server for another viewer — it had been paused or idle for a while. Press play to start again.",
    );
    expect(copy?.severity).toBe("blocking");
  });

  it("an unmapped worker code still falls through to the honest unrecognized-code fallback (negative control)", () => {
    expect(describeSessionFailureCode("transcode-not-a-real-code")).toBeNull();
  });
});

// SPF-7 Phase B: goFatal's client-side cause classification — the pure
// {code, detail} the specific client codes are built from. Component-level
// wiring (which cause each attach path constructs) lives in
// components/player/VideoPlayer.test.tsx.
describe("describeClientFailure / clientFailureReasons (SPF-7 Phase B)", () => {
  it("MediaError codes map to their own client-media-* code, with the raw code + message in the detail", () => {
    expect(describeClientFailure({ kind: "media-error", code: 3, message: "Decode error" })).toEqual({
      code: "client-media-decode-error",
      detail: "MediaError 3: Decode error",
    });
    expect(describeClientFailure({ kind: "media-error", code: 4, message: "" }).code).toBe("client-media-src-not-supported");
    expect(describeClientFailure({ kind: "media-error", code: 2, message: "net down" }).code).toBe("client-media-network-error");
    expect(describeClientFailure({ kind: "media-error", code: 1, message: "" }).code).toBe("client-media-aborted");
  });

  it("no MediaError attached at all falls back to the generic client-playback-error code, honestly", () => {
    const described = describeClientFailure({ kind: "media-error", code: null, message: "" });
    expect(described.code).toBe("client-playback-error");
  });

  it("hls.js NETWORK_ERROR names the HTTP status and the segment basename", () => {
    expect(
      describeClientFailure({ kind: "hls-network-error", details: "fragLoadError", httpStatus: 503, resource: "s000012.m4s" }),
    ).toEqual({
      code: "hls-network-error",
      detail: "fragLoadError · HTTP 503 · s000012.m4s",
    });
  });

  it("hls.js NETWORK_ERROR with no response/resource renders honest placeholders, not undefined", () => {
    expect(describeClientFailure({ kind: "hls-network-error", details: "internalException", httpStatus: null, resource: null }).detail).toBe(
      "internalException · HTTP ? · ?",
    );
  });

  it("hls.js MEDIA_ERROR names the reason when one exists, and omits it cleanly when it doesn't", () => {
    expect(describeClientFailure({ kind: "hls-media-error", details: "bufferAppendError", reason: "invalid state" }).detail).toBe(
      "bufferAppendError · invalid state",
    );
    expect(describeClientFailure({ kind: "hls-media-error", details: "bufferAppendError", reason: null }).detail).toBe("bufferAppendError");
  });

  it("any other fatal hls.js type falls to hls-fatal-error, naming type/details", () => {
    expect(describeClientFailure({ kind: "hls-fatal-error", type: "keySystemError", details: "someDetail" })).toEqual({
      code: "hls-fatal-error",
      detail: "keySystemError/someDetail",
    });
  });

  it("the stall watchdog names the position it gave up at", () => {
    expect(describeClientFailure({ kind: "playback-stalled", positionSec: 42.34 }).detail).toBe("no progress for 10 s at 42.3s");
  });

  it("retries, when given, are appended as ' · after <n> retries' — omitted entirely when undefined", () => {
    const cause: Parameters<typeof describeClientFailure>[0] = { kind: "hls-network-error", details: "fragLoadError", httpStatus: 503, resource: null };
    expect(describeClientFailure(cause).detail).not.toContain("retries");
    expect(describeClientFailure(cause, 3).detail).toBe("fragLoadError · HTTP 503 · ? · after 3 retries");
    expect(describeClientFailure(cause, 0).detail).toBe("fragLoadError · HTTP 503 · ? · after 0 retries");
  });

  it("clientFailureReasons wraps the {code, detail} pair into the PlanReason shape UnavailableScreen renders", () => {
    expect(clientFailureReasons({ kind: "media-error", code: 3, message: "boom" })).toEqual([
      { code: "client-media-decode-error", streamIndex: null, detail: "MediaError 3: boom" },
    ]);
  });
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("run0/s000012.m4s")).toBe("s000012.m4s");
  });

  it("strips a query string / hash", () => {
    expect(basename("https://host/hls/v0/s000012.m4s?token=abc")).toBe("s000012.m4s");
  });

  it("a bare filename with no separators is returned unchanged", () => {
    expect(basename("media.m3u8")).toBe("media.m3u8");
  });
});
