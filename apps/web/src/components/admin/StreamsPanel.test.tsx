// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/StreamsPanel.test.tsx
//
// confirmed[32] regression coverage: unlike JobsPanel/LibrariesPanel, this
// panel used to do a one-shot GET /admin/sessions and never live-update.
// apiGet and getEventsSocket are mocked (AccountSection.test.tsx's
// established apiGet-mocking convention, extended to the shared socket) so
// this can assert the subscription exists and that an event triggers a
// refetch, without a real network call or WebSocket connection.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const apiGetMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { StreamsPanel } = await import("./StreamsPanel.js");
const { ADMIN_SESSIONS_REFRESH_MS } = await import("../../lib/admin-live-refresh.js");

function session(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: "22222222-2222-7222-8222-222222222222",
    username: "ada",
    deviceId: "33333333-3333-7333-8333-333333333333",
    deviceName: "Living Room TV",
    itemId: "44444444-4444-7444-8444-444444444444",
    itemTitle: "Arrival",
    contentHidden: false,
    status: "active",
    startedAtMs: 0,
    updatedAtMs: 0,
    lastHeartbeatMs: 0,
    plan: { decision: "direct-play" },
    ...overrides,
  };
}

describe("StreamsPanel — live refresh (confirmed[32])", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
    apiGetMock.mockResolvedValue({ items: [session("s1")], nextCursor: null });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it("subscribes to playback.started and playback.ended on the shared events socket on mount", async () => {
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});

    const subscribedTypes = subscribeMock.mock.calls.map(([type]) => type);
    expect(subscribedTypes).toContain("playback.started");
    expect(subscribedTypes).toContain("playback.ended");
  });

  it("refetches GET /admin/sessions when a playback.started event arrives — no manual reload needed", async () => {
    vi.useFakeTimers();
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Active streams · 1");

    const startedHandler = subscribeMock.mock.calls.find(([type]) => type === "playback.started")?.[1] as
      | ((event: unknown) => void)
      | undefined;
    expect(startedHandler).toBeTypeOf("function");

    apiGetMock.mockResolvedValueOnce({ items: [session("s1"), session("s2")], nextCursor: null });
    act(() => {
      startedHandler!({
        id: "e1",
        type: "playback.started",
        tsMs: 1,
        actorUserId: null,
        payload: { sessionId: "s2", itemId: "44444444-4444-7444-8444-444444444444", deviceId: "33333333-3333-7333-8333-333333333333", decision: "direct-play", startedAtMs: 1 },
      });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {});

    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("Active streams · 2");
  });
});

// ---------------------------------------------------------------------------
// browser-admin-F2 (QA 2026-08-20/21, P1): while the segment-ahead throttle
// held a real transcode suspended (most of a steady-state 4K stream), this
// panel showed "Active streams · 0" — and once the query started returning
// those rows, the panel still had no way to SAY a stream is suspended, nor
// any way to notice the suspended->active flip (the throttle emits no
// event, so the socket subscription above never fires for it).
// ---------------------------------------------------------------------------
describe("StreamsPanel — suspended streams (browser-admin-F2)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it("renders the session status alongside the mode badge, so a throttle-suspended transcode reads as Suspended (not as a missing row)", async () => {
    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "suspended", plan: { decision: "transcode" } })],
      nextCursor: null,
    });
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Active streams · 1");
    expect(view.container.textContent).toContain("TRANSCODE");
    expect(view.container.textContent).toContain("Suspended");
  });

  it("refetches on a periodic tick with NO socket event, so a suspended->active transition stops being invisible until a manual reload", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "suspended", plan: { decision: "transcode" } })],
      nextCursor: null,
    });
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Suspended");

    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "active", plan: { decision: "transcode" } })],
      nextCursor: null,
    });
    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS);
    });
    await act(async () => {});

    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("Active");
    expect(view.container.textContent).not.toContain("Suspended");
  });

  it("stops the periodic tick on unmount", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({ items: [session("s1")], nextCursor: null });
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    view.unmount();
    view = null;
    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS * 3);
    });
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// d3-e3 (browser-admin-F2 follow-up, P2): with every non-terminal status now
// listed, a viewer who walked away occupied "Active streams · 1" with a
// Suspended pill for the ~13.5 minutes between the sweeper's 90s suspend and
// its 15-minute end — indistinguishable from the segment-ahead throttle
// parking a stream someone IS watching. Proven live 2026-08-24 on a
// never-heartbeated session ("DIRECT PLAY / The Commitment / Suspended",
// nobody watching).
// ---------------------------------------------------------------------------
describe("StreamsPanel — abandoned vs parked (d3-e3)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it("a heartbeat-stale session is labelled No heartbeat and drops out of the Active streams count", async () => {
    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "suspended", suspendedByThrottle: false, heartbeatStale: true })],
      nextCursor: null,
    });
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Active streams · 0");
    expect(view.container.textContent).toContain("No heartbeat");
    expect(view.container.textContent).not.toContain("Suspended");
    // The row itself is still rendered — it exists, and an admin may want
    // to act on it; only the "someone is watching" claim is withdrawn.
    expect(view.container.textContent).toContain("Arrival");
  });

  it("a throttle-parked transcode still counts as live and says so in its own words", async () => {
    apiGetMock.mockResolvedValue({
      items: [
        session("s1", {
          status: "suspended",
          suspendedByThrottle: true,
          heartbeatStale: false,
          plan: { decision: "transcode" },
        }),
      ],
      nextCursor: null,
    });
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Active streams · 1");
    expect(view.container.textContent).toContain("TRANSCODE");
    expect(view.container.textContent).toContain("Buffered ahead");
    expect(view.container.textContent).not.toContain("Suspended");
  });
});

