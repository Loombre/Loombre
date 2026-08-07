// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/capability-view.test.ts

import { describe, expect, it } from "vitest";
import { hasNoAcceleratedCapabilities } from "./capability-view.js";

function backend(name: string, decode: string[] = [], encode: string[] = [], toneMap: string[] = []) {
  return { name, decode, encode, toneMap };
}

describe("hasNoAcceleratedCapabilities (W1/D-1: the copy must fire on every GPU-less outcome)", () => {
  it("zero backends -> true (persisted-empty report)", () => {
    expect(hasNoAcceleratedCapabilities({ backends: [] })).toBe(true);
  });

  it("all backends empty -> true (encoders-listing failure: even software verified nothing)", () => {
    expect(
      hasNoAcceleratedCapabilities({
        backends: [backend("nvenc"), backend("qsv"), backend("amf"), backend("d3d11va"), backend("software")],
      }),
    ).toBe(true);
  });

  it("software verified caps but every hardware backend empty -> TRUE (the common GPU-less VM outcome)", () => {
    expect(
      hasNoAcceleratedCapabilities({
        backends: [
          backend("nvenc"),
          backend("qsv"),
          backend("amf"),
          backend("d3d11va"),
          backend("software", ["h264", "hevc"], ["h264", "hevc"]),
        ],
      }),
    ).toBe(true);
  });

  it("any hardware backend with any verified capability -> false", () => {
    expect(
      hasNoAcceleratedCapabilities({
        backends: [backend("videotoolbox", ["h264"]), backend("software", ["h264"], ["h264"])],
      }),
    ).toBe(false);
    expect(
      hasNoAcceleratedCapabilities({
        backends: [backend("nvenc", [], [], ["cuda"]), backend("software")],
      }),
    ).toBe(false);
  });
});
