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
