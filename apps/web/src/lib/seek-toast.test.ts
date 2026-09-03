// SPDX-License-Identifier: AGPL-3.0-only

// SPF-7 Phase B: pure formatters for the two hard-seek failure toasts —
// pinned exactly so a copy change is a deliberate edit here, not an
// accidental drift discovered only by reading VideoPlayer.test.tsx's
// string literals.

import { describe, expect, it } from "vitest";
import { formatSeekFailedToast, formatSeekTimedOutToast, SEEK_LANDING_TIMEOUT_CODE, SEEK_REQUEST_FAILED_CODE } from "./seek-toast.js";

describe("formatSeekTimedOutToast", () => {
  it("names the code and the exact copy the design pinned", () => {
    expect(formatSeekTimedOutToast()).toBe(
      "Seek timed out (seek-landing-timeout) — the transcoder did not restart in time. Try seeking again.",
    );
  });

  it("the string literally contains its own exported code constant", () => {
    expect(formatSeekTimedOutToast()).toContain(SEEK_LANDING_TIMEOUT_CODE);
  });
});

describe("formatSeekFailedToast", () => {
  it("names the code and a known HTTP status", () => {
    expect(formatSeekFailedToast(503)).toBe("Seek failed (seek-request-failed · HTTP 503) — check the connection and try again.");
  });

  it("a null status (network-layer rejection, no response at all) renders an honest '?' rather than fabricating one", () => {
    expect(formatSeekFailedToast(null)).toBe("Seek failed (seek-request-failed · HTTP ?) — check the connection and try again.");
  });

  it("the string literally contains its own exported code constant", () => {
    expect(formatSeekFailedToast(429)).toContain(SEEK_REQUEST_FAILED_CODE);
  });
});
