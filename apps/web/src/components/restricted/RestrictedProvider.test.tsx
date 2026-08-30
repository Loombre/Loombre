// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/restricted/RestrictedProvider.test.tsx
//
// Bootstrap-honesty coverage for the provider every restricted surface
// reads (browser-restricted-settings-F3 + browser-items-F3, 2026-08-21 QA):
// a FRESH page load must learn the caller's real restricted state from the
// server instead of showing first-time-opt-in UI (hasPin null) and a
// "locked" header indicator while the server is still serving the zone.
//
// Harness follows SystemNoticeProvider.test.tsx's mock shape (api-client +
// auth-store + events-socket mocked, module imported afterwards). The
// api-client mock is PATH-AWARE so a regression back to the old
// GET /users/me/settings-only bootstrap shows up as the missing hasPin/
// unlock fields rather than as a mock explosion.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

class FakeApiError extends Error {
  status = 0;
}

let authenticated = true;
const authListeners = new Set<() => void>();

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    isAuthenticated: () => authenticated,
    subscribe: (fn: () => void) => {
      authListeners.add(fn);
      return () => authListeners.delete(fn);
    },
  }),
}));

type SocketListener = (event: { tsMs: number; payload: unknown }) => void;
const socketListeners = new Map<string, Set<SocketListener>>();

vi.mock("../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({
    subscribe: (type: string, listener: SocketListener) => {
      let set = socketListeners.get(type);
      if (!set) {
        set = new Set();
        socketListeners.set(type, set);
      }
      set.add(listener);
      return () => set!.delete(listener);
    },
    // RZI-D5c zone subscription — a no-op here; these tests mount the
    // provider outside a router (pathname null), which is never in-zone.
    setRestrictedZoneSubscribed: () => {},
  }),
}));

const invalidateMock = vi.fn();
vi.mock("../../lib/catalog-invalidation.js", () => ({
  emitCatalogInvalidation: () => invalidateMock(),
}));

const { RestrictedProvider, useRestricted } = await import("./RestrictedProvider.js");

const NOW = 1_700_000_000_000;

/** The server's GET /users/me/restricted body (RestrictedSettings). */
let restrictedGetResponse: { optIn: boolean; hasPin: boolean; unlockedUntilMs: number | null } = {
  optIn: false,
  hasPin: false,
  unlockedUntilMs: null,
};

function Probe(): React.JSX.Element {
  const { state } = useRestricted();
  return (
    <div>
      <span data-testid="loading">{String(state.loading)}</span>
      <span data-testid="optIn">{String(state.optIn)}</span>
      <span data-testid="hasPin">{String(state.hasPin)}</span>
      <span data-testid="locked">{String(state.locked)}</span>
      <span data-testid="unlockedUntilMs">{String(state.unlockedUntilMs)}</span>
    </div>
  );
}

function field(view: TestRender, testid: string): string {
  return view.container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
}

async function renderProvider(): Promise<TestRender> {
  let view: TestRender | null = null;
  await act(async () => {
    view = renderIntoBody(
      <RestrictedProvider>
        <Probe />
      </RestrictedProvider>,
    );
  });
  if (!view) throw new Error("render produced nothing");
  await act(async () => {});
  return view;
}

describe("RestrictedProvider bootstrap", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    invalidateMock.mockReset();
    authenticated = true;
    authListeners.clear();
    socketListeners.clear();
    restrictedGetResponse = { optIn: false, hasPin: false, unlockedUntilMs: null };
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me/restricted") return Promise.resolve({ ...restrictedGetResponse });
      if (path === "/users/me/settings") return Promise.resolve({ restrictedOptIn: restrictedGetResponse.optIn });
      throw new Error(`unexpected apiGet(${path})`);
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  // browser-restricted-settings-F3: the /profile Restricted card renders its
  // "Current PIN (required to change PIN or opt out)" field and its
  // "leave blank to keep current" hint off state.hasPin ALONE, and blocks a
  // blank-PIN save when !state.hasPin. A PIN holder who has not unlocked in
  // THIS page session must still get the PIN-holder shape.
  it("hydrates hasPin from the server on mount, with no unlock this session", async () => {
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs: null };

    view = await renderProvider();

    expect(field(view, "loading")).toBe("false");
    expect(field(view, "optIn")).toBe("true");
    expect(field(view, "hasPin")).toBe("true");
    // No live unlock window -> still locked (fail closed).
    expect(field(view, "locked")).toBe("true");
  });

  // browser-items-F3: the header lock indicator reads state.locked alone, so
  // a reload inside a live server-side unlock window used to read "locked"
  // while the zone was still being served.
  it("hydrates a live server-side unlock window on mount (reload inside the window stays unlocked)", async () => {
    const unlockedUntilMs = NOW + 25 * 60_000;
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs };

    view = await renderProvider();

    expect(field(view, "unlockedUntilMs")).toBe(String(unlockedUntilMs));
    expect(field(view, "locked")).toBe("false");
  });

  it("an already-expired window from the server never unlocks the client", async () => {
    restrictedGetResponse = { optIn: true, hasPin: true, unlockedUntilMs: NOW - 1 };

    view = await renderProvider();

    expect(field(view, "locked")).toBe("true");
  });

  it("a failed bootstrap fails closed and still finishes loading", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError("network down"));

    view = await renderProvider();

    expect(field(view, "loading")).toBe("false");
    expect(field(view, "locked")).toBe("true");
    expect(field(view, "optIn")).toBe("false");
  });

  it("never calls the server while unauthenticated", async () => {
    authenticated = false;

    view = await renderProvider();

    expect(apiGetMock).not.toHaveBeenCalled();
    expect(field(view, "loading")).toBe("false");
    expect(field(view, "locked")).toBe("true");
  });
});
