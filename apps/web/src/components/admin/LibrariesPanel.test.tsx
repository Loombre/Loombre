// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/LibrariesPanel.test.tsx
//
// STATE.md H3 regression coverage: a scan.completed event carrying
// skippedUnsupportedCount/skippedUnsupportedFiles (packages/contract/
// event-schemas/scan.completed.schema.json's H3 optional/additive fields —
// known-media-but-excluded-in-v1 extensions, ape/wv/wma) must surface as a
// visible "N skipped (unsupported format)" disclosure in this panel — the
// payload alone is not enough (owner brief: "silent non-ingestion is
// forbidden"). apiGet/apiPost and getEventsSocket are mocked (StreamsPanel.
// test.tsx's established convention), so this exercises the REAL
// admin-dashboard-live.ts hook against a fake socket, without a network
// call or WebSocket connection.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { LibrariesPanel } = await import("./LibrariesPanel.js");

function library(id: string) {
  return {
    id,
    name: "Legacy Movies",
    mediaKind: "movie",
    paths: ["/media/legacy"],
    contentClass: "general",
    createdAtMs: 0,
    updatedAtMs: 0,
    itemCount: 12,
  };
}

describe("LibrariesPanel — skip-visibility (STATE.md H3)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/libraries") return Promise.resolve({ items: [library("lib-1")], nextCursor: null });
      if (path === "/admin/libraries/{id}/unmatched") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function scanCompletedHandler(): ((event: unknown) => void) | undefined {
    return subscribeMock.mock.calls.find(([type]) => type === "scan.completed")?.[1] as
      | ((event: unknown) => void)
      | undefined;
  }

  function scanStartedHandler(): ((event: unknown) => void) | undefined {
    return subscribeMock.mock.calls.find(([type]) => type === "scan.started")?.[1] as
      | ((event: unknown) => void)
      | undefined;
  }

  it("subscribes to scan.completed on the shared events socket on mount", async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});
    const subscribedTypes = subscribeMock.mock.calls.map(([type]) => type);
    expect(subscribedTypes).toContain("scan.started");
    expect(subscribedTypes).toContain("scan.completed");
  });

  it('renders "N skipped (unsupported format)" with the file list when scan.completed carries skip data', async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    // scan.started first (admin-dashboard-live.ts correlates jobId->libraryId
    // via this event — scan.completed alone, without a prior scan.started
    // for the SAME libraryId already known to the map, is a no-op by design).
    act(() => {
      scanStartedHandler()!({
        id: "e0",
        type: "scan.started",
        tsMs: 1,
        actorUserId: null,
        payload: { jobId: "job-1", libraryId: "lib-1", full: true, startedAtMs: 1 },
      });
    });

    act(() => {
      scanCompletedHandler()!({
        id: "e1",
        type: "scan.completed",
        tsMs: 2,
        actorUserId: null,
        payload: {
          jobId: "job-1",
          libraryId: "lib-1",
          full: true,
          itemsAdded: 2,
          itemsUpdated: 0,
          itemsRemoved: 0,
          durationMs: 500,
          status: "succeeded",
          errorMessage: null,
          completedAtMs: 2,
          skippedUnsupportedCount: 2,
          skippedUnsupportedFiles: ["Old Movie.wma", "Older Movie.ape"],
        },
      });
    });

    expect(view.container.textContent).toContain("2 skipped (unsupported format)");
    expect(view.container.textContent).toContain("Old Movie.wma");
    expect(view.container.textContent).toContain("Older Movie.ape");
  });

  it("renders no skip disclosure when scan.completed reports zero skips", async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    act(() => {
      scanStartedHandler()!({
        id: "e0",
        type: "scan.started",
        tsMs: 1,
        actorUserId: null,
        payload: { jobId: "job-2", libraryId: "lib-1", full: true, startedAtMs: 1 },
      });
    });

    act(() => {
      scanCompletedHandler()!({
        id: "e1",
        type: "scan.completed",
        tsMs: 2,
        actorUserId: null,
        payload: {
          jobId: "job-2",
          libraryId: "lib-1",
          full: true,
          itemsAdded: 1,
          itemsUpdated: 0,
          itemsRemoved: 0,
          durationMs: 500,
          status: "succeeded",
          errorMessage: null,
          completedAtMs: 2,
          skippedUnsupportedCount: 0,
          skippedUnsupportedFiles: [],
        },
      });
    });

    expect(view.container.textContent).not.toContain("skipped (unsupported format)");
  });

  it("renders no skip disclosure when scan.completed omits the H3 fields entirely (pre-H3 payload)", async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    act(() => {
      scanStartedHandler()!({
        id: "e0",
        type: "scan.started",
        tsMs: 1,
        actorUserId: null,
        payload: { jobId: "job-3", libraryId: "lib-1", full: true, startedAtMs: 1 },
      });
    });

    act(() => {
      scanCompletedHandler()!({
        id: "e1",
        type: "scan.completed",
        tsMs: 2,
        actorUserId: null,
        payload: {
          jobId: "job-3",
          libraryId: "lib-1",
          full: true,
          itemsAdded: 1,
          itemsUpdated: 0,
          itemsRemoved: 0,
          durationMs: 500,
          status: "succeeded",
          errorMessage: null,
          completedAtMs: 2,
        },
      });
    });

    expect(view.container.textContent).not.toContain("skipped (unsupported format)");
  });
});
