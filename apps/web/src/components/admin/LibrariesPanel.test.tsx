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

// d4-e6: the fake mirrors the real LoombreApiError's SHAPE, not just its
// identity. Every error the SDK throws carries an HTTP `status`, and the
// surfaces now read their copy through `apiErrorCopy` (lib/api-error-
// message.ts), which duck-types that status instead of the class — so a
// fake without one is not a stand-in for anything the app can receive, and
// a test built on it would prove nothing about the real path. 422 is the
// ordinary validation rejection; tests that need another Object.assign it.
class FakeApiError extends Error {
  status = 422;
}

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

  it("subscribes to scan.completed and probe.failed on the shared events socket on mount", async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});
    const subscribedTypes = subscribeMock.mock.calls.map(([type]) => type);
    expect(subscribedTypes).toContain("scan.started");
    expect(subscribedTypes).toContain("scan.completed");
    expect(subscribedTypes).toContain("probe.failed");
  });

  it('renders "N skipped (unsupported format)" with the file list when scan.completed carries skip data', async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    // scan.started first — the common live-watched flow. (A completion
    // WITHOUT a prior started also registers — Lane R review removed the
    // old known-library guard so a mid-scan-joining admin still sees the
    // note; the dedicated test below covers that path.)
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

  it("renders the skip disclosure from scan.completed ALONE — no prior scan.started (admin joined mid-scan; Lane R review)", async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    act(() => {
      scanCompletedHandler()!({
        id: "e1",
        type: "scan.completed",
        tsMs: 2,
        actorUserId: null,
        payload: {
          jobId: "job-9",
          libraryId: "lib-1",
          full: true,
          itemsAdded: 2,
          itemsUpdated: 0,
          itemsRemoved: 0,
          durationMs: 500,
          status: "succeeded",
          errorMessage: null,
          completedAtMs: 2,
          skippedUnsupportedCount: 1,
          skippedUnsupportedFiles: ["Old Broadcast.wtv"],
        },
      });
    });

    expect(view.container.textContent).toContain("1 skipped (unsupported format)");
    expect(view.container.textContent).toContain("Old Broadcast.wtv");
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

// Owner ledger L1, adjudication A-4/A-5(e): a probe.failed event (admin-
// only — packages/contract/event-schemas/probe.failed.schema.json) must
// surface as a visible "N failed inspection (unreadable media)"
// disclosure, session-scoped and separate from the H3 skip disclosure
// above (they describe DIFFERENT things: an EXCLUDED extension the
// scanner never admitted at all, vs. an ADMITTED file that turned out
// unreadable once a real probe ran against it — see this lane's freeze
// report for the full "scan.completed stays untouched" rationale).
describe("LibrariesPanel — probe-failure visibility (owner ledger L1, A-4/A-5e)", () => {
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

  function probeFailedHandler(): ((event: unknown) => void) | undefined {
    return subscribeMock.mock.calls.find(([type]) => type === "probe.failed")?.[1] as
      | ((event: unknown) => void)
      | undefined;
  }

  function emitProbeFailed(mediaFileId: string, path: string, code = "nonzero-exit"): void {
    probeFailedHandler()!({
      id: `pf-${mediaFileId}`,
      type: "probe.failed",
      tsMs: 1,
      actorUserId: null,
      payload: { mediaFileId, libraryId: "lib-1", path, code },
    });
  }

  it("renders no probe-failure disclosure when no probe.failed event has been observed this session", async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    expect(view.container.textContent).not.toContain("failed inspection");
  });

  it('accumulates probe.failed events into a "N failed inspection (unreadable media)" disclosure with the path list', async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    act(() => {
      emitProbeFailed("file-1", "Fake Camcorder Clip.mts");
    });
    act(() => {
      emitProbeFailed("file-2", "Another Garbage File.mkv");
    });

    expect(view.container.textContent).toContain("2 failed inspection (unreadable media)");
    expect(view.container.textContent).toContain("Fake Camcorder Clip.mts");
    expect(view.container.textContent).toContain("Another Garbage File.mkv");
  });

  it("caps the accumulated list at 100 entries (session-scoped ring buffer)", async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    for (let i = 0; i < 105; i++) {
      act(() => {
        emitProbeFailed(`file-${i}`, `Garbage ${i}.mts`);
      });
    }

    expect(view.container.textContent).toContain("100 failed inspection (unreadable media)");
  });

  it("only accumulates events for the library they name (per-library, like the skip disclosure)", async () => {
    view = renderIntoBody(<LibrariesPanel />);
    await act(async () => {});

    act(() => {
      probeFailedHandler()!({
        id: "pf-other-lib",
        type: "probe.failed",
        tsMs: 1,
        actorUserId: null,
        payload: { mediaFileId: "file-x", libraryId: "lib-does-not-exist", path: "Elsewhere.mts", code: "nonzero-exit" },
      });
    });

    // The panel only ever renders rows for libraries the /libraries list
    // returned (lib-1) — an event naming an unknown library simply never
    // renders, the same "unknown libraryId never renders" behavior the H3
    // skip disclosure already relies on (admin-dashboard-live.ts).
    expect(view.container.textContent).not.toContain("Elsewhere.mts");
  });
});
