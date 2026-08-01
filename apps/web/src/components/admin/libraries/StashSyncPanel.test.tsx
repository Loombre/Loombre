// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/libraries/StashSyncPanel.test.tsx
//
// STATE.md FIX WAVE FX1: sync controls (POST .../stash-sync) + the sync
// report viewer (GET .../stash-sync-report), including the honest
// "never synced yet" ({report: null}) empty state, the disabled-connection
// gate, and the live stash.sync.started/completed refresh. apiGet/apiPost
// and getEventsSocket are mocked (StreamsPanel.test.tsx's established
// convention).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type AdminStashConnection = components["schemas"]["AdminStashConnection"];

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { StashSyncPanel } = await import("./StashSyncPanel.js");

function connection(overrides: Partial<AdminStashConnection> = {}): AdminStashConnection {
  return {
    libraryId: "lib-1",
    configured: true,
    sqlitePath: "/data/stash.sqlite",
    enabled: true,
    genreTagNames: null,
    status: "ok",
    statusDetail: null,
    lastSeenSchemaVersion: 80,
    lastConnectedAtMs: 1,
    lastCheckedAtMs: 1,
    ...overrides,
  };
}

function emptyEnvelope() {
  return { report: null, unmatchedScenes: { items: [], nextCursor: null }, staleScenes: { items: [], nextCursor: null } };
}

function reportEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    report: {
      jobId: "job-1",
      mode: "full",
      status: "succeeded",
      matchedCount: 10,
      updatedCount: 4,
      unmatchedCount: 2,
      staleCount: 1,
      skippedCount: 0,
      startedAtMs: 1000,
      finishedAtMs: 2000,
    },
    unmatchedScenes: { items: [{ stashSceneId: "s1", stashPath: "/data/a.mp4", stashUpdatedAtMs: 500 }], nextCursor: "cursor-1" },
    staleScenes: { items: [], nextCursor: null },
    ...overrides,
  };
}

function startedHandler(): ((event: unknown) => void) | undefined {
  return subscribeMock.mock.calls.find(([type]) => type === "stash.sync.started")?.[1] as ((event: unknown) => void) | undefined;
}

function completedHandler(): ((event: unknown) => void) | undefined {
  return subscribeMock.mock.calls.find(([type]) => type === "stash.sync.completed")?.[1] as ((event: unknown) => void) | undefined;
}

