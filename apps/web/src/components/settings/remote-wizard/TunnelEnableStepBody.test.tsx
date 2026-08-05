// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: TunnelEnableStepBody tests — hostname entry, enable, and
// connector-health polling (HardwareStep.tsx's own setInterval pattern).

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

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
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { TunnelEnableStepBody } = await import("./TunnelEnableStepBody.js");

let view: TestRender | undefined;
const onStepComplete = vi.fn();
const onBack = vi.fn();

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const STARTING_STATUS = {
  enabled: true,
  connectorState: "starting",
  hostname: "loombre.example.com",
  backoffMs: null,
  lastErrorMessage: null,
  tokenConfigured: true,
  tokenSetAtMs: 1,
  tokenScopesOk: true,
};

const RUNNING_STATUS = { ...STARTING_STATUS, connectorState: "running" };

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  onStepComplete.mockReset();
  onBack.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

function textOf(): string {
  return document.body.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const match = buttons.find((b) => (b.textContent ?? "").includes(label));
  if (!match) throw new Error(`no button containing "${label}" — buttons: ${buttons.map((b) => b.textContent).join(" | ")}`);
  return match;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).click();
  });
}

async function render(): Promise<void> {
  view = renderIntoBody(
    <TunnelEnableStepBody path="tunnel" step="tunnel-enable" context={{}} onStepComplete={onStepComplete} onBack={onBack} />,
  );
  await act(async () => {});
}

describe("TunnelEnableStepBody — hostname entry + enable", () => {
  it("requires a hostname before enabling", async () => {
    await render();
    await click("Enable the tunnel");
    expect(textOf()).toContain("Enter the public hostname");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("enabling posts the hostname and shows connector health immediately (Continue does not wait for 'running')", async () => {
    apiPostMock.mockResolvedValue(STARTING_STATUS);
    apiGetMock.mockResolvedValue(STARTING_STATUS);
    await render();
    await act(async () => {
      setNativeValue(document.body.querySelector("input") as HTMLInputElement, "loombre.example.com");
    });
    await click("Enable the tunnel");
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/tunnel/enable", { body: { hostname: "loombre.example.com" } });
    expect(textOf()).toContain("Starting…");
    expect(textOf()).toContain("loombre.example.com");
    expect(buttonByText("Continue")).toBeTruthy();
  });

  it("a failed enable shows the error and does not transition to the health view", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(409, { title: "Cannot enable: a different path is active" }));
    await render();
    await act(async () => {
      setNativeValue(document.body.querySelector("input") as HTMLInputElement, "loombre.example.com");
    });
    await click("Enable the tunnel");
    expect(textOf()).toContain("Cannot enable: a different path is active");
    expect(document.body.querySelector("input")).not.toBeNull(); // still the hostname form
  });
});

describe("TunnelEnableStepBody — connector-health polling (HardwareStep pattern)", () => {
  it("polls GET /admin/remote/tunnel/status on an interval once enabled, reflecting connectorState transitions", async () => {
    vi.useFakeTimers();
    apiPostMock.mockResolvedValue(STARTING_STATUS);
    apiGetMock.mockResolvedValue(STARTING_STATUS);

    view = renderIntoBody(
      <TunnelEnableStepBody path="tunnel" step="tunnel-enable" context={{}} onStepComplete={onStepComplete} onBack={onBack} />,
    );
    await act(async () => {});
    await act(async () => {
      setNativeValue(document.body.querySelector("input") as HTMLInputElement, "loombre.example.com");
    });
    await act(async () => {
      buttonByText("Enable the tunnel").click();
    });
    expect(textOf()).toContain("Starting…");

    apiGetMock.mockResolvedValue(RUNNING_STATUS);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(textOf()).toContain("Running");
  });

  it("surfaces lastErrorMessage and backoffMs from a degraded poll", async () => {
    vi.useFakeTimers();
    const degraded = { ...STARTING_STATUS, connectorState: "degraded", lastErrorMessage: "token expired", backoffMs: 4_000 };
    apiPostMock.mockResolvedValue(STARTING_STATUS);
    apiGetMock.mockResolvedValue(degraded);

    view = renderIntoBody(
      <TunnelEnableStepBody path="tunnel" step="tunnel-enable" context={{}} onStepComplete={onStepComplete} onBack={onBack} />,
    );
    await act(async () => {});
    await act(async () => {
      setNativeValue(document.body.querySelector("input") as HTMLInputElement, "loombre.example.com");
    });
    await act(async () => {
      buttonByText("Enable the tunnel").click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(textOf()).toContain("Degraded");
    expect(textOf()).toContain("token expired");
    expect(textOf()).toContain("4s");
  });

  it("stops polling on unmount (no state updates after teardown)", async () => {
    vi.useFakeTimers();
    apiPostMock.mockResolvedValue(STARTING_STATUS);
    apiGetMock.mockResolvedValue(STARTING_STATUS);

    view = renderIntoBody(
      <TunnelEnableStepBody path="tunnel" step="tunnel-enable" context={{}} onStepComplete={onStepComplete} onBack={onBack} />,
    );
    await act(async () => {});
    await act(async () => {
      setNativeValue(document.body.querySelector("input") as HTMLInputElement, "loombre.example.com");
    });
    await act(async () => {
      buttonByText("Enable the tunnel").click();
    });
    const callsBeforeUnmount = apiGetMock.mock.calls.length;
    view.unmount();
    view = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(apiGetMock.mock.calls.length).toBe(callsBeforeUnmount);
  });
});

describe("TunnelEnableStepBody — navigation", () => {
  it("Back calls onBack before enabling; Continue calls onStepComplete once enabled", async () => {
    apiPostMock.mockResolvedValue(STARTING_STATUS);
    apiGetMock.mockResolvedValue(STARTING_STATUS);
    await render();
    await click("Back");
    expect(onBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      setNativeValue(document.body.querySelector("input") as HTMLInputElement, "loombre.example.com");
    });
    await click("Enable the tunnel");
    await click("Continue");
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});
