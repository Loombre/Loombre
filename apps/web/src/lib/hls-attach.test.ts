// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/hls-attach.test.ts
//
// The full truth table from this module's own header comment, plus the
// canPlayType->boolean coercion it's built on.

import { describe, expect, it } from "vitest";
import { decideAttachStrategy, isMseAvailable, isNativeHlsSupported } from "./hls-attach.js";

describe("decideAttachStrategy (MSE-first — step 7 owner-smoke finding)", () => {
  it("direct-play when the session doesn't use HLS at all, regardless of anything else", () => {
    expect(decideAttachStrategy(false, false, false)).toBe("direct-play");
    expect(decideAttachStrategy(false, true, true)).toBe("direct-play");
  });

  it("hlsjs whenever MSE is available — EVEN when canPlayType claims native HLS (Chrome-on-macOS answers 'maybe' with no native HLS behind it)", () => {
    expect(decideAttachStrategy(true, true, true)).toBe("hlsjs");
    expect(decideAttachStrategy(true, true, false)).toBe("hlsjs");
  });

  it("native-hls only in the no-MSE + claims-native environment (iOS Safari)", () => {
    expect(decideAttachStrategy(true, false, true)).toBe("native-hls");
  });

  it("hlsjs as the last-ditch when neither MSE nor native support exists", () => {
    expect(decideAttachStrategy(true, false, false)).toBe("hlsjs");
  });
});

describe("isMseAvailable", () => {
  it("true when window.MediaSource exists, false otherwise", () => {
    expect(isMseAvailable({ MediaSource: function () {} })).toBe(true);
    expect(isMseAvailable({})).toBe(false);
  });
});

describe("isNativeHlsSupported", () => {
  it("treats '' (canPlayType's negative answer) as unsupported", () => {
    expect(isNativeHlsSupported("")).toBe(false);
  });

  it("treats 'maybe' and 'probably' as supported", () => {
    expect(isNativeHlsSupported("maybe")).toBe(true);
    expect(isNativeHlsSupported("probably")).toBe(true);
  });
});
