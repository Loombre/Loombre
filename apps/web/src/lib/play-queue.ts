// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/play-queue.ts
//
// Pure Track/Album -> MusicPlayerProvider.PlayableTrackInput[] queue-building
// helpers (P2 work item 1: "no UI path starts music" — lane (ii) built
// MusicPlayerProvider/useMusicPlayer, but album/track/artist detail pages
// never called it). Kept separate from lib/queue.ts (that module owns the
// queue's pure REDUCER; this one owns mapping catalog API shapes -> queue
// input) and separate from the components that call it, so the mapping
// logic is unit-testable without React/DOM.
//
// Three UI entry points wire through here:
//   - TrackRow (components/detail/TrackRow.tsx): click a track row inside an
//     album's track list -> tracksToPlayableQueue(albumTracks) + the
//     clicked track's index, so playback continues through the rest of the
//     album.
//   - AlbumDetail (app/items/[itemType]/[id]/page.tsx): "Play" plays the
//     whole album from track 1.
//   - ArtistDetail (same file): "Play" has no dedicated top-tracks/all-
//     tracks endpoint to call (packages/contract/openapi.yaml has no such
//     route), so fetchArtistQueue fetches every album's tracks and
//     flattens them in album-then-track-number order.

import type { components } from "@loombre/sdk";
import { apiGet } from "./api-client.js";
import type { PlayableTrackInput } from "../components/music/MusicPlayerProvider.js";

type Track = components["schemas"]["Track"];
type Album = components["schemas"]["Album"];

export function trackToPlayable(track: Track): PlayableTrackInput {
  return {
    itemId: track.id,
    title: track.title,
    subtitle: track.trackNumber ? `Track ${track.trackNumber}` : null,
    albumId: track.albumId ?? null,
    durationMs: track.durationMs ?? null,
    blurhash: track.images?.find((img) => img.kind === "poster")?.blurhash ?? null,
  };
}

export function tracksToPlayableQueue(tracks: Track[]): PlayableTrackInput[] {
  return tracks.map(trackToPlayable);
}

/** Album-then-track-number order — the order every one of this lane's
 *  track lists is already sorted in before rendering (AlbumDetail). */
function sortedByTrackNumber(tracks: Track[]): Track[] {
  return tracks.slice().sort((a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
}

/** Pure: flattens a set of {tracks} groups (one per album, already fetched)
 *  into a single ordered playable queue — each group's tracks are sorted by
 *  track number, groups stay in the order given (callers pass albums in
 *  release/listing order). */
export function flattenTracksByAlbumOrder(groups: Array<{ tracks: Track[] }>): PlayableTrackInput[] {
  return groups.flatMap((group) => tracksToPlayableQueue(sortedByTrackNumber(group.tracks)));
}

/** Network side effect: fetches every given album's tracks and flattens them
 *  into one queue (ArtistDetail's "Play" — no top-tracks endpoint exists, so
 *  "all tracks across every album" is the honest substitute). */
export async function fetchArtistQueue(albums: Album[]): Promise<PlayableTrackInput[]> {
  const results = await Promise.all(
    albums.map((album) => apiGet("/albums/{id}/tracks", { params: { path: { id: album.id }, query: { limit: 200 } } })),
  );
  return flattenTracksByAlbumOrder(results.map((page) => ({ tracks: page.items })));
}
