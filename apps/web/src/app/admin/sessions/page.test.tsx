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

function session(id: string) {
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
