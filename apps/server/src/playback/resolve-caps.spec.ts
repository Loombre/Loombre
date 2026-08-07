// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/resolve-caps.spec.ts
//
// Unit test for the pure fallback-shape half of resolve-caps.ts (Phase 3
// §11 step 6b). The DB-backed happy/missing-snapshot paths
// (resolveVerifiedCapabilities) are exercised against a REAL database in
// apps/server/test/playback.e2e.spec.ts instead — this file only proves
// the fallback object itself is shaped correctly and is total (every
// VideoCodec, both software encode targets, no tone-map).

import { describe, expect, it } from "vitest";
import { capabilitiesFromSnapshot, softwareOnlyFallbackCapabilities } from "./resolve-caps.js";

describe("capabilitiesFromSnapshot (W1/D-1: empty persisted report falls back like a missing one)", () => {
  it("null snapshot -> software-only fallback, reason 'missing-snapshot'", () => {
    const resolved = capabilitiesFromSnapshot(null);
    expect(resolved.fallbackReason).toBe("missing-snapshot");
    expect(resolved.caps).toEqual(softwareOnlyFallbackCapabilities());
  });

  it("persisted snapshot with zero backends -> software-only fallback, reason 'empty-snapshot'", () => {
    const resolved = capabilitiesFromSnapshot({ backends: [] });
    expect(resolved.fallbackReason).toBe("empty-snapshot");
    expect(resolved.caps).toEqual(softwareOnlyFallbackCapabilities());
  });

  it("non-empty snapshot passes through verbatim with no fallback", () => {
    const snapshot = {
      backends: [
        { backend: "videotoolbox", decode: ["h264"], encode: ["h264"], toneMap: ["videotoolbox"], verifiedAtMs: 1750000000000 },
        { backend: "software", decode: ["h264", "hevc"], encode: ["h264", "hevc"], toneMap: [], verifiedAtMs: 1750000000000 },
      ],
    };
    const resolved = capabilitiesFromSnapshot(snapshot);
    expect(resolved.fallbackReason).toBeNull();
    expect(resolved.caps).toBe(snapshot);
  });
});

describe("softwareOnlyFallbackCapabilities", () => {
  it("declares exactly one 'software' backend with a full decode list and h264/hevc encode", () => {
    const caps = softwareOnlyFallbackCapabilities();
    expect(caps.backends).toHaveLength(1);
    const [backend] = caps.backends;
    expect(backend!.backend).toBe("software");
    expect(backend!.decode).toEqual(
      expect.arrayContaining(["h264", "hevc", "av1", "vp9", "mpeg2", "vc1", "mpeg4", "unknown"]),
    );
    expect(backend!.encode).toEqual(["h264", "hevc"]);
    expect(backend!.toneMap).toEqual([]);
  });

  it("verifiedAtMs is the documented 'never verified' sentinel (0)", () => {
    expect(softwareOnlyFallbackCapabilities().backends[0]!.verifiedAtMs).toBe(0);
  });
});
