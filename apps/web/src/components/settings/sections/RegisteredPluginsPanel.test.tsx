// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: RegisteredPluginsPanel tests (LD-8, Settings-Plugins
// consolidation) — this component is the relocated admin Plugins list
// (formerly apps/web/src/app/admin/plugins/page.tsx, the admin Dashboard's
// "Plugins" tab, which had no dedicated test file of its own — see this
// file's own coverage rationale below). Proves: the GET /admin/plugins
// fetch, empty/loaded list rendering, that each row links to
// /settings/plugins/<id> (NOT the old /admin/plugins/<id> — the whole point
// of this move), the "Register a plugin" trigger opening
// RegisterPluginWizard (reused unchanged, not re-tested here — its own
// step logic is covered by lib/plugin-wizard-state.test.ts), and the live
// plugin.* event -> refetch subscription (NoticesSection.test.tsx's
// events-socket mock pattern).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();
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

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { RegisteredPluginsPanel } = await import("./RegisteredPluginsPanel.js");

const PLUGIN_A = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Cast & Crew Enricher",
  baseUrl: "https://plugins.example.com/cast",
  enabled: true,
  healthState: "healthy",
  disabledReason: null,
};
const PLUGIN_B = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Activity Relay",
  baseUrl: "https://relay.example.net",
  enabled: false,
  healthState: "unknown",
  disabledReason: "admin",
};

let view: TestRender | undefined;

beforeEach(() => {
  apiGetMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function render(): Promise<void> {
  view = renderIntoBody(<RegisteredPluginsPanel />);
  await act(async () => {});
}

function textOf(): string {
  return document.body.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const match = buttons.find((b) => (b.textContent ?? "").includes(label));
  if (!match) {
    throw new Error(`no button containing "${label}" — buttons: ${buttons.map((b) => b.textContent).join(" | ")}`);
  }
  return match;
}

describe("RegisteredPluginsPanel", () => {
  it("fetches GET /admin/plugins and renders each row linking to /settings/plugins/<id> (not /admin/plugins/<id>)", async () => {
    apiGetMock.mockResolvedValue({ items: [PLUGIN_A, PLUGIN_B] });
    await render();

    expect(apiGetMock).toHaveBeenCalledWith("/admin/plugins");
    expect(textOf()).toContain("Registered plugins");
    expect(textOf()).toContain("· 2");
    expect(textOf()).toContain(PLUGIN_A.name);
    expect(textOf()).toContain(PLUGIN_B.name);

    const links = Array.from(document.body.querySelectorAll("a"));
    const linkA = links.find((a) => a.textContent?.includes(PLUGIN_A.name));
    const linkB = links.find((a) => a.textContent?.includes(PLUGIN_B.name));
    expect(linkA?.getAttribute("href")).toBe(`/settings/plugins/${PLUGIN_A.id}`);
    expect(linkB?.getAttribute("href")).toBe(`/settings/plugins/${PLUGIN_B.id}`);

    // Status pills — describePluginStatus's exact wording, unchanged from
    // the pre-move admin list page.
    expect(textOf()).toContain("Enabled");
    expect(textOf()).toContain("Disabled");
  });

  it("shows the empty state when GET /admin/plugins returns no items", async () => {
    apiGetMock.mockResolvedValue({ items: [] });
    await render();

    expect(textOf()).toContain("No plugins registered");
  });

  it('"Register a plugin" opens RegisterPluginWizard', async () => {
    apiGetMock.mockResolvedValue({ items: [] });
    await render();

    await act(async () => {
      buttonByText("Register a plugin").click();
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute("aria-label")).toBe("Register a plugin");
  });

  it("subscribes to all 6 ADMIN_ONLY plugin.* events and refetches when one fires", async () => {
    apiGetMock.mockResolvedValue({ items: [PLUGIN_A] });
    await render();

    const subscribedTypes = subscribeMock.mock.calls.map((c) => c[0]);
    expect(subscribedTypes).toEqual([
      "plugin.registered",
      "plugin.updated",
      "plugin.enabled",
      "plugin.disabled",
      "plugin.removed",
      "plugin.health-changed",
    ]);

    apiGetMock.mockClear();
    const updatedHandler = subscribeMock.mock.calls.find((c) => c[0] === "plugin.updated")?.[1] as (() => void) | undefined;
    await act(async () => {
      updatedHandler?.();
    });
    expect(apiGetMock).toHaveBeenCalledWith("/admin/plugins");
  });

  it("surfaces a fetch failure as an error banner (err.message, since it's a LoombreApiError instance) rather than an infinite skeleton", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError(500, { title: "Internal Server Error" }));
    await render();

    expect(textOf()).toMatch(/status 500/i);
    expect(textOf()).not.toContain("No plugins registered");
  });
});
