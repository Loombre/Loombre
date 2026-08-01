// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ZONE_DENSITY, getZoneDensity, setZoneDensity } from "./zone-density-prefs.js";

describe("zone-density-prefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to poster wall when nothing is persisted", () => {
    expect(getZoneDensity()).toBe(DEFAULT_ZONE_DENSITY);
    expect(getZoneDensity()).toBe("wall");
  });

  it("ignores a corrupt/tampered stored value and falls back to the default", () => {
    window.localStorage.setItem("loombre.restricted-zone.density.v1", "columns");
    expect(getZoneDensity()).toBe("wall");
  });

  it("setZoneDensity persists rows and getZoneDensity reads it back", () => {
    setZoneDensity("rows");
    expect(getZoneDensity()).toBe("rows");
  });

  it("round-trips back to wall after switching", () => {
    setZoneDensity("rows");
    setZoneDensity("wall");
    expect(getZoneDensity()).toBe("wall");
  });
});
