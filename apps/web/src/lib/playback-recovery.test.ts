// SPDX-License-Identifier: AGPL-3.0-only
// browser-player-F1: the shared bounded-recovery policy + session-failure
// reason synthesis — see playback-recovery.ts's header. The component-level
// halves (which attach effect calls what, and when) live in
// components/player/VideoPlayer.test.tsx's "hls.js fatal-error recovery"
// and native-branch recovery describes.

import { describe, expect, it } from "vitest";
import {
  decideRecovery,
  describeSessionFailureCode,
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_MIN_INTERVAL_MS,
  SESSION_FAILED_CODE,
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
