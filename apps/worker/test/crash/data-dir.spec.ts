// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/crash/data-dir.spec.ts
//
// Mirrors apps/server/test/cli/app-paths.spec.ts's coverage for the
// worker-local twin — same platform defaults, override precedence.

import { describe, expect, it } from "vitest";
import { resolveWorkerDataDir } from "../../src/crash/data-dir.js";

describe("resolveWorkerDataDir", () => {
  it("linux: XDG_DATA_HOME wins when set", () => {
    expect(resolveWorkerDataDir("linux", { XDG_DATA_HOME: "/x/data", HOME: "/home/u" })).toBe("/x/data/loombre");
  });

  it("linux: falls back to ~/.local/share/loombre", () => {
    expect(resolveWorkerDataDir("linux", { HOME: "/home/u" })).toBe("/home/u/.local/share/loombre");
  });

  it("macos: ~/Library/Application Support/Loombre", () => {
    expect(resolveWorkerDataDir("darwin", { HOME: "/Users/u" })).toBe("/Users/u/Library/Application Support/Loombre");
  });

  it("windows: %LOCALAPPDATA%\\Loombre", () => {
    expect(resolveWorkerDataDir("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })).toBe("C:\\Users\\u\\AppData\\Local\\Loombre");
  });

  it("windows: falls back to USERPROFILE\\AppData\\Local\\Loombre when LOCALAPPDATA is absent", () => {
    expect(resolveWorkerDataDir("win32", { USERPROFILE: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Local\\Loombre");
  });

  it("LOOMBRE_DATA_DIR override wins on every platform", () => {
    expect(resolveWorkerDataDir("linux", { LOOMBRE_DATA_DIR: "/custom/dir", HOME: "/home/u" })).toBe("/custom/dir");
    expect(resolveWorkerDataDir("darwin", { LOOMBRE_DATA_DIR: "/custom/dir", HOME: "/Users/u" })).toBe("/custom/dir");
  });

  it("an empty/whitespace-only override falls through to the platform default", () => {
    expect(resolveWorkerDataDir("linux", { LOOMBRE_DATA_DIR: "   ", HOME: "/home/u" })).toBe("/home/u/.local/share/loombre");
  });
});
