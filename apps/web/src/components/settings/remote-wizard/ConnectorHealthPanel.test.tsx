// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: ConnectorHealthPanel tests — STATE.md "Loombre Remote ..."
// mission item 2 (lane U3). Covers each connectorState (state pill +
// backoff copy + lastError), the logs tail (populated / empty / manual
// refresh), live refresh via tunnel.connector.state (StreamsPanel.test.tsx
// convention), and the both-breakpoints matchMedia smoke test
// (RemoteWizard.test.tsx convention).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import type { components } from "@loombre/sdk";

type RemoteTunnelStatus = components["schemas"]["RemoteTunnelStatus"];

const apiGetMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {
  status: number;
  constructor(status: number, problem: unknown) {
    const title =
      typeof problem === "object" && problem !== null && "title" in problem
        ? String((problem as { title?: unknown }).title)
        : `status ${status}`;
    super(title);
    this.status = status;
  }
}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  LoombreApiError: FakeApiError,
  apiErrorMessage: (err: unknown, fallback: string): string => {
    if (err && typeof err === "object") {
      const problem = (err as { problem?: unknown }).problem;
      if (problem && typeof problem === "object" && typeof (problem as { detail?: unknown }).detail === "string" && (problem as { detail?: string }).detail) {
        return (problem as { detail: string }).detail;
      }
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    return fallback;
  },
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { ConnectorHealthPanel } = await import("./ConnectorHealthPanel.js");

function statusFixture(overrides: Partial<RemoteTunnelStatus> = {}): RemoteTunnelStatus {
  return {
    enabled: true,
    connectorState: "running",
    hostname: "loombre.example.com",
    backoffMs: null,
    lastErrorMessage: null,
    tokenConfigured: true,
    tokenSetAtMs: Date.now(),
    tokenScopesOk: true,
    ...overrides,
  };
}

let view: TestRender | undefined;

beforeEach(() => {
  apiGetMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

function defaultRouting(statusOverrides: Partial<RemoteTunnelStatus> = {}, lines: string[] = []): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/admin/remote/tunnel/status") return Promise.resolve(statusFixture(statusOverrides));
    if (path === "/admin/remote/tunnel/logs") return Promise.resolve({ lines });
    return Promise.reject(new Error(`unexpected path ${path}`));
  });
}

async function render(): Promise<void> {
  view = renderIntoBody(<ConnectorHealthPanel />);
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

describe("ConnectorHealthPanel — connector states", () => {
  it.each([
    ["stopped", "Stopped", "neutral"],
    ["starting", "Starting", "info"],
    ["running", "Running", "success"],
    ["degraded", "Degraded", "warning"],
    ["error", "Error", "danger"],
  ] as const)("renders %s as a %s-toned pill", async (connectorState, label, tone) => {
    defaultRouting({ connectorState });
    await render();
    const pill = document.body.querySelector(`[data-tone="${tone}"]`);
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe(label);
  });

  it("shows a countdown-ish 'retrying' copy when backoffMs is set", async () => {
    defaultRouting({ connectorState: "error", backoffMs: 4_000 });
    await render();
    expect(textOf()).toContain("retrying in ~4s");
  });

  it("shows lastErrorMessage when present", async () => {
    defaultRouting({ connectorState: "error", lastErrorMessage: "connection refused" });
    await render();
    expect(textOf()).toContain("connection refused");
  });

  it("shows an error message on status fetch failure", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/remote/tunnel/status") return Promise.reject(new FakeApiError(500, { title: "boom" }));
      if (path === "/admin/remote/tunnel/logs") return Promise.resolve({ lines: [] });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    await render();
    expect(textOf()).toContain("boom");
  });
});

describe("ConnectorHealthPanel — logs tail", () => {
  it("fetches logs once on mount and renders them in a monospace tail", async () => {
    defaultRouting({}, ["line one", "line two"]);
    await render();
    expect(apiGetMock).toHaveBeenCalledWith("/admin/remote/tunnel/logs");
    const pre = document.body.querySelector("pre");
    expect(pre?.textContent).toContain("line one");
    expect(pre?.textContent).toContain("line two");
  });

  it("shows an honest empty state when the log ring buffer is empty (Noop/absent connector)", async () => {
    defaultRouting({}, []);
    await render();
    expect(textOf()).toContain("No log output yet.");
  });

  it("the Refresh button re-fetches logs manually — no auto-polling of logs", async () => {
    defaultRouting({}, ["first"]);
    await render();
    expect(apiGetMock.mock.calls.filter((c) => c[0] === "/admin/remote/tunnel/logs")).toHaveLength(1);

    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/remote/tunnel/status") return Promise.resolve(statusFixture());
      if (path === "/admin/remote/tunnel/logs") return Promise.resolve({ lines: ["second"] });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    await act(async () => {
      buttonByText("Refresh").click();
    });
    expect(apiGetMock.mock.calls.filter((c) => c[0] === "/admin/remote/tunnel/logs")).toHaveLength(2);
    expect(document.body.querySelector("pre")?.textContent).toContain("second");
  });
});

describe("ConnectorHealthPanel — live refresh", () => {
  it("subscribes to tunnel.connector.state and refetches status when it fires", async () => {
    defaultRouting();
    await render();
    const subscribedTypes = subscribeMock.mock.calls.map((c) => c[0]);
    expect(subscribedTypes).toContain("tunnel.connector.state");

    apiGetMock.mockClear();
    defaultRouting({ connectorState: "degraded" });
    const handler = subscribeMock.mock.calls.find((c) => c[0] === "tunnel.connector.state")?.[1] as
      | (() => void)
      | undefined;
    await act(async () => {
      handler?.();
    });
    expect(apiGetMock).toHaveBeenCalledWith("/admin/remote/tunnel/status");
  });

  it("polls status on a modest interval as a fallback while mounted", async () => {
    vi.useFakeTimers();
    defaultRouting();
    view = renderIntoBody(<ConnectorHealthPanel />);
    await act(async () => {});
    const statusCallCount = (): number => apiGetMock.mock.calls.filter((c) => c[0] === "/admin/remote/tunnel/status").length;
    expect(statusCallCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(statusCallCount()).toBe(2);
  });
});

describe("ConnectorHealthPanel — both breakpoints (matchMedia stub convention)", () => {
  function installMatchMedia(matches: boolean): void {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the same content whether the phone media query matches or not", async () => {
    defaultRouting();
    installMatchMedia(true);
    await render();
    expect(textOf()).toContain("Tunnel connector");
    view?.unmount();
    view = undefined;

    installMatchMedia(false);
    await render();
    expect(textOf()).toContain("Tunnel connector");
  });
});
