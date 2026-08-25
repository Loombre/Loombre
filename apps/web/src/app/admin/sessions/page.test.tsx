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
// d3-e4 (browser-admin-F2 follow-up, P3): refreshFirstPageSilently replaced
// the whole list with page 1 on every 10s tick, so with more than PAGE_LIMIT
// live rows every "Load more" page an admin opened was discarded within ten
// seconds — and the tick kept firing at the same cadence while the tab was
// in the background (verified backgrounded at exactly 10s).
// ---------------------------------------------------------------------------
describe("AdminSessionsPage — silent refresh vs pagination (d3-e4)", () => {
  let view: TestRender | null = null;
  let hidden = false;

  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  /** 50 rows, newest first — exactly what a full page 1 looks like. */
  function fullFirstPage(): ReturnType<typeof session>[] {
    return Array.from({ length: 50 }, (_, i) => session(`s${i}`, { startedAtMs: 10_000 - i, itemTitle: `Movie ${i}` }));
  }

  function installPagedMock(): void {
    apiGetMock.mockImplementation((_path: string, options: { params: { query: Record<string, unknown> } }) => {
      if (options.params.query["cursor"] === undefined) {
        return Promise.resolve({ items: fullFirstPage(), nextCursor: "cursor-page-2" });
      }
      return Promise.resolve({
        items: [session("s90", { startedAtMs: 5_000, itemTitle: "Older Movie" })],
        nextCursor: null,
      });
    });
  }

  it("keeps the pages an admin loaded — a tick patches page 1 in place instead of replacing the list", async () => {
    vi.useFakeTimers();
    installPagedMock();
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});

    const loadMore = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Load more"));
    expect(loadMore).toBeTruthy();
    await act(async () => {
      loadMore!.click();
    });
    expect(view.container.textContent).toContain("Older Movie");

    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS);
    });
    await act(async () => {});

    // The page-2 row survives the tick, and page 1 is still there.
    expect(view.container.textContent).toContain("Older Movie");
    expect(view.container.textContent).toContain("Movie 0");
    expect(view.container.textContent).toContain("Movie 49");
  });

  it("a session that ended between ticks disappears; one that started appears — page 1 is still authoritative for its own window", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({
      items: [session("s1", { startedAtMs: 200, itemTitle: "Leaving Soon" }), session("s2", { startedAtMs: 100 })],
      nextCursor: null,
    });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    expect(view.container.textContent).toContain("Leaving Soon");

    apiGetMock.mockResolvedValue({
      items: [session("s3", { startedAtMs: 300, itemTitle: "Just Started" }), session("s2", { startedAtMs: 100 })],
      nextCursor: null,
    });
    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS);
    });
    await act(async () => {});

    expect(view.container.textContent).toContain("Just Started");
    expect(view.container.textContent).not.toContain("Leaving Soon");
  });

  it("does not poll while the tab is hidden, and refreshes once as soon as it comes back", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({ items: [session("s1")], nextCursor: null });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    hidden = true;
    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS * 5);
    });
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// d3-e3 (browser-admin-F2 follow-up, P2): `suspended` is one enum value with
// two opposite meanings — see StreamsPanel.test.tsx's companion block and
// lib/admin-session-presence.ts's header. This page renders the same pill.
// ---------------------------------------------------------------------------
describe("AdminSessionsPage — abandoned vs parked (d3-e3)", () => {
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

  it("labels a heartbeat-stale row No heartbeat instead of Suspended", async () => {
    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "suspended", suspendedByThrottle: false, heartbeatStale: true })],
      nextCursor: null,
    });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});

    expect(view.container.textContent).toContain("No heartbeat");
    expect(view.container.textContent).not.toContain("Suspended");
  });

  it("labels a throttle-parked transcode Buffered ahead", async () => {
    apiGetMock.mockResolvedValue({
      items: [session("s1", { status: "suspended", suspendedByThrottle: true, heartbeatStale: false, plan: { decision: "transcode" } })],
      nextCursor: null,
    });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Buffered ahead");
    expect(view.container.textContent).not.toContain("Suspended");
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

// ---------------------------------------------------------------------------
// d3-e5 (E/browser-admin-F2-followup): status transitions now have their own
// domain event (playback.session-status-changed, admin-only). A live suspend
// must reach this page's pill immediately, patching the row in place — and,
// critically, WITHOUT discarding the "Load more" pages a page-1 refetch
// would (d3-e4's whole subject).
// ---------------------------------------------------------------------------
describe("AdminSessionsPage — live status transitions (d3-e5)", () => {
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
      items: [session("s1", { startedAtMs: 500, status: "active" })],
      nextCursor: null,
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it("subscribes to playback.session-status-changed on the shared events socket on mount", async () => {
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    expect(subscribeMock.mock.calls.map(([type]) => type)).toContain("playback.session-status-changed");
  });

  it("patches the row's pill from the event alone, with no refetch", async () => {
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Active");

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
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it("patches a row the admin paged to with Load more, without collapsing the list", async () => {
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValueOnce({ items: [session("s1", { startedAtMs: 500 })], nextCursor: "c1" });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});

    apiGetMock.mockResolvedValueOnce({ items: [session("s2", { startedAtMs: 400, username: "grace" })], nextCursor: null });
    const loadMore = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Load more"));
    expect(loadMore).toBeTruthy();
    await act(async () => {
      loadMore!.click();
    });
    expect(view.container.textContent).toContain("grace");

    await act(async () => {
      statusHandler()(
        envelope({
          sessionId: "s2",
          previousStatus: "active",
          status: "suspended",
          suspendedByThrottle: true,
          reason: "throttle-suspend",
          changedAtMs: 1_700_000_060_000,
        }),
      );
    });

    expect(view.container.textContent).toContain("grace");
    expect(view.container.textContent).toContain("Buffered ahead");
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// d4-e2 (E/d3-e4 residual, backlog #102): d3-e4 stopped the tick from
// DISCARDING the pages an admin loaded — but it still only re-fetched page 1,
// so a page-2 row was retained and never refreshed. `heartbeatStale` is
// derived per REQUEST (no transition announces a client going quiet, which is
// exactly why the tick still exists), so a "Load more" row could sit there
// claiming a live viewer indefinitely. Before d3-e4 that window was 10s
// because the row was thrown away; keeping the page must not mean freezing it.
// ---------------------------------------------------------------------------
describe("AdminSessionsPage — the tick refreshes every loaded page (d4-e2)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue(() => {});
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  function page1(): ReturnType<typeof session>[] {
    return [session("s1", { startedAtMs: 10_000, itemTitle: "Newest" })];
  }

  /** The row an admin reached with "Load more" — its heartbeat is what goes
   *  quiet mid-session. */
  function page2(overrides: Record<string, unknown>): ReturnType<typeof session>[] {
    return [session("s90", { startedAtMs: 5_000, itemTitle: "Older Movie", ...overrides })];
  }

  function installPagedMock(page2Overrides: Record<string, unknown>): void {
    apiGetMock.mockImplementation((_path: string, options: { params: { query: Record<string, unknown> } }) => {
      if (options.params.query["cursor"] === undefined) {
        return Promise.resolve({ items: page1(), nextCursor: "cursor-page-2" });
      }
      return Promise.resolve({ items: page2(page2Overrides), nextCursor: null });
    });
  }

  function rowFor(title: string): HTMLElement {
    const row = Array.from(view!.container.querySelectorAll("[data-live]")).find((el) =>
      (el.textContent ?? "").includes(title),
    );
    if (!row) throw new Error(`no session row for "${title}"`);
    return row as HTMLElement;
  }

  async function loadMore(): Promise<void> {
    const button = Array.from(view!.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Load more"));
    if (!button) throw new Error("no Load more button");
    await act(async () => {
      button.click();
    });
  }

  it("a page-2 row that goes heartbeat-stale stops claiming a live viewer on the next tick", async () => {
    vi.useFakeTimers();
    installPagedMock({ heartbeatStale: false });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    await loadMore();
    expect(rowFor("Older Movie").getAttribute("data-live")).toBe("true");

    // The client went quiet. Nothing transitions, so no event can say so —
    // only a re-read of the page that row is on.
    installPagedMock({ heartbeatStale: true });
    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS);
    });
    await act(async () => {});

    expect(rowFor("Older Movie").getAttribute("data-live")).toBe("false");
    expect(rowFor("Older Movie").textContent).toContain("No heartbeat");
    // Page 1 is still there, and still page 1.
    expect(view.container.textContent).toContain("Newest");
  });

  it("still costs exactly one request per tick when the admin never paged", async () => {
    vi.useFakeTimers();
    apiGetMock.mockResolvedValue({ items: page1(), nextCursor: null });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS);
    });
    await act(async () => {});
    // One page loaded, one page refreshed — the unchanged common case.
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it("costs one request per LOADED page once the admin has paged", async () => {
    vi.useFakeTimers();
    installPagedMock({ heartbeatStale: false });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    await loadMore();
    const afterLoadMore = apiGetMock.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS);
    });
    await act(async () => {});

    // Two pages on screen, two requests in the tick.
    expect(apiGetMock.mock.calls.length - afterLoadMore).toBe(2);
  });

  it("a session that ended on page 2 disappears — the refreshed window is authoritative over all of it", async () => {
    vi.useFakeTimers();
    apiGetMock.mockImplementation((_path: string, options: { params: { query: Record<string, unknown> } }) => {
      if (options.params.query["cursor"] === undefined) {
        return Promise.resolve({ items: page1(), nextCursor: "cursor-page-2" });
      }
      return Promise.resolve({
        items: [
          session("s90", { startedAtMs: 5_000, itemTitle: "Older Movie" }),
          session("s91", { startedAtMs: 4_000, itemTitle: "Ending Soon" }),
        ],
        nextCursor: null,
      });
    });
    view = renderIntoBody(<AdminSessionsPage />);
    await act(async () => {});
    await loadMore();
    expect(view.container.textContent).toContain("Ending Soon");

    installPagedMock({});
    act(() => {
      vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS);
    });
    await act(async () => {});

    expect(view.container.textContent).not.toContain("Ending Soon");
    expect(view.container.textContent).toContain("Older Movie");
  });
});
