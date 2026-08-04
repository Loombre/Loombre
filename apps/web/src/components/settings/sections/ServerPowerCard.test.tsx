// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: ServerPowerCard tests — the /settings/server "Power" card
// (POST /system/restart + /system/shutdown). Mirrors InvitesPanel.test.tsx's
// harness (vi.mock of api-client BEFORE a top-level-await import;
// renderIntoBody; act). The InvitesPanel regression class applies here
// verbatim: a failed action must SHOW its error and return to an
// actionable state, never a stuck confirm/progress block.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiPostMock = vi.fn();

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
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/auth-store.js", () => ({
  getAuthStore: () => ({ getSnapshot: () => ({ serverUrl: "http://server.test" }) }),
}));

const { ServerPowerCard, RESTART_POLL_INTERVAL_MS } = await import("./ServerPowerCard.js");

let view: TestRender | undefined;
const fetchMock = vi.fn();

beforeEach(() => {
  apiPostMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(): Promise<void> {
  view = renderIntoBody(<ServerPowerCard />);
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

async function click(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).click();
  });
}

describe("ServerPowerCard — idle", () => {
  it("renders both actions and calls nothing", async () => {
    await render();
    expect(buttonByText("Restart server")).toBeTruthy();
    expect(buttonByText("Shut down server")).toBeTruthy();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});

describe("restart flow", () => {
  it("shows a confirm step first; Cancel returns to idle without any API call", async () => {
    await render();
    await click("Restart server");
    expect(textOf()).toContain("Restart the server?");
    expect(apiPostMock).not.toHaveBeenCalled();
    await click("Cancel");
    expect(textOf()).not.toContain("Restart the server?");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("confirming POSTs /system/restart and enters the restarting state", async () => {
    apiPostMock.mockResolvedValue({ accepted: true, action: "restart" });
    // Healthz never answers in this case — stays "restarting".
    fetchMock.mockRejectedValue(new TypeError("connection refused"));
    await render();
    await click("Restart server");
    await click("Restart");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[0]).toBe("/system/restart");
    expect(textOf()).toContain("Restarting");
  });

  it("reports the server back once /healthz was seen DOWN and then answers again", async () => {
    vi.useFakeTimers();
    apiPostMock.mockResolvedValue({ accepted: true, action: "restart" });
    // Poll 1: down. Poll 2: up again -> restarted.
    fetchMock
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValue({ ok: true } as Response);
    await render();
    await click("Restart server");
    await click("Restart");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_INTERVAL_MS + 10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTART_POLL_INTERVAL_MS + 10);
    });
    expect(textOf()).toContain("back online");
    expect(fetchMock).toHaveBeenCalledWith("http://server.test/healthz", expect.objectContaining({ cache: "no-store" }));
    // OK returns to the normal idle actions.
    await click("OK");
    expect(buttonByText("Restart server")).toBeTruthy();
  });

  it("a failed restart POST shows the error and returns to idle — never a stuck progress state", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(500, { title: "boom", status: 500 }));
    await render();
    await click("Restart server");
    await click("Restart");
    expect(textOf()).toContain("Could not restart the server");
    // Actionable again:
    expect(buttonByText("Restart server")).toBeTruthy();
    expect(textOf()).not.toContain("Restarting the server");
  });
});

describe("shutdown flow", () => {
  it("shows a confirm step; confirming POSTs /system/shutdown and lands on the terminal shut-down notice", async () => {
    apiPostMock.mockResolvedValue({ accepted: true, action: "shutdown" });
    await render();
    await click("Shut down server");
    expect(textOf()).toContain("Shut down the server?");
    expect(apiPostMock).not.toHaveBeenCalled();
    await click("Shut down");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[0]).toBe("/system/shutdown");
    // Terminal state: says the page stops working + how to start again.
    expect(textOf()).toContain("shutting down");
    expect(textOf()).toContain("menu bar");
  });

  it("renders the 409 container-supervision problem detail honestly and stays actionable", async () => {
    apiPostMock.mockRejectedValue(
      new FakeApiError(409, {
        title: "Conflict",
        status: 409,
        code: "shutdown-unsupported-under-container-supervision",
        detail:
          "This deployment runs under a container supervisor that restarts the server on any exit. " +
          "Stop the container from outside instead (docker compose stop).",
      }),
    );
    await render();
    await click("Shut down server");
    await click("Shut down");
    expect(textOf()).toContain("docker compose stop");
    // Not stuck: the idle actions are back.
    expect(buttonByText("Restart server")).toBeTruthy();
    expect(buttonByText("Shut down server")).toBeTruthy();
  });
});
