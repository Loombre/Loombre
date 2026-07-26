// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { candidatesForPlatform } from "../../src/hwcaps/platforms.js";

describe("candidatesForPlatform", () => {
  it("macOS: videotoolbox -> software (docs/PLAYBACK.md §8.2)", () => {
    expect(candidatesForPlatform("darwin")).toEqual(["videotoolbox", "software"]);
  });

  it("Windows: nvenc -> qsv -> amf -> d3d11va(decode-only) -> software", () => {
    expect(candidatesForPlatform("win32")).toEqual(["nvenc", "qsv", "amf", "d3d11va", "software"]);
  });

  it("Linux: nvenc -> qsv -> vaapi -> software", () => {
    expect(candidatesForPlatform("linux")).toEqual(["nvenc", "qsv", "vaapi", "software"]);
  });

  it("every known platform's candidate list ends with software", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const candidates = candidatesForPlatform(platform);
      expect(candidates.at(-1)).toBe("software");
    }
  });

  it("an unlisted platform falls back to software-only rather than throwing", () => {
    expect(candidatesForPlatform("aix")).toEqual(["software"]);
    expect(candidatesForPlatform("sunos")).toEqual(["software"]);
  });

  it("returns a fresh array each call (caller mutation can't corrupt the table)", () => {
    const a = candidatesForPlatform("darwin");
    a.push("qsv");
    expect(candidatesForPlatform("darwin")).toEqual(["videotoolbox", "software"]);
  });
});