describe("StashSyncPanel", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it('shows "Never synced yet" when report is null', async () => {
    apiGetMock.mockResolvedValue(emptyEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});
    expect(view.container.textContent).toContain("Never synced yet");
  });

  it("renders the five counts, mode, and status from a real report", async () => {
    apiGetMock.mockResolvedValue(reportEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});
    expect(view.container.textContent).toContain("Succeeded");
    expect(view.container.textContent).toContain("full");
    const dds = Array.from(view.container.querySelectorAll("dd")).map((d) => d.textContent);
    expect(dds).toEqual(["10", "4", "2", "1", "0"]);
  });

  it("renders the unmatched scenes list with a Load more button when nextCursor is present", async () => {
    apiGetMock.mockResolvedValue(reportEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});
    expect(view.container.textContent).toContain("/data/a.mp4");
    const loadMore = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Load more");
    expect(loadMore).not.toBeUndefined();
  });

  it('shows "No stale scenes." for the stale list when it is empty', async () => {
    apiGetMock.mockResolvedValue(reportEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});
    expect(view.container.textContent).toContain("No stale scenes.");
  });

  it("Load more appends to the unmatched list using its own cursor, without disturbing the stale list", async () => {
    apiGetMock.mockResolvedValueOnce(reportEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});

    apiGetMock.mockResolvedValueOnce({
      report: reportEnvelope().report,
      unmatchedScenes: { items: [{ stashSceneId: "s2", stashPath: "/data/b.mp4", stashUpdatedAtMs: null }], nextCursor: null },
      staleScenes: { items: [{ stashSceneId: "gone", stashPath: "/should/not/appear", stashUpdatedAtMs: null }], nextCursor: null },
    });

    const loadMore = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Load more") as HTMLButtonElement;
    await act(async () => loadMore.click());

    expect(apiGetMock).toHaveBeenLastCalledWith(
      "/admin/libraries/{id}/stash-sync-report",
      expect.objectContaining({ params: expect.objectContaining({ query: { unmatchedCursor: "cursor-1" } }) }),
    );
    expect(view.container.textContent).toContain("/data/a.mp4");
    expect(view.container.textContent).toContain("/data/b.mp4");
    // The stale list's own (already-loaded, empty) state is untouched by
    // an unmatched-list load-more response.
    expect(view.container.textContent).not.toContain("/should/not/appear");
  });

  it("disables both sync buttons and explains why when the connection is not configured", async () => {
    apiGetMock.mockResolvedValue(emptyEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection({ configured: false, enabled: false })} />);
    await act(async () => {});
    const buttons = Array.from(view.container.querySelectorAll("button")).filter((b) => /sync/i.test(b.textContent ?? ""));
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(view.container.textContent).toContain("Configure a Stash connection first");
  });

  it("disables both sync buttons and explains why when the connection is disabled", async () => {
    apiGetMock.mockResolvedValue(emptyEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection({ enabled: false })} />);
    await act(async () => {});
    const fullButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Full sync")) as HTMLButtonElement;
    expect(fullButton.disabled).toBe(true);
    expect(view.container.textContent).toContain("This connection is disabled");
  });

  it("clicking Full sync POSTs mode:full and surfaces the returned job id with a Jobs link", async () => {
    apiGetMock.mockResolvedValue(emptyEnvelope());
    apiPostMock.mockResolvedValue({ jobId: "11111111-1111-7111-8111-111111111111" });
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});

    const fullButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Full sync")) as HTMLButtonElement;
    await act(async () => fullButton.click());

    expect(apiPostMock).toHaveBeenCalledWith(
      "/admin/libraries/{id}/stash-sync",
      expect.objectContaining({ body: { mode: "full" } }),
    );
    expect(view.container.textContent).toContain("11111111-1111-7111-8111-111111111111");
    expect(view.container.querySelector('a[href="/admin/jobs"]')).not.toBeNull();
  });

  it("subscribes to stash.sync.started/completed on mount", async () => {
    apiGetMock.mockResolvedValue(emptyEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});
    const types = subscribeMock.mock.calls.map(([type]) => type);
    expect(types).toContain("stash.sync.started");
    expect(types).toContain("stash.sync.completed");
  });

  it("a started event for this library shows the live Syncing badge; ignores events for other libraries", async () => {
    apiGetMock.mockResolvedValue(emptyEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});

    act(() => {
      startedHandler()!({ payload: { jobId: "job-x", libraryId: "some-other-lib", mode: "full", startedAtMs: 1 } });
    });
    expect(view.container.textContent).not.toContain("Syncing");

    act(() => {
      startedHandler()!({ payload: { jobId: "job-x", libraryId: "lib-1", mode: "full", startedAtMs: 1 } });
    });
    expect(view.container.textContent).toContain("Syncing");
  });

  it("a completed event for this library clears the live badge and refetches the report", async () => {
    apiGetMock.mockResolvedValueOnce(emptyEnvelope());
    view = renderIntoBody(<StashSyncPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {});

    act(() => {
      startedHandler()!({ payload: { jobId: "job-x", libraryId: "lib-1", mode: "full", startedAtMs: 1 } });
    });
    expect(view.container.textContent).toContain("Syncing");

    apiGetMock.mockResolvedValueOnce(reportEnvelope());
    await act(async () => {
      completedHandler()!({ payload: { jobId: "job-x", libraryId: "lib-1", mode: "full", status: "succeeded" } });
    });

    expect(view.container.textContent).not.toContain("Syncing");
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("Succeeded");
  });
});
