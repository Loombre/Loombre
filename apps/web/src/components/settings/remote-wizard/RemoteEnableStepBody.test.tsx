// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: RemoteEnableStepBody tests — the Remote path's first real
// step (enable + WG-app pointer + UDP port-forward card), mirroring
// PathManagementCard.test.tsx's vi.mock-before-top-level-await harness.

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

const { RemoteEnableStepBody } = await import("./RemoteEnableStepBody.js");

let view: TestRender | undefined;
const onStepComplete = vi.fn();
const onBack = vi.fn();

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  onStepComplete.mockReset();
  onBack.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
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
    <RemoteEnableStepBody path="remote" step="remote-enable" context={{}} onStepComplete={onStepComplete} onBack={onBack} />,
  );
  await act(async () => {});
}

const DISABLED_STATUS = { enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 };
const ENABLED_STATUS = { enabled: true, listening: true, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: "vpn.example.com", peerCount: 0 };

describe("RemoteEnableStepBody — enable flow", () => {
  it("shows an idle Enable button when not yet enabled", async () => {
    apiGetMock.mockResolvedValue(DISABLED_STATUS);
    await render();
    expect(textOf()).toContain("Enable Loombre Remote");
    expect(buttonByText("Enable Loombre Remote")).toBeTruthy();
  });

  it("enabling shows status, the WireGuard install pointer, and the UDP port-forward card", async () => {
    apiGetMock.mockResolvedValue(DISABLED_STATUS);
    apiPostMock.mockResolvedValue(ENABLED_STATUS);
    await render();
    await click("Enable Loombre Remote");
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/wireguard/enable", {});
    expect(textOf()).toContain("51820");
    expect(textOf()).toContain("10.82.146.0/24");
    expect(textOf()).toContain("Install the WireGuard app");
    const link = document.body.querySelector('a[href="https://www.wireguard.com/install/"]');
    expect(link).not.toBeNull();
    expect(textOf()).toContain("Forward a port on your router");
    expect(textOf()).toContain("UDP port 51820");
  });

  it("re-entering the step when already enabled skips straight to the success view", async () => {
    apiGetMock.mockResolvedValue(ENABLED_STATUS);
    await render();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(textOf()).toContain("Loombre Remote is on");
    expect(textOf()).toContain("Continue");
  });

  it("switching the router brand renders that brand's own instructions", async () => {
    apiGetMock.mockResolvedValue(ENABLED_STATUS);
    await render();
    const netgear = Array.from(document.body.querySelectorAll('[role="radio"]')).find((r) =>
      (r.textContent ?? "").includes("Netgear"),
    ) as HTMLButtonElement;
    await act(async () => {
      netgear.click();
    });
    expect(textOf()).toContain("routerlogin.net");
  });

  it("Continue calls onStepComplete; Back calls onBack", async () => {
    apiGetMock.mockResolvedValue(ENABLED_STATUS);
    await render();
    await click("Back");
    expect(onBack).toHaveBeenCalledTimes(1);
    await click("Continue");
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});

describe("RemoteEnableStepBody — honest 501 (WG1/WG2 not landed on this build)", () => {
  it("status fetch 501 -> honest unavailable state", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    await render();
    expect(textOf()).toContain("isn't available on this build yet");
  });

  it("enable 501 -> honest unavailable state, no fabricated success", async () => {
    apiGetMock.mockResolvedValue(DISABLED_STATUS);
    apiPostMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    await render();
    await click("Enable Loombre Remote");
    expect(textOf()).toContain("isn't available on this build yet");
  });
});

describe("RemoteEnableStepBody — real failure", () => {
  it("a non-501 enable failure shows the error and stays actionable", async () => {
    apiGetMock.mockResolvedValue(DISABLED_STATUS);
    apiPostMock.mockRejectedValue(new FakeApiError(409, { title: "A different path is already active" }));
    await render();
    await click("Enable Loombre Remote");
    expect(textOf()).toContain("A different path is already active");
    expect(buttonByText("Enable Loombre Remote")).toBeTruthy();
  });
});
