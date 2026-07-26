// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { resolveEmbeddedPgPlatform, EMBEDDED_PG_PLATFORMS, isWindowsPlatform } from "../src/platform.js";

describe("resolveEmbeddedPgPlatform", () => {
  const cases: Array<[NodeJS.Platform, string, string | null]> = [
    ["darwin", "arm64", "macos-arm64"],
    ["darwin", "x64", "macos-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["linux", "x64", "linux-x64"],
    ["win32", "x64", "windows-x64"],
    ["darwin", "ia32", null],
    ["linux", "ia32", null],
    ["win32", "arm64", null],
    ["freebsd", "x64", null],
    ["sunos", "x64", null],
  ];

  for (const [platform, arch, expected] of cases) {
    it(`${platform}/${arch} -> ${expected}`, () => {
      expect(resolveEmbeddedPgPlatform(platform, arch)).toBe(expected);
    });
  }

  it("every EMBEDDED_PG_PLATFORMS member is reachable from some real Node platform/arch pair", () => {
    const reachable = new Set(
      cases
        .map(([platform, arch]) => resolveEmbeddedPgPlatform(platform, arch))
        .filter((p): p is Exclude<typeof p, null> => p !== null),
    );
    for (const platform of EMBEDDED_PG_PLATFORMS) {
      expect(reachable.has(platform)).toBe(true);
    }
  });
});

describe("isWindowsPlatform", () => {
  it("true only for windows-x64", () => {
    expect(isWindowsPlatform("windows-x64")).toBe(true);
    expect(isWindowsPlatform("linux-x64")).toBe(false);
    expect(isWindowsPlatform("macos-arm64")).toBe(false);
  });
});
