// SPDX-License-Identifier: AGPL-3.0-only

// Regression coverage for the `error` / `loadMoreError` split: before this,
// a failed page-2+ append set the SAME `error` field an initial-load failure
// does, and both /browse and /watchlist rendered any non-null `error` as a
// full replacement of the already-rendered grid — a transient mid-scroll
// network blip discarded everything the user had already loaded. See this
// file's header for the two states' contract.

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useCursorFeed, type CursorPage, type UseCursorFeedResult } from "./useCursorFeed.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

interface Item {
  id: string;
}

let lastResult: UseCursorFeedResult<Item> | null = null;

function Probe({
  fetchPage,
  resetKey,
}: {
  fetchPage: (cursor: string | null) => Promise<CursorPage<Item>>;
  resetKey: string | null;
}): null {
  lastResult = useCursorFeed<Item>(fetchPage, resetKey);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useCursorFeed", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    lastResult = null;
  });

  it("initial-load failure sets `error`, not `loadMoreError`", async () => {
    const fetchPage = (): Promise<CursorPage<Item>> => Promise.reject(new Error("network down"));
    view = renderIntoBody(<Probe fetchPage={fetchPage} resetKey="k1" />);
    await flush();

    expect(lastResult!.error).toBe("network down");
    expect(lastResult!.loadMoreError).toBeNull();
    expect(lastResult!.items).toEqual([]);
  });

  it("a failed loadMore sets `loadMoreError` and leaves the already-loaded items and `error` alone", async () => {
    let call = 0;
    const fetchPage = (cursor: string | null): Promise<CursorPage<Item>> => {
      call += 1;
      if (call === 1) {
        expect(cursor).toBeNull();
        return Promise.resolve({ items: [{ id: "a" }, { id: "b" }], nextCursor: "page-2" });
      }
      return Promise.reject(new Error("page 2 failed"));
    };
    view = renderIntoBody(<Probe fetchPage={fetchPage} resetKey="k1" />);
    await flush();
    expect(lastResult!.items).toEqual([{ id: "a" }, { id: "b" }]);
    expect(lastResult!.hasMore).toBe(true);

    act(() => {
      lastResult!.loadMore();
    });
    await flush();

    expect(lastResult!.error).toBeNull();
    expect(lastResult!.loadMoreError).toBe("page 2 failed");
    // The already-rendered page survives a failed append.
    expect(lastResult!.items).toEqual([{ id: "a" }, { id: "b" }]);
    // Untouched on failure — cursor/hasMore stay put so a retry (calling
    // loadMore again) resumes from the same page rather than restarting.
    expect(lastResult!.hasMore).toBe(true);
  });

  it("retrying loadMore after a failure clears loadMoreError and appends on success", async () => {
    let call = 0;
    const fetchPage = (): Promise<CursorPage<Item>> => {
      call += 1;
      if (call === 1) return Promise.resolve({ items: [{ id: "a" }], nextCursor: "page-2" });
      if (call === 2) return Promise.reject(new Error("transient"));
      return Promise.resolve({ items: [{ id: "b" }], nextCursor: null });
    };
    view = renderIntoBody(<Probe fetchPage={fetchPage} resetKey="k1" />);
    await flush();

    act(() => {
      lastResult!.loadMore();
    });
    await flush();
    expect(lastResult!.loadMoreError).toBe("transient");

    act(() => {
      lastResult!.loadMore();
    });
    await flush();

    expect(lastResult!.loadMoreError).toBeNull();
    expect(lastResult!.items).toEqual([{ id: "a" }, { id: "b" }]);
    expect(lastResult!.hasMore).toBe(false);
  });
});
