// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/settings/plugins/[id]/PluginDetailScreen.test.tsx
//
// LD-8 (Settings-Plugins consolidation): pins the admin-only guard this
// screen had to grow once it moved off /admin/* (no more free ride from
// app/admin/layout.tsx's own isAdmin check) and out of SettingsShell (no
// tab strip on an item-detail route — see this file's own header for why).
// AppShell.js is mocked to a plain passthrough: its own auth/topbar/
// SystemNoticeProvider concerns are unrelated to what THIS file needs to
// prove (the isAdmin gate runs and redirects correctly) and have no
// existing test harness of their own in this repo to piggyback on.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../../components/ui/test-render.js";

const routerReplace = vi.fn();
const router = { push: vi.fn(), replace: routerReplace };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("../../../../components/shell/AppShell.js", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => children,
}));

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPutMock = vi.fn();
const apiDeleteMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  problem: unknown;
  constructor(status: number, problem: unknown) {
    super(`status ${status}`);
    this.status = status;
    this.problem = problem;
  }
}

vi.mock("../../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  apiDelete: (...args: unknown[]) => apiDeleteMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { PluginDetailScreen } = await import("./PluginDetailScreen.js");

const PLUGIN = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Cast & Crew Enricher",
  baseUrl: "https://plugins.example.com/cast",
  version: "1.0.0",
  enabled: true,
  healthState: "healthy",
  disabledReason: null,
  grantedCapabilityTypes: [],
  eventGrants: [],
  manifest: {},
  config: {},
  createdAtMs: Date.now(),
  lastHealthCheckMs: null,
  lanAllowlist: [],
};

/** `"reject"` is a real SERVER failure (503), not a 401: since d4-w4 the
 *  shared guard (lib/use-admin-guard.ts) reads a 401 as "not signed in" and
 *  routes to /login rather than to the caller's non-admin landing, so a 401
 *  no longer exercises the fail-closed path this helper's callers assert.
 *  The 401 behaviour has its own case below. */
function apiGetImpl(isAdmin: boolean | "reject"): (path: string, ...rest: unknown[]) => Promise<unknown> {
  return (path: string) => {
    if (path === "/users/me") {
      return isAdmin === "reject" ? Promise.reject(new FakeApiError(503, {})) : Promise.resolve({ isAdmin });
    }
    if (path === "/admin/plugins/{id}") return Promise.resolve(PLUGIN);
    return Promise.reject(new Error(`unexpected path ${path}`));
  };
}

let view: TestRender | undefined;

