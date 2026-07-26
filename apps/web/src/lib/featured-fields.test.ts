// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildMovieCandidate, buildSeriesCandidate, candidatePosterImage, candidateSceneImage } from "./featured-fields.js";

function makeMovie(overrides: Partial<Parameters<typeof buildMovieCandidate>[0]> = {}) {
  return {
    id: "m1",
    libraryId: "lib1",
    itemType: "movie" as const,
    title: "Test Movie",
    sortTitle: "Test Movie",
    year: 2024,
    communityRating: 8.234,
    contentClass: "general" as const,
    addedAtMs: 1000,
    updatedAtMs: 1000,
    contentRating: "PG-13",
    runtimeMs: 7_800_000, // 2h10m
    overview: "A test overview.",
    genres: ["Action", "Thriller"],
    images: [],
    ...overrides,
  };
}

function makeSeries(overrides: Partial<Parameters<typeof buildSeriesCandidate>[0]> = {}) {
  return {
    id: "s1",
    libraryId: "lib1",
    itemType: "series" as const,
    title: "Test Series",
    sortTitle: "Test Series",
    year: 2018,
    communityRating: null,
    contentClass: "general" as const,
    addedAtMs: 1000,
    updatedAtMs: 1000,
    contentRating: "TV-14",
    overview: "A test series overview.",
    status: "continuing" as const,
    genres: ["Drama"],
    images: [],
    ...overrides,
  };
}

describe("buildMovieCandidate", () => {
  it("builds a real genre-derived tag (never the prototype's fixture eyebrow copy)", () => {
    const candidate = buildMovieCandidate(makeMovie());
    expect(candidate.tag).toBe("ACTION");
    expect(candidate.tag).not.toBe("FROM YOUR LIBRARY");
  });

  it("falls back to a real itemType-derived tag when genres is empty (not fixture text)", () => {
    const candidate = buildMovieCandidate(makeMovie({ genres: [] }));
    expect(candidate.tag).toBe("MOVIE");
  });

  it("joins year · rating · runtime from real fields", () => {
    const candidate = buildMovieCandidate(makeMovie());
    expect(candidate.specLine).toBe("2024 · ★ 8.2 · 2h 10m");
  });

  it("omits missing fields rather than rendering empty separators", () => {
    const candidate = buildMovieCandidate(makeMovie({ year: null, communityRating: null, runtimeMs: null }));
    expect(candidate.specLine).toBe("");
  });

  it("builds real /items and /watch hrefs", () => {
    const candidate = buildMovieCandidate(makeMovie());
    expect(candidate.href).toBe("/items/movie/m1");
    expect(candidate.playHref).toBe("/watch/m1?type=movie");
  });

  it("derives the poster-fallback initial from the real title", () => {
    expect(buildMovieCandidate(makeMovie({ title: "zenith" })).initial).toBe("Z");
  });
});

describe("buildSeriesCandidate", () => {
  it("uses the README's prescribed series tag verbatim", () => {
    const candidate = buildSeriesCandidate(makeSeries(), 3);
    expect(candidate.tag).toBe("SERIES IN YOUR LIBRARY");
  });

  it("renders a single real year, status label, and real season count", () => {
    const candidate = buildSeriesCandidate(makeSeries(), 3);
    expect(candidate.specLine).toBe("2018 · Continuing · 3 seasons");
  });

  it("singularizes '1 season'", () => {
    const candidate = buildSeriesCandidate(makeSeries(), 1);
    expect(candidate.specLine).toContain("1 season");
    expect(candidate.specLine).not.toContain("1 seasons");
  });

  it("omits the season count entirely when it hasn't been fetched (null), never fabricating a number", () => {
    const candidate = buildSeriesCandidate(makeSeries(), null);
    expect(candidate.specLine).toBe("2018 · Continuing");
  });

  it("omits status when null", () => {
    const candidate = buildSeriesCandidate(makeSeries({ status: null }), 2);
    expect(candidate.specLine).toBe("2018 · 2 seasons");
  });
});

describe("candidateSceneImage / candidatePosterImage", () => {
  it("prefers backdrop for the scene, falls back to poster", () => {
    const poster = { kind: "poster" as const, width: 100, height: 150, blurhash: "abc" };
    const backdrop = { kind: "backdrop" as const, width: 400, height: 200, blurhash: "def" };
    expect(candidateSceneImage([poster, backdrop])).toEqual(backdrop);
    expect(candidateSceneImage([poster])).toEqual(poster);
    expect(candidateSceneImage([])).toBeNull();
  });

  it("poster image is poster-only (never a stretched backdrop)", () => {
    const backdrop = { kind: "backdrop" as const, width: 400, height: 200, blurhash: "def" };
    expect(candidatePosterImage([backdrop])).toBeNull();
  });
});
