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

function apiGetImpl(isAdmin: boolean | "reject"): (path: string, ...rest: unknown[]) => Promise<unknown> {
  return (path: string) => {
    if (path === "/users/me") {
      return isAdmin === "reject" ? Promise.reject(new FakeApiError(401, {})) : Promise.resolve({ isAdmin });
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
