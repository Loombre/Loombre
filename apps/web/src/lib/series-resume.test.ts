// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { pickResumeTarget, type EpisodeProgressEntry } from "./series-resume.js";

function entry(partial: Partial<EpisodeProgressEntry> & Pick<EpisodeProgressEntry, "seasonNumber" | "episodeNumber" | "episodeId">): EpisodeProgressEntry {
  return {
    runtimeMs: null,
    progressState: null,
    positionMs: null,
    updatedAtMs: null,
    ...partial,
  };
}

describe("pickResumeTarget", () => {
  it("returns null for an empty episode list", () => {
    expect(pickResumeTarget([])).toBeNull();
  });

  it("picks the most-recently-updated in-progress episode over any other state", () => {
    const entries = [
      entry({ seasonNumber: 1, episodeNumber: 1, episodeId: "e1", progressState: "played" }),
      entry({ seasonNumber: 2, episodeNumber: 3, episodeId: "e2", progressState: "in-progress", positionMs: 1000, updatedAtMs: 500 }),
      entry({ seasonNumber: 2, episodeNumber: 4, episodeId: "e3", progressState: "in-progress", positionMs: 2000, updatedAtMs: 900 }),
    ];
    expect(pickResumeTarget(entries)).toEqual({ episodeId: "e3", seasonNumber: 2, episodeNumber: 4, positionMs: 2000 });
  });

  it("breaks ties in updatedAtMs by (season, episode) order", () => {
    const entries = [
      entry({ seasonNumber: 2, episodeNumber: 4, episodeId: "later", progressState: "in-progress", updatedAtMs: 100 }),
      entry({ seasonNumber: 1, episodeNumber: 2, episodeId: "earlier", progressState: "in-progress", updatedAtMs: 100 }),
    ];
    expect(pickResumeTarget(entries)!.episodeId).toBe("earlier");
  });

  it("falls back to the first not-played episode in order when nothing is in-progress", () => {
    const entries = [
      entry({ seasonNumber: 1, episodeNumber: 1, episodeId: "e1", progressState: "played" }),
      entry({ seasonNumber: 1, episodeNumber: 2, episodeId: "e2", progressState: "played" }),
      entry({ seasonNumber: 1, episodeNumber: 3, episodeId: "e3", progressState: null }),
      entry({ seasonNumber: 2, episodeNumber: 1, episodeId: "e4", progressState: "unplayed" }),
    ];
    expect(pickResumeTarget(entries)).toEqual({ episodeId: "e3", seasonNumber: 1, episodeNumber: 3, positionMs: null });
  });

  it("falls back to the very first episode when every fetched episode is already played", () => {
    const entries = [
      entry({ seasonNumber: 1, episodeNumber: 1, episodeId: "e1", progressState: "played" }),
      entry({ seasonNumber: 1, episodeNumber: 2, episodeId: "e2", progressState: "played" }),
    ];
    expect(pickResumeTarget(entries)).toEqual({ episodeId: "e1", seasonNumber: 1, episodeNumber: 1, positionMs: null });
  });
});
