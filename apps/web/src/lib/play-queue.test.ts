// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { flattenTracksByAlbumOrder, tracksToPlayableQueue, trackToPlayable } from "./play-queue.js";
import type { components } from "@loombre/sdk";

type Track = components["schemas"]["Track"];

function track(overrides: Partial<Track> & { id: string; trackNumber: number | null }): Track {
  return {
    id: overrides.id,
    libraryId: "lib-1",
    itemType: "track",
    title: overrides.title ?? `Track ${overrides.id}`,
    sortTitle: overrides.title ?? `Track ${overrides.id}`,
    year: null,
    communityRating: null,
    contentClass: "general",
    addedAtMs: 0,
    updatedAtMs: 0,
    albumId: overrides.albumId ?? "album-1",
    artistId: "artist-1",
    trackNumber: overrides.trackNumber,
    discNumber: overrides.discNumber ?? null,
    durationMs: overrides.durationMs ?? 180_000,
    images: overrides.images ?? [],
  } as Track;
}

describe("trackToPlayable", () => {
  it("maps a Track to a PlayableTrackInput, deriving subtitle from trackNumber", () => {
    const t = track({ id: "t1", trackNumber: 3, durationMs: 200_000 });
    expect(trackToPlayable(t)).toEqual({
      itemId: "t1",
      title: "Track t1",
      subtitle: "Track 3",
      albumId: "album-1",
      durationMs: 200_000,
      blurhash: null,
    });
  });

  it("falls back to a null subtitle when trackNumber is null", () => {
    const t = track({ id: "t1", trackNumber: null });
    expect(trackToPlayable(t).subtitle).toBeNull();
  });

  it("pulls blurhash from the track's own poster image when present", () => {
    const t = track({
      id: "t1",
      trackNumber: 1,
      images: [{ kind: "poster", blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH", dominantColor: null } as never],
    });
    expect(trackToPlayable(t).blurhash).toBe("LKO2?U%2Tw=w]~RBVZRi};RPxuwH");
  });
});

describe("tracksToPlayableQueue", () => {
  it("maps an ordered track list in the same order (queue = album from that point relies on this)", () => {
    const tracks = [track({ id: "a", trackNumber: 1 }), track({ id: "b", trackNumber: 2 }), track({ id: "c", trackNumber: 3 })];
    expect(tracksToPlayableQueue(tracks).map((t) => t.itemId)).toEqual(["a", "b", "c"]);
  });
});

describe("flattenTracksByAlbumOrder", () => {
  it("sorts each group by trackNumber and keeps groups in the given order", () => {
    const groupA = { tracks: [track({ id: "a2", trackNumber: 2, albumId: "album-a" }), track({ id: "a1", trackNumber: 1, albumId: "album-a" })] };
    const groupB = { tracks: [track({ id: "b1", trackNumber: 1, albumId: "album-b" })] };

    const queue = flattenTracksByAlbumOrder([groupA, groupB]);
    expect(queue.map((t) => t.itemId)).toEqual(["a1", "a2", "b1"]);
  });

  it("treats a null trackNumber as 0 (sorts first within its group)", () => {
    const group = { tracks: [track({ id: "x", trackNumber: 5 }), track({ id: "y", trackNumber: null })] };
    expect(flattenTracksByAlbumOrder([group]).map((t) => t.itemId)).toEqual(["y", "x"]);
  });

  it("returns an empty queue for an empty group list", () => {
    expect(flattenTracksByAlbumOrder([])).toEqual([]);
  });
});