// ---------------------------------------------------------------------------
// d3-e2 (E/admin-error-surfaces): this panel was one of the last two surfaces
// still deriving its user-facing text from `err instanceof LoombreApiError ?
// err.message : fallback` instead of the shared apiErrorMessage() helper
// (browser-admin-F5's house pattern). The real LoombreApiError is detail-first
// since 73eed8e, so the rendered string happened to be right — but only
// because of the SDK, and only for that one class: anything that merely
// duck-types the problem shape (every fake in these specs, and any error the
// SDK ever wraps) fell through to the generic fallback.
// ---------------------------------------------------------------------------
describe("StreamsPanel — error copy (d3-e2)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it("shows the RFC 9457 detail, not the status title, when GET /admin/sessions fails", async () => {
    apiGetMock.mockRejectedValue(
      Object.assign(new FakeApiError("Forbidden"), {
        status: 403,
        problem: { type: "urn:loombre:problem:forbidden", title: "Forbidden", status: 403, detail: "Your admin session expired — sign in again." },
      }),
    );
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Your admin session expired — sign in again.");
    expect(view.container.textContent).not.toContain("Forbidden");
  });

  it("falls back to the panel's own copy when the error carries neither detail nor message", async () => {
    apiGetMock.mockRejectedValue({});
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Failed to load active streams.");
  });
});

// ---------------------------------------------------------------------------
// d3-e5 (E/browser-admin-F2-followup): the periodic tick was the ONLY way
// this panel learned about a suspend/resume/seek, because no domain event
// existed for a playback session status transition. It does now
// (packages/contract/event-schemas/playback.session-status-changed.schema.json,
// admin-only delivery) — the tick stays underneath as a fallback, at a
// relaxed cadence, but a live transition must reach the pill immediately and
// WITHOUT a refetch.
// ---------------------------------------------------------------------------
describe("StreamsPanel — live status transitions (d3-e5)", () => {
  let view: TestRender | null = null;

  function statusHandler(): (event: unknown) => void {
    const handler = subscribeMock.mock.calls.find(([type]) => type === "playback.session-status-changed")?.[1] as
      | ((event: unknown) => void)
      | undefined;
    expect(handler).toBeTypeOf("function");
    return handler!;
  }

  function envelope(payload: Record<string, unknown>): unknown {
    return { id: "e9", type: "playback.session-status-changed", tsMs: 1, actorUserId: null, payload };
  }

  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "active", plan: { decision: "transcode" } })],
      nextCursor: null,
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it("subscribes to playback.session-status-changed on the shared events socket", async () => {
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});
    expect(subscribeMock.mock.calls.map(([type]) => type)).toContain("playback.session-status-changed");
  });

  it("patches the pill from the event alone — the throttle parking a stream needs no refetch", async () => {
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Active streams · 1");

    await act(async () => {
      statusHandler()(
        envelope({
          sessionId: "s1",
          previousStatus: "active",
          status: "suspended",
          suspendedByThrottle: true,
          reason: "throttle-suspend",
          changedAtMs: 1_700_000_060_000,
        }),
      );
    });

    expect(view.container.textContent).toContain("Buffered ahead");
    expect(view.container.textContent).toContain("Active streams · 1");
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it("refetches when the transition is for a session this panel has never seen", async () => {
    vi.useFakeTimers();
    view = renderIntoBody(<StreamsPanel />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    act(() => {
      statusHandler()(
        envelope({
          sessionId: "s-unknown",
          previousStatus: "starting",
          status: "active",
          suspendedByThrottle: false,
          reason: "pipeline-active",
          changedAtMs: 2,
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {});

    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });
});
