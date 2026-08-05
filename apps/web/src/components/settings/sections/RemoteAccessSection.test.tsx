// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: RemoteAccessSection tests — entry state from GET
// /admin/remote/state (hero vs. management view, incl. the honest 501
// degraded state), the "Advanced network settings" disclosure preserving
// the existing env-pinned network/tls cards, and freeze decision 5's
// ?path=/&step= deep-link handling. Mirrors MailSection.test.tsx's harness
// (api-client + events-socket mocks, top-level-await import) plus the
// watch/[itemId]/page.test.tsx convention for mocking next/navigation's
// useSearchParams with a reassignable URLSearchParams.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();
const subscribeMock = vi.fn();
let searchParams = new URLSearchParams();

class FakeApiError extends Error {
  status: number;
  problem: unknown;
  constructor(status: number, problem: unknown) {
    const title =
      typeof problem === "object" && problem !== null && "title" in problem
        ? String((problem as { title?: unknown }).title)
        : `Request failed with status ${status}`;
    super(title);
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

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

const { RemoteAccessSection } = await import("./RemoteAccessSection.js");

function schemaEntry(key: string, category: string): Record<string, unknown> {
  return {
    key,
    category,
    description: `Description for ${key}`,
    scope: "env",
    requiresRestart: false,
    default: "",
    valueSchema: { type: "string" },
    locked: true,
  };
}

const SCHEMA = {
  entries: [schemaEntry("network.trustProxy", "network"), schemaEntry("tls.mode", "tls")],
};
const SETTINGS = {
  settings: [
    { key: "network.trustProxy", value: false, source: "environment", requiresRestart: false, locked: true },
    { key: "tls.mode", value: "off", source: "environment", requiresRestart: false, locked: true },
  ],
};

const NONE_STATE = {
  activePath: "none",
  wireguard: { enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 },
  // T2 fixup (RG7): RemoteTunnelStatus gained three additive REQUIRED
  // fields (tokenConfigured/tokenSetAtMs/tokenScopesOk — T1's own drift
  // decision, remote-tunnel.service.ts's header) after this fixture was
  // first written.
  tunnel: { enabled: false, connectorState: "stopped", hostname: null, backoffMs: null, lastErrorMessage: null, tokenConfigured: false, tokenSetAtMs: null, tokenScopesOk: null },
  direct: { enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null },
};

const REMOTE_ACTIVE_STATE = {
  ...NONE_STATE,
  activePath: "remote",
  wireguard: { enabled: true, listening: true, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: "example.com", peerCount: 1 },
};

let view: TestRender | undefined;

function mockState(handler: (path: string) => unknown): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/admin/settings/schema") return Promise.resolve(SCHEMA);
    if (path === "/admin/settings") return Promise.resolve(SETTINGS);
    if (path === "/admin/remote/state") return handler(path);
    return Promise.reject(new Error(`unexpected apiGet ${path}`));
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
  searchParams = new URLSearchParams();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function render(): Promise<void> {
  view = renderIntoBody(<RemoteAccessSection heading="Remote Access" />);
  await act(async () => {});
  // Suspense + async effects settle over a couple of microtask turns.
  await act(async () => {});
}

function textOf(): string {
  return document.body.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const match = buttons.find((b) => (b.textContent ?? "").includes(label));
  if (!match) throw new Error(`no button containing "${label}" — buttons: ${buttons.map((b) => b.textContent).join(" | ")}`);
  return match;
}

describe("RemoteAccessSection — entry state from GET /admin/remote/state", () => {
  it("activePath 'none' -> hero card with the setup CTA", async () => {
    mockState(() => Promise.resolve(NONE_STATE));
    await render();
    expect(textOf()).toContain("Watch Loombre from anywhere");
    expect(buttonByText("Set up remote access")).toBeTruthy();
  });

  it("an active path -> the management view (path name, Active pill, Switch/Disable)", async () => {
    mockState(() => Promise.resolve(REMOTE_ACTIVE_STATE));
    await render();
    expect(textOf()).toContain("Loombre Remote");
    expect(textOf()).toContain("Active");
    expect(buttonByText("Switch path…")).toBeTruthy();
    expect(buttonByText("Disable…")).toBeTruthy();
  });

  it("a 501 (not implemented on this build) renders the hero honestly degraded, NOT an error banner", async () => {
    mockState(() => Promise.reject(new FakeApiError(501, { title: "Not Implemented", status: 501 })));
    await render();
    expect(textOf()).toContain("Watch Loombre from anywhere");
    expect(textOf()).toContain("Live status isn't available on this build yet");
    expect(buttonByText("Set up remote access")).toBeTruthy();
  });

  it("a real error shows an error message, not a silent blank section", async () => {
    mockState(() => Promise.reject(new FakeApiError(500, { title: "boom", status: 500 })));
    await render();
    expect(textOf()).toContain("boom");
  });

  it("clicking 'Set up remote access' opens the wizard at the interview stage", async () => {
    mockState(() => Promise.resolve(NONE_STATE));
    await render();
    await act(async () => {
      buttonByText("Set up remote access").click();
    });
    expect(textOf()).toContain("A few questions");
  });
});

describe("RemoteAccessSection — Advanced network settings disclosure (UI decision 2)", () => {
  it("preserves the existing env-pinned network/tls category cards inside a <details> disclosure", async () => {
    mockState(() => Promise.resolve(NONE_STATE));
    await render();
    const details = document.body.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toContain("Advanced network settings");
    expect(textOf()).toContain("Network");
    expect(textOf()).toContain("TLS");
  });
});

describe("RemoteAccessSection — deep links (freeze decision 5, ?path=&step=)", () => {
  it("?path=<not-currently-active path> opens the wizard directly at path-flow, first step", async () => {
    searchParams = new URLSearchParams({ path: "tunnel" });
    mockState(() => Promise.resolve(NONE_STATE));
    await render();
    expect(textOf()).toContain("Setting up Tunnel");
    expect(textOf()).toContain("Connect your Cloudflare account"); // tunnel-token, first step
  });

  it("?path=<active path> opens the wizard directly at posture-handoff (deriveEntryStage — nothing left to configure)", async () => {
    searchParams = new URLSearchParams({ path: "remote" });
    mockState(() => Promise.resolve(REMOTE_ACTIVE_STATE));
    await render();
    expect(textOf()).toContain("Loombre Remote is set up");
  });

  it("?path=direct&step=direct-router-instructions seeks straight to that step", async () => {
    searchParams = new URLSearchParams({ path: "direct", step: "direct-router-instructions" });
    mockState(() => Promise.resolve(NONE_STATE));
    await render();
    expect(textOf()).toContain("Forward a port on your router");
  });

  it("an invalid ?path= value is ignored — falls back to the normal entry state", async () => {
    searchParams = new URLSearchParams({ path: "bogus" });
    mockState(() => Promise.resolve(NONE_STATE));
    await render();
    expect(textOf()).toContain("Watch Loombre from anywhere");
  });

  it("no ?path= -> normal entry state, no wizard auto-opened", async () => {
    mockState(() => Promise.resolve(REMOTE_ACTIVE_STATE));
    await render();
    expect(textOf()).not.toContain("A few questions");
    expect(buttonByText("Switch path…")).toBeTruthy();
  });
});
