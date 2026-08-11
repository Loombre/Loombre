// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/system-info.test.ts
//
// Item 7 (an upstream media server-study Wave A, /system/info triple-fetch): a single
// Dashboard load (app/admin/page.tsx) used to fire GET /system/info once
// per mounted consumer with zero sharing — DashboardHeader's own useEffect,
// components/admin/system/SystemInfoCard.tsx's own useEffect, and
// lib/storage-pool.ts's useStoragePool (consumed by Sidebar, which mounts
// in the app shell around every admin page) each ran an independent
// apiGet("/system/info"). useSystemInfo() is the ONE place that calls
// apiGet for this endpoint now; every consumer subscribes to a shared
// module-level cache + in-flight-promise de-dup instead of fetching for
// itself. This pins the de-dup directly (three simultaneous consumers, one
// underlying request) rather than re-deriving it from the full heavier
// Dashboard component tree.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../components/ui/test-render.js";

const apiGetMock = vi.fn();

vi.mock("./api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

const { useSystemInfo, resetSystemInfoCache } = await import("./system-info.js");

let lastSeen: { info: unknown; error: unknown } | null = null;
function Consumer({ enabled = true }: { enabled?: boolean }): null {
  lastSeen = useSystemInfo(enabled);
  return null;
}

describe("useSystemInfo — shared /system/info data layer (item 7)", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
    resetSystemInfoCache();
    lastSeen = null;
  });

  it("three simultaneously-mounted consumers share exactly ONE GET /system/info request", async () => {
    apiGetMock.mockResolvedValueOnce({ version: "1.2.3", uptimeMs: 60_000 });

    view = renderIntoBody(
      <>
        <Consumer />
        <Consumer />
        <Consumer />
      </>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith("/system/info");
  });

  it("every subscriber resolves to the same shared value", async () => {
    apiGetMock.mockResolvedValueOnce({ version: "9.9.9", uptimeMs: 1000 });

    view = renderIntoBody(<Consumer />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lastSeen?.info).toEqual({ version: "9.9.9", uptimeMs: 1000 });

    // A second consumer mounting AFTER the first has already resolved must
    // see the cached value immediately — no second request.
    view.rerender(
      <>
        <Consumer />
        <Consumer />
      </>,
    );
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(lastSeen?.info).toEqual({ version: "9.9.9", uptimeMs: 1000 });
  });

  it("a disabled (non-admin) consumer never fetches and always reports null", () => {
    view = renderIntoBody(<Consumer enabled={false} />);
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(lastSeen).toEqual({ info: null, error: null });
  });

  it("a failed fetch is reported as an error, not a silently-null info forever — a later mount can retry", async () => {
    apiGetMock.mockRejectedValueOnce(new Error("network down"));
    view = renderIntoBody(<Consumer />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lastSeen?.info).toBeNull();
    expect(lastSeen?.error).toBeInstanceOf(Error);

    apiGetMock.mockResolvedValueOnce({ version: "1.0.0", uptimeMs: 1 });
    view.rerender(<Consumer />);
    view.unmount();
    view = renderIntoBody(<Consumer />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(lastSeen?.info).toEqual({ version: "1.0.0", uptimeMs: 1 });
  });
});
