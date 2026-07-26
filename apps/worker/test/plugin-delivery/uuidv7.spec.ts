// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/plugin-delivery/uuidv7.spec.ts

import { describe, expect, it } from "vitest";
import { uuidv7 } from "@loombre/shared";
import { boundaryUuidv7AtMs, decodeUuidv7TimestampMs, EPOCH_ZERO_BOUNDARY_UUID } from "../../src/plugin-delivery/uuidv7.js";

describe("decodeUuidv7TimestampMs", () => {
  it("round-trips a real @loombre/shared uuidv7() timestamp", () => {
    const ts = 1_784_900_123_456;
    const id = uuidv7(ts);
    expect(decodeUuidv7TimestampMs(id)).toBe(ts);
  });

  it("round-trips a boundary uuid it built itself", () => {
    const ts = 1_700_000_000_000;
    expect(decodeUuidv7TimestampMs(boundaryUuidv7AtMs(ts))).toBe(ts);
  });

  it("epoch-zero boundary decodes to 0", () => {
    expect(decodeUuidv7TimestampMs(EPOCH_ZERO_BOUNDARY_UUID)).toBe(0);
  });
});

describe("boundaryUuidv7AtMs", () => {
  it("produces a well-formed uuid string", () => {
    const id = boundaryUuidv7AtMs(1_700_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sorts BEFORE a real uuidv7() minted at the SAME millisecond (string/byte comparison)", () => {
    const ts = 1_800_000_000_000;
    const boundary = boundaryUuidv7AtMs(ts);
    for (let i = 0; i < 25; i++) {
      const real = uuidv7(ts);
      expect(boundary < real).toBe(true);
    }
  });

  it("sorts BEFORE any real id minted at a LATER millisecond", () => {
    const boundary = boundaryUuidv7AtMs(1_000);
    const later = uuidv7(1_001);
    expect(boundary < later).toBe(true);
  });

  it("sorts AFTER any real id minted at an EARLIER millisecond", () => {
    const boundary = boundaryUuidv7AtMs(2_000);
    const earlier = uuidv7(1_999);
    expect(earlier < boundary).toBe(true);
  });

  it("is deterministic — the same timestamp always produces the identical boundary id", () => {
    const ts = 1_650_000_000_000;
    expect(boundaryUuidv7AtMs(ts)).toBe(boundaryUuidv7AtMs(ts));
  });
});
