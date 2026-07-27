// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/pin-format.spec.ts

import { describe, expect, it } from "vitest";
import { PIN_LENGTH, PIN_PATTERN_SOURCE, isValidNewPin } from "./pin-format.js";

describe("isValidNewPin — the contract's RestrictedSettingsUpdate.pin / UnlockRequest.pin shape", () => {
  it("accepts exactly PIN_LENGTH digits", () => {
    expect(PIN_LENGTH).toBe(4);
    expect(isValidNewPin("1234")).toBe(true);
    expect(isValidNewPin("0000")).toBe(true);
    expect(isValidNewPin("0912")).toBe(true);
  });

  it("rejects a PIN longer than PIN_LENGTH — the lockout case (unlock UI can only enter 4)", () => {
    expect(isValidNewPin("12345")).toBe(false);
    expect(isValidNewPin("000000")).toBe(false);
  });

  it("rejects a PIN shorter than PIN_LENGTH", () => {
    expect(isValidNewPin("")).toBe(false);
    expect(isValidNewPin("1")).toBe(false);
    expect(isValidNewPin("123")).toBe(false);
  });

  it("rejects non-digit characters, including whitespace and unicode digits", () => {
    expect(isValidNewPin("12 4")).toBe(false);
    expect(isValidNewPin("12a4")).toBe(false);
    expect(isValidNewPin("1.34")).toBe(false);
    expect(isValidNewPin("١٢٣٤")).toBe(false);
    expect(isValidNewPin("1234\n")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidNewPin(1234)).toBe(false);
    expect(isValidNewPin(null)).toBe(false);
    expect(isValidNewPin(undefined)).toBe(false);
    expect(isValidNewPin(["1", "2", "3", "4"])).toBe(false);
  });

  it("publishes the same regex source the contract carries, so the two cannot silently diverge", () => {
    expect(PIN_PATTERN_SOURCE).toBe(`^[0-9]{${PIN_LENGTH}}$`);
  });
});
