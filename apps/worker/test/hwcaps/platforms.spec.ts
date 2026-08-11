// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { candidatesForPlatform } from "../../src/hwcaps/platforms.js";

describe("candidatesForPlatform", () => {
  it("macOS: videotoolbox -> software (docs/PLAYBACK.md §8.2)", () => {
    expect(candidatesForPlatform("darwin", "x64")).toEqual(["videotoolbox", "software"]);
  });

  it("Windows: nvenc -> qsv -> amf -> d3d11va(decode-only) -> software", () => {
    expect(candidatesForPlatform("win32", "x64")).toEqual(["nvenc", "qsv", "amf", "d3d11va", "software"]);
  });

  it("Linux: nvenc -> qsv -> vaapi -> software", () => {
    expect(candidatesForPlatform("linux", "x64")).toEqual(["nvenc", "qsv", "vaapi", "software"]);
  });

  it("every known platform's candidate list ends with software", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const candidates = candidatesForPlatform(platform, "x64");
      expect(candidates.at(-1)).toBe("software");
    }
  });

  it("an unlisted platform falls back to software-only rather than throwing", () => {
    expect(candidatesForPlatform("aix", "x64")).toEqual(["software"]);
    expect(candidatesForPlatform("sunos", "x64")).toEqual(["software"]);
  });

  it("returns a fresh array each call (caller mutation can't corrupt the table)", () => {
    const a = candidatesForPlatform("darwin", "x64");
    a.push("qsv");
    expect(candidatesForPlatform("darwin", "x64")).toEqual(["videotoolbox", "software"]);
  });

  // ── LD-2 / C6: the arch axis ────────────────────────────────────────────
  describe("arch axis (LD-2)", () => {
    it("Windows on ARM64: software ONLY — no d3d11va, no vendor encoders", () => {
      expect(candidatesForPlatform("win32", "arm64")).toEqual(["software"]);
    });

    it("Windows on ARM64 excludes d3d11va specifically (the one plausible-looking survivor)", () => {
      expect(candidatesForPlatform("win32", "arm64")).not.toContain("d3d11va");
    });

    it("the pruning is win32-scoped: Linux on ARM64 keeps its full §8.2 order", () => {
      expect(candidatesForPlatform("linux", "arm64")).toEqual(["nvenc", "qsv", "vaapi", "software"]);
    });

    it("the pruning is arm64-scoped: Windows on x64/ia32 keeps its full §8.2 order", () => {
      expect(candidatesForPlatform("win32", "x64")).toEqual(["nvenc", "qsv", "amf", "d3d11va", "software"]);
      expect(candidatesForPlatform("win32", "ia32")).toEqual(["nvenc", "qsv", "amf", "d3d11va", "software"]);
    });

    it("macOS on arm64 is untouched — Apple Silicon videotoolbox is the primary Mac target", () => {
      expect(candidatesForPlatform("darwin", "arm64")).toEqual(["videotoolbox", "software"]);
    });

    it("every (platform, arch) pair still ends with software", () => {
      for (const platform of ["darwin", "win32", "linux", "aix"] as const) {
        for (const arch of ["x64", "arm64", "ia32", "arm"] as const) {
          expect(candidatesForPlatform(platform, arch).at(-1), `${platform}/${arch}`).toBe("software");
        }
      }
    });

    it("returns a fresh array for the pruned win32/arm64 case too", () => {
      const a = candidatesForPlatform("win32", "arm64");
      a.push("d3d11va");
      expect(candidatesForPlatform("win32", "arm64")).toEqual(["software"]);
    });
  });
});
