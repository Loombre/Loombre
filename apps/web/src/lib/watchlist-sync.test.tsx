// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/watchlist-sync.test.tsx
//
// browser-items-F9 regression guard: a single movie-detail load fired SIX
// identical GET /watchlist?limit=200 requests, because useWatchlistIds()
// was deliberately per-mount ("not a singleton cache") and the detail
// screen mounts three consumers at once (desktop WatchlistToggle, mobile
// WatchlistToggle, Sidebar's count) — doubled again by dev StrictMode's
// effect re-invocation. The id set is ONE piece of server state that
// cannot legitimately differ between those consumers in the same render,
// so they now share one in-flight/settled fetch, one socket subscription,
// and one snapshot (lib/watchlist-id-store.ts) — same shared-loader
// discipline as restricted-zone-count.ts (AUD-A4v6-003), whose hook test
// this file mirrors.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../components/ui/test-render.js";

const apiGetMock = vi.fn();

vi.mock("./api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

type SocketPayload = { userId: string; itemId: string };
type SocketListener = (event: { payload: SocketPayload }) => void;

const socketListeners = new Map<string, Set<SocketListener>>();
let socketSubscribeCalls = 0;

vi.mock("./events-socket.js", () => ({
  getEventsSocket: () => ({
    subscribe: (type: string, listener: SocketListener) => {
      socketSubscribeCalls += 1;
      let set = socketListeners.get(type);
      if (!set) {
        set = new Set();
        socketListeners.set(type, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
  }),
}));

// Imported AFTER the mocks above so the module under test picks them up
// (same convention as restricted-zone-count.hook.test.tsx).
const { useWatchlistIds } = await import("./watchlist-sync.js");
type HookResult = ReturnType<typeof useWatchlistIds>;

/** Each Probe writes its latest hook result here, keyed by mount id, so a
 *  test can assert every consumer sees the SAME shared state. */
const results = new Map<number, HookResult>();

function Probe({ id }: { id: number }): null {
  results.set(id, useWatchlistIds());
  return null;
}

function probes(n: number): React.JSX.Element {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <Probe key={i} id={i} />
      ))}
    </>
  );
}

function watchlistCalls(): unknown[][] {
  return apiGetMock.mock.calls.filter((call) => call[0] === "/watchlist");
}

