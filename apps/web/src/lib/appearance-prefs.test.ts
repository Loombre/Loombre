// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_PREFS,
  applyAppearancePrefs,
  getAppearancePrefs,
  loadAndApplyAppearancePrefs,
  setAppearancePrefs,
} from "./appearance-prefs.js";

describe("appearance-prefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-scanlines");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-scanlines");
  });

  it("defaults to amber + scanlines on when nothing is persisted", () => {
    expect(getAppearancePrefs()).toEqual(DEFAULT_APPEARANCE_PREFS);
  });

  it("ignores corrupt localStorage content and falls back to defaults", () => {
    window.localStorage.setItem("loombre.appearance.v1", "{not json");
    expect(getAppearancePrefs()).toEqual(DEFAULT_APPEARANCE_PREFS);
  });

  it("ignores an invalid accent value from a tampered/stale record", () => {
    window.localStorage.setItem("loombre.appearance.v1", JSON.stringify({ accent: "purple", scanlines: true }));
    expect(getAppearancePrefs().accent).toBe("amber");
  });

  it("setAppearancePrefs merge-patches, persists, and returns the new state", () => {
    const next = setAppearancePrefs({ accent: "lime" });
    expect(next).toEqual({ accent: "lime", scanlines: true });
    expect(getAppearancePrefs()).toEqual({ accent: "lime", scanlines: true });
  });

  it("applyAppearancePrefs writes NO attribute for the default accent (amber) — the zero-flash case", () => {
    applyAppearancePrefs({ accent: "amber", scanlines: true });
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
  });

  it("applyAppearancePrefs writes data-accent for a non-default accent", () => {
    applyAppearancePrefs({ accent: "mint", scanlines: true });
    expect(document.documentElement.getAttribute("data-accent")).toBe("mint");
  });

  it("applyAppearancePrefs writes NO data-scanlines attribute when on (the default)", () => {
    applyAppearancePrefs({ accent: "amber", scanlines: true });
    expect(document.documentElement.hasAttribute("data-scanlines")).toBe(false);
  });

  it("applyAppearancePrefs writes data-scanlines=off when disabled", () => {
    applyAppearancePrefs({ accent: "amber", scanlines: false });
    expect(document.documentElement.getAttribute("data-scanlines")).toBe("off");
  });

  it("switching back to a default value REMOVES a previously-set attribute", () => {
    applyAppearancePrefs({ accent: "blue", scanlines: false });
    expect(document.documentElement.getAttribute("data-accent")).toBe("blue");
    expect(document.documentElement.getAttribute("data-scanlines")).toBe("off");

    applyAppearancePrefs({ accent: "amber", scanlines: true });
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(document.documentElement.hasAttribute("data-scanlines")).toBe(false);
  });

  it("loadAndApplyAppearancePrefs reads the persisted value and applies it in one call", () => {
    setAppearancePrefs({ accent: "lime", scanlines: false });
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-scanlines");

    const loaded = loadAndApplyAppearancePrefs();
    expect(loaded).toEqual({ accent: "lime", scanlines: false });
    expect(document.documentElement.getAttribute("data-accent")).toBe("lime");
    expect(document.documentElement.getAttribute("data-scanlines")).toBe("off");
  });
});
