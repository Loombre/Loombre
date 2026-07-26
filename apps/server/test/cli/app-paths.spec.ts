// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/cli/app-paths.spec.ts
//
// Pure unit tests for apps/server/src/cli/app-paths.ts (docs/PLAN.md §11
// platform-correct app-data locations). Every branch is exercised
// regardless of the host OS running the suite — resolveAppPaths never
// touches process.platform/process.env itself.

import { describe, expect, it } from "vitest";
import { resolveAppPaths, toSupportedPlatform } from "../../src/cli/app-paths.js";

describe("toSupportedPlatform", () => {
  it("maps darwin -> macos, win32 -> windows, everything else -> linux", () => {
    expect(toSupportedPlatform("darwin")).toBe("macos");
    expect(toSupportedPlatform("win32")).toBe("windows");
    expect(toSupportedPlatform("linux")).toBe("linux");
    expect(toSupportedPlatform("freebsd")).toBe("linux");
  });
});

describe("resolveAppPaths", () => {
  it("linux: defaults to XDG_DATA_HOME/XDG_CONFIG_HOME when set", () => {
    const result = resolveAppPaths("linux", { XDG_DATA_HOME: "/x/data", XDG_CONFIG_HOME: "/x/config", HOME: "/home/u" });
    expect(result.dataDir).toBe("/x/data/loombre");
    expect(result.configDir).toBe("/x/config/loombre");
    expect(result.dataDirSource).toBe("default");
    expect(result.configDirSource).toBe("default");
  });

  it("linux: falls back to ~/.local/share and ~/.config when XDG vars are absent", () => {
    const result = resolveAppPaths("linux", { HOME: "/home/u" });
    expect(result.dataDir).toBe("/home/u/.local/share/loombre");
    expect(result.configDir).toBe("/home/u/.config/loombre");
  });

  it("macos: uses ~/Library/Application Support/Loombre (and a config/ subfolder)", () => {
    const result = resolveAppPaths("darwin", { HOME: "/Users/u" });
    expect(result.dataDir).toBe("/Users/u/Library/Application Support/Loombre");
    expect(result.configDir).toBe("/Users/u/Library/Application Support/Loombre/config");
  });

  it("windows: uses %LOCALAPPDATA%\\Loombre for data, %APPDATA%\\Loombre for config", () => {
    const result = resolveAppPaths("win32", {
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
    });
    expect(result.dataDir).toBe("C:\\Users\\u\\AppData\\Local\\Loombre");
    expect(result.configDir).toBe("C:\\Users\\u\\AppData\\Roaming\\Loombre");
  });

  it("windows: falls back to USERPROFILE\\AppData\\{Local,Roaming} when the AppData vars are absent", () => {
    const result = resolveAppPaths("win32", { USERPROFILE: "C:\\Users\\u" });
    expect(result.dataDir).toBe("C:\\Users\\u\\AppData\\Local\\Loombre");
    expect(result.configDir).toBe("C:\\Users\\u\\AppData\\Roaming\\Loombre");
  });

  it("LOOMBRE_DATA_DIR / LOOMBRE_CONFIG_DIR always win, on every platform", () => {
    const result = resolveAppPaths("linux", {
      HOME: "/home/u",
      LOOMBRE_DATA_DIR: "/mnt/loombre-data",
      LOOMBRE_CONFIG_DIR: "/etc/loombre",
    });
    expect(result.dataDir).toBe("/mnt/loombre-data");
    expect(result.dataDirSource).toBe("env");
    expect(result.configDir).toBe("/etc/loombre");
    expect(result.configDirSource).toBe("env");
  });

  it("blank env overrides (whitespace-only) are treated as unset", () => {
    const result = resolveAppPaths("linux", { HOME: "/home/u", LOOMBRE_DATA_DIR: "   " });
    expect(result.dataDirSource).toBe("default");
    expect(result.dataDir).toBe("/home/u/.local/share/loombre");
  });
});
