// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/item-lookup.ts
//
// /watch/{itemId} (and the music "play" entry points) need basic item
// metadata (title/images/duration) before a playback session exists, but
// the contract has no generic GET /items/{id} — only per-kind endpoints
// (GET /movies/{id}, /episodes/{id}, /tracks/{id}, /albums/{id}; see
// packages/contract/openapi.yaml). Callers that already know the kind
// (e.g. a future detail-page "Play" link) should pass `hintType` to avoid
// the fallback probing below; when absent this tries each kind endpoint in
// turn and treats 404 as "not this kind" (never surfaces a 404 to the
// caller unless every kind misses, which does surface an ItemLookupError).

import type { components } from "@loombre/sdk";
import { apiGet, LoombreApiError } from "./api-client.js";

type ImageDescriptor = components["schemas"]["ImageDescriptor"];
type MediaFileSummary = components["schemas"]["MediaFileSummary"];

export type PlayableKind = "movie" | "episode" | "track" | "album";

export interface ItemSummary {
  id: string;
  itemType: PlayableKind;
  title: string;
  subtitle: string | null;
  images: ImageDescriptor[];
  /** runtimeMs (movie/episode) or durationMs (track); null for albums or
   *  when not yet probed. */
  durationMs: number | null;
  /** Every media_files row this item has (packages/contract/openapi.yaml's
   *  MediaFileSummary — version/edition picker, §8.1), for the playback-
   *  refusal fallback lookup (lib/playback-fallback.ts): GET /movies|
   *  episodes|tracks/{id} already return this array (single-item GET only,
   *  per that schema's own description) — this was previously fetched and
   *  discarded here. Always [] for albums (no `mediaFiles` field on that
   *  schema at all — an album has no file of its own). */
  mediaFiles: MediaFileSummary[];
}

export class ItemLookupError extends Error {
  constructor(public readonly itemId: string) {
    super(`No playable item found for id ${itemId} (tried movie/episode/track/album)`);
    this.name = "ItemLookupError";
  }
}

async function tryMovie(id: string): Promise<ItemSummary | null> {
  try {
    const m = await apiGet("/movies/{id}", { params: { path: { id } } });
    return {
      id: m.id,
      itemType: "movie",
      title: m.title,
      subtitle: m.year ? String(m.year) : null,
      images: m.images ?? [],
      durationMs: m.runtimeMs ?? null,
      mediaFiles: m.mediaFiles ?? [],
    };
  } catch (err) {
    if (err instanceof LoombreApiError && err.status === 404) return null;
    throw err;
  }
}

async function tryEpisode(id: string): Promise<ItemSummary | null> {
  try {
    const e = await apiGet("/episodes/{id}", { params: { path: { id } } });
    return {
      id: e.id,
      itemType: "episode",
      title: e.title,
      subtitle: `Episode ${e.episodeNumber}`,
      images: e.images ?? [],
      durationMs: e.runtimeMs ?? null,
      mediaFiles: e.mediaFiles ?? [],
    };
  } catch (err) {
    if (err instanceof LoombreApiError && err.status === 404) return null;
    throw err;
  }
}

async function tryTrack(id: string): Promise<ItemSummary | null> {
  try {
    const t = await apiGet("/tracks/{id}", { params: { path: { id } } });
    return {
      id: t.id,
      itemType: "track",
      title: t.title,
      subtitle: t.trackNumber ? `Track ${t.trackNumber}` : null,
      images: t.images ?? [],
      durationMs: t.durationMs ?? null,
      mediaFiles: t.mediaFiles ?? [],
    };
  } catch (err) {
    if (err instanceof LoombreApiError && err.status === 404) return null;
    throw err;
  }
}

async function tryAlbum(id: string): Promise<ItemSummary | null> {
  try {
    const a = await apiGet("/albums/{id}", { params: { path: { id } } });
    return { id: a.id, itemType: "album", title: a.title, subtitle: a.year ? String(a.year) : null, images: a.images ?? [], durationMs: null, mediaFiles: [] };
  } catch (err) {
    if (err instanceof LoombreApiError && err.status === 404) return null;
    throw err;
  }
}

const LOOKUPS: Record<PlayableKind, (id: string) => Promise<ItemSummary | null>> = {
  movie: tryMovie,
  episode: tryEpisode,
  track: tryTrack,
  album: tryAlbum,
};

/** Precedence when more than one kind could answer (ids are unique across
 *  kinds, so this is a tie-break that should never be needed — it exists so
 *  the parallel probe below is deterministic). */
const KIND_ORDER = ["movie", "episode", "track", "album"] as const;

/**
 * Resolves item metadata by id. Pass `hintType` (e.g. from a `?type=` query
 * param on /watch links a caller controls) to go straight to the right
 * endpoint.
 *
 * QA verify/gap-F9: the fallback probe used to be SEQUENTIAL — an album id
 * cost four round trips (three 404s first) and an unresolvable id cost four
 * before it could even be reported, all of it while
 * app/watch/[itemId]/page.tsx rendered nothing. The probes are independent
 * reads, so they go out together and the first kind in `KIND_ORDER` that
 * answers wins: one round trip instead of up to four.
 *
 * `allSettled`, not `all`: one endpoint failing (a 500 on /movies/{id}, say)
 * must not be able to hide another kind's hit — with `all` the first
 * rejection would win the race and lose the answer. When nothing hits, a
 * real HTTP failure is rethrown as itself so callers can tell "no such item"
 * (ItemLookupError → 404) from "the server is unwell" (LoombreApiError with
 * its own status).
 */
export async function fetchItemSummary(itemId: string, hintType?: string): Promise<ItemSummary> {
  if (hintType && hintType in LOOKUPS) {
    const hit = await LOOKUPS[hintType as PlayableKind](itemId);
    if (hit) return hit;
  }
  const kinds = KIND_ORDER.filter((kind) => kind !== hintType); // the hint was already tried above
  const settled = await Promise.allSettled(kinds.map((kind) => LOOKUPS[kind](itemId)));

  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) return result.value;
  }
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw (failure as PromiseRejectedResult).reason;
  throw new ItemLookupError(itemId);
}

export function backdropImage(images: ImageDescriptor[]): ImageDescriptor | null {
  return images.find((i) => i.kind === "backdrop") ?? null;
}

export function posterImage(images: ImageDescriptor[]): ImageDescriptor | null {
  return images.find((i) => i.kind === "poster") ?? null;
}