beforeEach(() => {
  routerReplace.mockReset();
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPutMock.mockReset();
  apiDeleteMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

/** GET /admin/plugins/{id} answers `impl`, everything else is the admin. */
function apiGetImplWithPlugin(impl: () => Promise<unknown>): (path: string, ...rest: unknown[]) => Promise<unknown> {
  return (path: string) => {
    if (path === "/users/me") return Promise.resolve({ isAdmin: true });
    if (path === "/admin/plugins/{id}") return impl();
    return Promise.reject(new Error(`unexpected path ${path}`));
  };
}

function skeletonCount(container: HTMLElement): number {
  return container.querySelectorAll('[class*="skeleton"]').length;
}

describe("PluginDetailScreen — admin-only guard", () => {
  it("isAdmin:false — redirects to /profile and renders nothing (never fetches the plugin)", async () => {
    apiGetMock.mockImplementation(apiGetImpl(false));
    view = renderIntoBody(<PluginDetailScreen id={PLUGIN.id} />);
    await act(async () => {});

    expect(routerReplace).toHaveBeenCalledWith("/profile");
    expect(view.container.textContent).toBe("");
    expect(apiGetMock).not.toHaveBeenCalledWith("/admin/plugins/{id}", expect.anything());
  });

  it("GET /users/me failure fails closed — treated as non-admin, redirects to /profile", async () => {
    apiGetMock.mockImplementation(apiGetImpl("reject"));
    view = renderIntoBody(<PluginDetailScreen id={PLUGIN.id} />);
    await act(async () => {});

    expect(routerReplace).toHaveBeenCalledWith("/profile");
    expect(view.container.textContent).toBe("");
  });

  // d4-w4: a 401 is not "you are not an admin", it is "you are not signed
  // in" — api-client.ts only lets one escape once its own refresh-and-retry
  // has already failed. /profile is a second page such a viewer cannot see
  // either; /login carrying where they were is the honest destination.
  it("d4-w4: an UNAUTHENTICATED (401) GET /users/me sends the viewer to /login, not /profile", async () => {
    apiGetMock.mockImplementation((path: string) =>
      path === "/users/me" ? Promise.reject(new FakeApiError(401, {})) : Promise.resolve(PLUGIN),
    );
    view = renderIntoBody(<PluginDetailScreen id={PLUGIN.id} />);
    await act(async () => {});

    expect(routerReplace).toHaveBeenCalledWith(expect.stringContaining("/login"));
    expect(routerReplace).not.toHaveBeenCalledWith("/profile");
    expect(view.container.textContent).toBe("");
  });

  it("isAdmin:true — does not redirect, renders the '← Plugins' back link and the fetched plugin", async () => {
    apiGetMock.mockImplementation(apiGetImpl(true));
    view = renderIntoBody(<PluginDetailScreen id={PLUGIN.id} />);
    await act(async () => {});

    expect(routerReplace).not.toHaveBeenCalledWith("/profile");
    const backLink = Array.from(view.container.querySelectorAll("a")).find((a) => a.textContent?.includes("Plugins"));
    expect(backLink?.getAttribute("href")).toBe("/settings/plugins");
    expect(view.container.textContent).toContain(PLUGIN.name);
  });
});

// ---------------------------------------------------------------------------
// d3-e1 (B/api-validation-F1 residual, web half): the server now 404s a
// malformed/unknown plugin id (d0bd2cb) instead of 500ing, but this screen
// had no surface for EITHER outcome that an admin could act on — the only
// exit from `refetch`'s catch that renders anything is the 404 branch, and
// every other status set an `error` string that lives INSIDE the loaded-
// plugin tree (so it can never be reached while `plugin` is still null).
// A non-404 therefore left the screen pulsing skeletons under a bare
// "← Plugins" link, forever, with the server's RFC 9457 detail discarded.
// ---------------------------------------------------------------------------
describe("PluginDetailScreen — load failures (d3-e1)", () => {
  it("404 — renders a not-found surface, not an endless skeleton", async () => {
    apiGetMock.mockImplementation(
      apiGetImplWithPlugin(() =>
        Promise.reject(new FakeApiError(404, { type: "urn:loombre:problem:not-found", title: "Not Found", status: 404, detail: "Plugin not found." })),
      ),
    );
    view = renderIntoBody(<PluginDetailScreen id={PLUGIN.id} />);
    await act(async () => {});

    expect(view.container.textContent).toContain("Plugin not found.");
    expect(skeletonCount(view.container)).toBe(0);
  });

  it("500 — surfaces the problem detail with a Retry instead of pulsing skeletons forever", async () => {
    apiGetMock.mockImplementation(
      apiGetImplWithPlugin(() =>
        Promise.reject(
          new FakeApiError(500, {
            type: "urn:loombre:problem:internal",
            title: "Internal Server Error",
            status: 500,
            detail: "An unexpected error occurred.",
          }),
        ),
      ),
    );
    view = renderIntoBody(<PluginDetailScreen id={PLUGIN.id} />);
    await act(async () => {});

    expect(view.container.textContent).toContain("An unexpected error occurred.");
    expect(skeletonCount(view.container)).toBe(0);
    const retry = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Retry"));
    expect(retry).toBeTruthy();
  });

  it("Retry re-fetches and renders the plugin once the server recovers", async () => {
    let failNext = true;
    apiGetMock.mockImplementation(
      apiGetImplWithPlugin(() => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new FakeApiError(503, { title: "Service Unavailable", status: 503, detail: "The server is restarting." }));
        }
        return Promise.resolve(PLUGIN);
      }),
    );
    view = renderIntoBody(<PluginDetailScreen id={PLUGIN.id} />);
    await act(async () => {});
    expect(view.container.textContent).toContain("The server is restarting.");

    const retry = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Retry"));
    await act(async () => {
      retry!.click();
    });

    expect(view.container.textContent).toContain(PLUGIN.name);
    expect(view.container.textContent).not.toContain("The server is restarting.");
  });
});
