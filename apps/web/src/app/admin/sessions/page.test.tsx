// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/admin/sessions/page.test.tsx
//
// confirmed[32] regression coverage: this standalone Sessions page did a
// one-time GET /admin/sessions on mount and never live-updated — a session
// starting or ending elsewhere was invisible short of a manual reload,
// unlike StreamsPanel.tsx's sibling dashboard panel (see that file's
// header for the full reasoning this page now mirrors). apiGet and
// getEventsSocket are mocked, same convention as app/home/page.test.tsx
// and StreamsPanel.test.tsx.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";

const apiGetMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { default: AdminSessionsPage } = await import("./page.js");
const { ADMIN_SESSIONS_REFRESH_MS } = await import("../../../lib/admin-live-refresh.js");

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

describe("AdminSessionsPage — live refresh (confirmed[32])", () => {
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
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});

    const subscribedTypes = subscribeMock.mock.calls.map(([type]) => type);
    expect(subscribedTypes).toContain("playback.started");
    expect(subscribedTypes).toContain("playback.ended");
  });

  it("refetches page 1 (silently — no skeleton re-flash) when a playback.ended event arrives", async () => {
    vi.useFakeTimers();
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Arrival");

    const endedHandler = subscribeMock.mock.calls.find(([type]) => type === "playback.ended")?.[1] as
      | ((event: unknown) => void)
      | undefined;
    expect(endedHandler).toBeTypeOf("function");

    apiGetMock.mockResolvedValueOnce({ items: [], nextCursor: null });
    act(() => {
      endedHandler!({
        id: "e1",
        type: "playback.ended",
        tsMs: 1,
        actorUserId: null,
        payload: { sessionId: "s1", itemId: "44444444-4444-7444-8444-444444444444", deviceId: "33333333-3333-7333-8333-333333333333", reason: "completed", errorCode: null, finalPositionMs: null, endedAtMs: 1 },
      });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {});

    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("No active sessions");
  });
});

// ---------------------------------------------------------------------------
// browser-admin-F2 (QA 2026-08-20/21, P1): the segment-ahead throttle flips
// a live transcode between `suspended` and `active` every few tens of
// seconds and emits NO event, so this page's socket-only refresh left an
// open tab showing a status that stopped being true minutes ago (and, with
// the old query filter, showed "No active sessions" throughout).
// ---------------------------------------------------------------------------
describe("AdminSessionsPage — suspended sessions (browser-admin-F2)", () => {
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

  it("renders the Suspended status pill for a throttle-suspended session", async () => {
    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "suspended", plan: { decision: "transcode" } })],
      nextCursor: null,
    });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Arrival");
    expect(view.container.textContent).toContain("Suspended");
  });

  it("refetches page 1 on a periodic tick with NO socket event, so a suspended->active flip surfaces without a reload", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "suspended", plan: { decision: "transcode" } })],
      nextCursor: null,
    });
    view = renderIntoBody(<AdminSessionsPage />);
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
    expect(view.container.textContent).not.toContain("Suspended");
  });

  it("stops the periodic tick on unmount", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({ items: [session("s1")], nextCursor: null });
    view = renderIntoBody(<AdminSessionsPage />);
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
// d3-e2 (E/admin-error-surfaces): the last two surfaces still deriving their
// user-facing text from `err instanceof LoombreApiError ? err.message :
// fallback` — see StreamsPanel.test.tsx's companion block for the full note.
// ---------------------------------------------------------------------------
describe("AdminSessionsPage — error copy (d3-e2)", () => {
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

  it("shows the RFC 9457 detail, not the status title, when the initial load fails", async () => {
    apiGetMock.mockRejectedValue(
      Object.assign(new FakeApiError("Forbidden"), {
        status: 403,
        problem: { type: "urn:loombre:problem:forbidden", title: "Forbidden", status: 403, detail: "Your admin session expired — sign in again." },
      }),
    );
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Your admin session expired — sign in again.");
    expect(view.container.textContent).not.toContain("Forbidden");
  });

  it("falls back to the page's own copy when the error carries neither detail nor message", async () => {
    apiGetMock.mockRejectedValue({});
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Failed to load sessions.");
  });
});
