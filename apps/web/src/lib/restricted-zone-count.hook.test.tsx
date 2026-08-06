// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/restricted-zone-count.hook.test.tsx
//
// AUD-A4v6-003 regression guard: useRestrictedZoneCount is mounted by ~7
// shell surfaces at once on every authenticated page (Sidebar, UserMenu,
// QuickSearch, MobileTabBar, RestrictedLockControl,
// RestrictedZoneBrowseChip, the /restricted route components) — the hook
// must share ONE in-flight GET /restricted/count and ONE result across all
// of them, not fire one request (and log one grouped console error) per
// mount site. The audited build fired 21 identical requests per page load.
//
// This file is the component-render half of the module's coverage; the
// pure entitlement predicate stays covered in restricted-zone-count.test.ts
// (see that file's header for why it needs no harness).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../components/ui/test-render.js";

const apiGetMock = vi.fn();

vi.mock("./api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

let authenticated = true;
const authListeners = new Set<() => void>();

vi.mock("./auth-store.js", () => ({
  getAuthStore: () => ({
    isAuthenticated: () => authenticated,
    subscribe: (listener: () => void) => {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  }),
}));

// Imported AFTER the mocks above so the module under test picks them up.
const { useRestrictedZoneCount } = await import("./restricted-zone-count.js");
type HookResult = ReturnType<typeof useRestrictedZoneCount>;

/** Each Probe writes its latest hook result here, keyed by mount id, so a
 *  test can assert every consumer sees the SAME shared result. */
const results = new Map<number, HookResult>();

function Probe({ id }: { id: number }): null {
  results.set(id, useRestrictedZoneCount());
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useRestrictedZoneCount (shared cache / request coalescing)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    authenticated = true;
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    results.clear();
    authListeners.clear();
  });

  it("N concurrently mounted consumers share ONE request and its result (7 mount sites must not mean 7 GETs)", async () => {
    apiGetMock.mockResolvedValue({ count: 4 });
    view = renderIntoBody(probes(3));
    await flush();
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    for (const id of [0, 1, 2]) {
      expect(results.get(id)).toEqual({ count: 4, loading: false });
    }
  });

  it("a consumer mounting AFTER the shared result arrived reuses it without another fetch", async () => {
    apiGetMock.mockResolvedValue({ count: 2 });
    view = renderIntoBody(probes(2));
    await flush();
    view.rerender(probes(3));
    await flush();
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(results.get(2)).toEqual({ count: 2, loading: false });
  });

  it("an auth-store change triggers exactly ONE shared refetch, not one per consumer, and the new result reaches every consumer", async () => {
    apiGetMock.mockResolvedValue({ count: 1 });
    view = renderIntoBody(probes(3));
    await flush();
    apiGetMock.mockResolvedValue({ count: 5 });
    await act(async () => {
      for (const listener of [...authListeners]) listener();
    });
    await flush();
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    for (const id of [0, 1, 2]) {
      expect(results.get(id)).toEqual({ count: 5, loading: false });
    }
  });

  it("never fetches while unauthenticated — every consumer resolves to the no-entitlement shape", async () => {
    authenticated = false;
    view = renderIntoBody(probes(2));
    await flush();
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(results.get(0)).toEqual({ count: null, loading: false });
    expect(results.get(1)).toEqual({ count: null, loading: false });
  });

  it("one failed shared fetch folds to count:null for every consumer (fail closed, never a fabricated number)", async () => {
    apiGetMock.mockRejectedValue(new Error("network down"));
    view = renderIntoBody(probes(3));
    await flush();
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    for (const id of [0, 1, 2]) {
      expect(results.get(id)).toEqual({ count: null, loading: false });
    }
  });

  it("after every consumer unmounts, the next mount fetches fresh (no permanently stale cache)", async () => {
    apiGetMock.mockResolvedValue({ count: 3 });
    view = renderIntoBody(probes(2));
    await flush();
    view.unmount();
    view = null;
    apiGetMock.mockResolvedValue({ count: 7 });
    view = renderIntoBody(probes(1));
    await flush();
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(results.get(0)).toEqual({ count: 7, loading: false });
  });
});
