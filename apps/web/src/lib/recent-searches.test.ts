// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRecentSearch, getRecentSearches } from "./recent-searches.js";

describe("recent-searches", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("starts empty (no fabricated recents on a first-ever visit)", () => {
    expect(getRecentSearches()).toEqual([]);
  });

  it("addRecentSearch persists and returns the updated list, most recent first", () => {
    addRecentSearch("sodium");
    const result = addRecentSearch("marrow");
    expect(result).toEqual(["marrow", "sodium"]);
    expect(getRecentSearches()).toEqual(["marrow", "sodium"]);
  });

  it("re-searching an existing query (any case) moves it to the front without duplicating", () => {
    addRecentSearch("sodium");
    addRecentSearch("marrow");
    const result = addRecentSearch("Sodium");
    expect(result).toEqual(["Sodium", "marrow"]);
  });

  it("a blank/whitespace query is a no-op, never becomes a pill", () => {
    addRecentSearch("sodium");
    const result = addRecentSearch("   ");
    expect(result).toEqual(["sodium"]);
  });

  it("caps at 8 entries, dropping the oldest", () => {
    for (let i = 0; i < 10; i++) addRecentSearch(`q${i}`);
    const result = getRecentSearches();
    expect(result).toHaveLength(8);
    expect(result[0]).toBe("q9");
    expect(result).not.toContain("q0");
    expect(result).not.toContain("q1");
  });

  it("survives corrupt localStorage content instead of throwing", () => {
    window.localStorage.setItem("loombre.search.recent.v1", "{not json");
    expect(getRecentSearches()).toEqual([]);
    expect(() => addRecentSearch("sodium")).not.toThrow();
  });
});
