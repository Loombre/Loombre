// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/admin-live-refresh.test.ts
//
// d3-e4: the tick both admin now-playing surfaces share. The rendered
// halves are in StreamsPanel.test.tsx and app/admin/sessions/page.test.tsx;
// this pins the helper itself, including the cleanup (an unremoved
// visibilitychange listener would keep refetching for an unmounted screen).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SESSIONS_REFRESH_MS, startAdminSessionsRefresh } from "./admin-live-refresh.js";

let hidden = false;

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startAdminSessionsRefresh (d3-e4)", () => {
  it("ticks at the shared cadence while the tab is visible", () => {
    const refresh = vi.fn();
    const stop = startAdminSessionsRefresh(refresh);

    vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
  });

  it("skips every tick while the tab is hidden — no request for a screen nobody is looking at", () => {
    const refresh = vi.fn();
    const stop = startAdminSessionsRefresh(refresh);

    hidden = true;
    vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS * 5);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("refreshes once when the tab becomes visible again, then resumes ticking", () => {
    const refresh = vi.fn();
    const stop = startAdminSessionsRefresh(refresh);

    hidden = true;
    vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS * 2);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops the interval AND the visibility listener on cleanup", () => {
    const refresh = vi.fn();
    startAdminSessionsRefresh(refresh)();

    vi.advanceTimersByTime(ADMIN_SESSIONS_REFRESH_MS * 3);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores a visibilitychange that reports the tab as still hidden", () => {
    const refresh = vi.fn();
    const stop = startAdminSessionsRefresh(refresh);

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });
});
