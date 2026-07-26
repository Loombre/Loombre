// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { decideInvalidation } from "../../src/hwcaps/invalidation.js";

const RESOLVED = { ffmpegBuildHash: "hash-a", gpuFingerprint: "gpu-a" };

describe("decideInvalidation", () => {
  it("no current snapshot -> 'no-snapshot' (fresh install / never probed)", () => {
    expect(decideInvalidation(null, RESOLVED)).toBe("no-snapshot");
  });

  it("matching fingerprint -> null (no probe needed)", () => {
    expect(decideInvalidation({ ffmpegBuildHash: "hash-a", gpuFingerprint: "gpu-a" }, RESOLVED)).toBeNull();
  });

  it("ffmpeg build hash changed -> invalidates even with the same GPU fingerprint", () => {
    expect(decideInvalidation({ ffmpegBuildHash: "hash-OLD", gpuFingerprint: "gpu-a" }, RESOLVED)).toBe(
      "ffmpeg-build-hash-changed",
    );
  });

  it("GPU fingerprint changed -> invalidates even with the same ffmpeg build hash", () => {
    expect(decideInvalidation({ ffmpegBuildHash: "hash-a", gpuFingerprint: "gpu-OLD" }, RESOLVED)).toBe(
      "gpu-fingerprint-changed",
    );
  });

  it("both changed -> ffmpeg build hash takes priority in the reported reason", () => {
    expect(decideInvalidation({ ffmpegBuildHash: "hash-OLD", gpuFingerprint: "gpu-OLD" }, RESOLVED)).toBe(
      "ffmpeg-build-hash-changed",
    );
  });

  it("both '' (GPU fingerprint unavailable on both sides) -> invalidation keys on ffmpeg hash alone", () => {
    expect(decideInvalidation({ ffmpegBuildHash: "hash-a", gpuFingerprint: "" }, { ffmpegBuildHash: "hash-a", gpuFingerprint: "" })).toBeNull();
    expect(
      decideInvalidation({ ffmpegBuildHash: "hash-OLD", gpuFingerprint: "" }, { ffmpegBuildHash: "hash-a", gpuFingerprint: "" }),
    ).toBe("ffmpeg-build-hash-changed");
  });
});
