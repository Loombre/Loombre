// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/pin-entry.test.ts

import { describe, expect, it } from "vitest";
import { PIN_LENGTH, appendPinDigit, isPinComplete, sanitizePinInput, stripPinDigits } from "./pin-entry.js";

describe("stripPinDigits — digits-only WITHOUT the length clamp", () => {
  it("strips non-digits", () => {
    expect(stripPinDigits("5a4b3c2d1")).toBe("54321");
  });

  it("keeps buffers longer than PIN_LENGTH intact", () => {
    // The `Current PIN` field's whole job: prove an ALREADY-STORED PIN,
    // which on an install predating the 4-digit rule may be longer. Clamping
    // it would make those users unable to change their PIN or opt out.
    expect(stripPinDigits("123456789").length).toBeGreaterThan(PIN_LENGTH);
  });

  it("is the sole digit filter sanitizePinInput itself is built from", () => {
    expect(sanitizePinInput("9z8y7x6w5")).toBe(stripPinDigits("9z8y7x6w5").slice(0, PIN_LENGTH));
  });
});

describe("sanitizePinInput", () => {
  it("strips non-digit characters", () => {
    expect(sanitizePinInput("1a2b3c")).toBe("123");
  });

  it("clamps to PIN_LENGTH", () => {
    expect(PIN_LENGTH).toBe(4);
    expect(sanitizePinInput("123456789")).toBe("1234");
  });

  it("passes through an already-valid buffer unchanged", () => {
    expect(sanitizePinInput("0912")).toBe("0912");
  });
});

describe("appendPinDigit", () => {
  it("appends one digit at a time", () => {
    let pin = "";
    pin = appendPinDigit(pin, "1");
    pin = appendPinDigit(pin, "2");
    pin = appendPinDigit(pin, "3");
    expect(pin).toBe("123");
  });

  it("stops growing once PIN_LENGTH digits are present — a full buffer ignores further digits", () => {
    const full = "1234";
    expect(appendPinDigit(full, "5")).toBe("1234");
  });
});

describe("isPinComplete — the auto-submit rule (README: auto-submits on the 4th digit)", () => {
  it("false for 0-3 digits", () => {
    expect(isPinComplete("")).toBe(false);
    expect(isPinComplete("1")).toBe(false);
    expect(isPinComplete("12")).toBe(false);
    expect(isPinComplete("123")).toBe(false);
  });

  it("true at exactly 4 digits — this is the instant PinModal auto-submits", () => {
    expect(isPinComplete("1234")).toBe(true);
  });

  it("a full buffer built one appendPinDigit() call at a time becomes complete exactly on the 4th call", () => {
    let pin = "";
    const completedAfter: boolean[] = [];
    for (const digit of ["9", "0", "1", "2"]) {
      pin = appendPinDigit(pin, digit);
      completedAfter.push(isPinComplete(pin));
    }
    expect(completedAfter).toEqual([false, false, false, true]);
  });
});