function emitSocket(type: string, itemId: string): void {
  act(() => {
    for (const listener of [...(socketListeners.get(type) ?? [])]) {
      listener({ payload: { userId: "user-1", itemId } });
    }
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useWatchlistIds (shared id store / request coalescing)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ items: [{ item: { id: "movie-1" } }], nextCursor: null });
    socketSubscribeCalls = 0;
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    results.clear();
    socketListeners.clear();
  });

  it("browser-items-F9: N concurrently mounted consumers share ONE GET /watchlist and one result", async () => {
    view = renderIntoBody(probes(3));
    await flush();

    expect(watchlistCalls()).toHaveLength(1);
    for (const id of [0, 1, 2]) {
      expect(results.get(id)?.loading).toBe(false);
      expect([...(results.get(id)?.ids ?? [])]).toEqual(["movie-1"]);
    }
  });

  it("browser-items-F9: N consumers share ONE pair of events-socket subscriptions", async () => {
    view = renderIntoBody(probes(3));
    await flush();

    expect(socketSubscribeCalls).toBe(2); // watchlist.added + watchlist.removed, once
  });

  it("a consumer mounting AFTER the shared page arrived reuses it without another fetch", async () => {
    view = renderIntoBody(probes(2));
    await flush();
    view.rerender(probes(3));
    await flush();

    expect(watchlistCalls()).toHaveLength(1);
    expect([...(results.get(2)?.ids ?? [])]).toEqual(["movie-1"]);
  });

  it("an optimistic markAdded from ONE consumer is visible to every other consumer at once", async () => {
    view = renderIntoBody(probes(3));
    await flush();

    act(() => {
      results.get(0)!.markAdded("movie-9");
    });

    for (const id of [0, 1, 2]) {
      expect(results.get(id)?.ids.has("movie-9")).toBe(true);
    }
  });

  it("an optimistic markRemoved from ONE consumer is visible to every other consumer at once", async () => {
    view = renderIntoBody(probes(3));
    await flush();

    act(() => {
      results.get(1)!.markRemoved("movie-1");
    });

    for (const id of [0, 1, 2]) {
      expect(results.get(id)?.ids.has("movie-1")).toBe(false);
    }
  });

  it("a watchlist.added socket event updates every consumer (cross-device sync survives the shared store)", async () => {
    view = renderIntoBody(probes(2));
    await flush();

    emitSocket("watchlist.added", "movie-7");
    for (const id of [0, 1]) {
      expect(results.get(id)?.ids.has("movie-7")).toBe(true);
    }

    emitSocket("watchlist.removed", "movie-7");
    for (const id of [0, 1]) {
      expect(results.get(id)?.ids.has("movie-7")).toBe(false);
    }
  });

  it("reports atCapacity to every consumer when the bounded page has more rows", async () => {
    apiGetMock.mockResolvedValue({ items: [{ item: { id: "movie-1" } }], nextCursor: "next" });
    view = renderIntoBody(probes(2));
    await flush();

    expect(results.get(0)?.atCapacity).toBe(true);
    expect(results.get(1)?.atCapacity).toBe(true);
  });

  it("a failed shared fetch leaves every consumer loaded-but-empty (no infinite spinner on the toggle)", async () => {
    apiGetMock.mockRejectedValue(new Error("network down"));
    view = renderIntoBody(probes(2));
    await flush();

    expect(watchlistCalls()).toHaveLength(1);
    for (const id of [0, 1]) {
      expect(results.get(id)?.loading).toBe(false);
      expect(results.get(id)?.ids.size).toBe(0);
    }
  });

  it("after every consumer unmounts, the next mount fetches fresh (no permanently stale cache)", async () => {
    view = renderIntoBody(probes(2));
    await flush();
    view.unmount();
    view = null;

    apiGetMock.mockResolvedValue({ items: [{ item: { id: "movie-2" } }], nextCursor: null });
    view = renderIntoBody(probes(1));
    await flush();

    expect(watchlistCalls()).toHaveLength(2);
    expect([...(results.get(0)?.ids ?? [])]).toEqual(["movie-2"]);
  });

  it("d4-w1: a consumer arriving after a FAILED fetch retries it, even though nothing ever unmounted", async () => {
    // The Sidebar's watchlist count is mounted for the whole session, so the
    // listener set NEVER returns to 0 and the reset-on-last-unsubscribe path
    // that normally re-seeds the store cannot run. Before the fix the store
    // was therefore stuck on the failed (empty, not-loading) snapshot until a
    // full document reload: every WatchlistToggle rendered "not watchlisted".
    apiGetMock.mockRejectedValueOnce(new Error("network down"));
    view = renderIntoBody(probes(1)); // the always-mounted sidebar consumer
    await flush();

    expect(watchlistCalls()).toHaveLength(1);
    expect(results.get(0)?.ids.size).toBe(0);

    apiGetMock.mockResolvedValue({ items: [{ item: { id: "movie-5" } }], nextCursor: null });
    view.rerender(probes(2)); // a detail route mounts a WatchlistToggle
    await flush();

    expect(watchlistCalls()).toHaveLength(2);
    for (const id of [0, 1]) {
      expect([...(results.get(id)?.ids ?? [])]).toEqual(["movie-5"]);
    }
  });

  it("d4-w1: the retry re-enters loading, so no consumer renders the failed snapshot as settled truth", async () => {
    apiGetMock.mockRejectedValueOnce(new Error("network down"));
    view = renderIntoBody(probes(1));
    await flush();
    expect(results.get(0)?.loading).toBe(false);

    let resolvePage: ((page: unknown) => void) | null = null;
    apiGetMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    view.rerender(probes(2));

    // Sidebar count blanks and both toggles stay disabled while the retry is
    // in flight, rather than presenting the known-wrong empty set as fact.
    expect(results.get(0)?.loading).toBe(true);
    expect(results.get(1)?.loading).toBe(true);

    await act(async () => {
      resolvePage!({ items: [{ item: { id: "movie-5" } }], nextCursor: null });
      await Promise.resolve();
    });
    await flush();

    expect(results.get(0)?.loading).toBe(false);
    expect([...(results.get(0)?.ids ?? [])]).toEqual(["movie-5"]);
  });

  it("d4-w1: several consumers arriving together after a failure share ONE retry", async () => {
    apiGetMock.mockRejectedValueOnce(new Error("network down"));
    view = renderIntoBody(probes(1));
    await flush();

    view.rerender(probes(3)); // two new consumers in the same commit
    await flush();

    expect(watchlistCalls()).toHaveLength(2);
  });

  it("d4-w1: a consumer arriving after a SUCCESSFUL fetch still reuses it (the retry is failure-only)", async () => {
    view = renderIntoBody(probes(1));
    await flush();
    view.rerender(probes(2));
    await flush();
    view.rerender(probes(3));
    await flush();

    expect(watchlistCalls()).toHaveLength(1);
  });

  it("a StrictMode-style teardown-then-resubscribe while the fetch is in flight adopts it instead of firing a second one", async () => {
    let resolvePage: ((page: unknown) => void) | null = null;
    apiGetMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    view = renderIntoBody(probes(1));
    view.unmount(); // teardown before the request settles
    view = renderIntoBody(probes(1)); // immediate remount, same commit-pass shape

    expect(watchlistCalls()).toHaveLength(1);

    await act(async () => {
      resolvePage!({ items: [{ item: { id: "movie-3" } }], nextCursor: null });
      await Promise.resolve();
    });
    await flush();

    expect(watchlistCalls()).toHaveLength(1);
    expect([...(results.get(0)?.ids ?? [])]).toEqual(["movie-3"]);
  });
});
