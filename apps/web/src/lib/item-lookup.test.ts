// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/item-lookup.test.ts
//
// REGRESSION GUARD (QA verify/gap-F9, P2 — "/watch/{id} is blank for the
// whole lookup window"): the contract has no generic GET /items/{id}, so
// this module probes the per-kind endpoints. It used to do that STRICTLY
// SEQUENTIALLY — up to four round trips of 404s before an album id resolved,
// and four before an unresolvable id could even be reported — while
// app/watch/[itemId]/page.tsx rendered nothing at all. ~100ms on localhost,
// seconds against a remote server. The probes are independent, so they go out
// together and the FIRST kind in precedence order wins.
//
// The error semantics that came with that change are pinned here too: one
// endpoint failing (500/503) must not be able to hide a hit from another
// kind, and when nothing hits, a real HTTP failure must surface as itself
// rather than being flattened into "no such item".

import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeLoombreApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "LoombreApiError";
  }
}

const apiGet = vi.fn();

vi.mock("./api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  LoombreApiError: FakeLoombreApiError,
}));

const { fetchItemSummary, ItemLookupError } = await import("./item-lookup.js");

const ITEM_ID = "01890000-0000-7000-8000-000000000001";

const MOVIE_PATH = "/movies/{id}";
const EPISODE_PATH = "/episodes/{id}";
const TRACK_PATH = "/tracks/{id}";
const ALBUM_PATH = "/albums/{id}";

/** A per-path script: a function per endpoint, defaulting to "404, not this
 *  kind" so a test only spells out the endpoints it cares about. */
function installProbes(script: Partial<Record<string, () => Promise<unknown>>>): void {
  apiGet.mockImplementation((path: string) => {
    const handler = script[path];
    if (handler) return handler();
    return Promise.reject(new FakeLoombreApiError(404));
  });
}

function trackRow(): Record<string, unknown> {
  return { id: ITEM_ID, title: "Heliotrope", trackNumber: 3, durationMs: 214_000, images: [], mediaFiles: [] };
}

function movieRow(): Record<string, unknown> {
  return { id: ITEM_ID, title: "Arrival", year: 2016, runtimeMs: 6_960_000, images: [], mediaFiles: [] };
}

function probedPaths(): string[] {
  return apiGet.mock.calls.map((call) => call[0] as string);
}

describe("fetchItemSummary — kind probes run concurrently (QA verify/gap-F9)", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("REGRESSION GUARD: every kind probe is in flight at once, not one round trip after another", async () => {
    // Nothing ever settles: what matters is how many requests exist by the
    // time the caller gets its promise back. Sequential probing can only ever
    // have ONE.
    installProbes({
      [MOVIE_PATH]: () => new Promise(() => undefined),
      [EPISODE_PATH]: () => new Promise(() => undefined),
      [TRACK_PATH]: () => new Promise(() => undefined),
      [ALBUM_PATH]: () => new Promise(() => undefined),
    });

    void fetchItemSummary(ITEM_ID).catch(() => undefined);

    expect(probedPaths()).toEqual([MOVIE_PATH, EPISODE_PATH, TRACK_PATH, ALBUM_PATH]);
  });

  it("resolves the kind that hits, whichever one it is", async () => {
    installProbes({ [TRACK_PATH]: () => Promise.resolve(trackRow()) });

    const summary = await fetchItemSummary(ITEM_ID);

    expect(summary.itemType).toBe("track");
    expect(summary.title).toBe("Heliotrope");
    expect(summary.durationMs).toBe(214_000);
  });

  it("keeps the movie → episode → track → album precedence when more than one kind answers", async () => {
    installProbes({
      [MOVIE_PATH]: () => Promise.resolve(movieRow()),
      [TRACK_PATH]: () => Promise.resolve(trackRow()),
    });

    expect((await fetchItemSummary(ITEM_ID)).itemType).toBe("movie");
  });

  it("a ?type= hint still short-circuits to ONE request when it hits", async () => {
    installProbes({ [TRACK_PATH]: () => Promise.resolve(trackRow()) });

    const summary = await fetchItemSummary(ITEM_ID, "track");

    expect(summary.itemType).toBe("track");
    expect(probedPaths()).toEqual([TRACK_PATH]);
  });

  it("a hint that misses falls back to the other three kinds, without re-probing the hinted one", async () => {
    installProbes({ [MOVIE_PATH]: () => Promise.resolve(movieRow()) });

    expect((await fetchItemSummary(ITEM_ID, "track")).itemType).toBe("movie");
    expect(probedPaths()).toEqual([TRACK_PATH, MOVIE_PATH, EPISODE_PATH, ALBUM_PATH]);
  });

  it("throws ItemLookupError when every kind 404s", async () => {
    installProbes({});

    await expect(fetchItemSummary(ITEM_ID)).rejects.toBeInstanceOf(ItemLookupError);
  });

  it("one endpoint failing hard cannot hide another kind's hit", async () => {
    installProbes({
      [MOVIE_PATH]: () => Promise.reject(new FakeLoombreApiError(503)),
      [TRACK_PATH]: () => Promise.resolve(trackRow()),
    });

    expect((await fetchItemSummary(ITEM_ID)).itemType).toBe("track");
  });

  it("surfaces a real HTTP failure as itself, never as 'no such item', when nothing hits", async () => {
    installProbes({ [EPISODE_PATH]: () => Promise.reject(new FakeLoombreApiError(500)) });

    await expect(fetchItemSummary(ITEM_ID)).rejects.toMatchObject({ status: 500 });
  });
});
