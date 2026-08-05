// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: PathManagementCard tests — mission item 4 (switch/disable
// flows). Mirrors ServerPowerCard.test.tsx's harness (vi.mock of
// api-client BEFORE a top-level-await import; renderIntoBody; act) — the
// same house convention every Settings card test in this repo uses.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import type { components } from "@loombre/sdk";

type RemoteState = components["schemas"]["RemoteState"];

const apiPostMock = vi.fn();

// Mirrors packages/sdk/src/client.ts's real LoombreApiError: `.message` is
// the problem's `title` (falling back to a generic string) — the component
// under test surfaces `.message` directly (ActiveNoticeCard's exact
// convention), so the fake must compute it the same way or a test would
// pass against a message shape the real SDK never produces.
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
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { PathManagementCard } = await import("./PathManagementCard.js");

const REMOTE_ACTIVE: RemoteState = {
  activePath: "remote",
  wireguard: { enabled: true, listening: true, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: "example.com", peerCount: 3 },
  tunnel: { enabled: false, connectorState: "stopped", hostname: null, backoffMs: null, lastErrorMessage: null },
  direct: { enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null },
};

const TUNNEL_ACTIVE: RemoteState = {
  activePath: "tunnel",
  wireguard: { enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 },
  tunnel: { enabled: true, connectorState: "running", hostname: "loombre.example.com", backoffMs: null, lastErrorMessage: null },
  direct: { enabled: false, mode: null, domain: null, certValid: null, certExpiresAtMs: null },
};

const DIRECT_ACTIVE: RemoteState = {
  activePath: "direct",
  wireguard: { enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 },
  tunnel: { enabled: false, connectorState: "stopped", hostname: null, backoffMs: null, lastErrorMessage: null },
  direct: { enabled: true, mode: "acme", domain: "loombre.example.com", certValid: true, certExpiresAtMs: 1_800_000_000_000 },
};

let view: TestRender | undefined;
const onSwitchPath = vi.fn();
const onChanged = vi.fn();

beforeEach(() => {
  apiPostMock.mockReset();
  onSwitchPath.mockReset();
  onChanged.mockReset();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

async function render(state: RemoteState): Promise<void> {
  view = renderIntoBody(<PathManagementCard state={state} onSwitchPath={onSwitchPath} onChanged={onChanged} />);
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

async function click(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).click();
  });
}

describe("PathManagementCard — per-path summary", () => {
  it("Remote: shows listener/peer/subnet status and a devices-list link", async () => {
    await render(REMOTE_ACTIVE);
    expect(textOf()).toContain("Loombre Remote");
    expect(textOf()).toContain("Listening");
    expect(textOf()).toContain("51820");
    expect(textOf()).toContain("3"); // peerCount
    const link = document.body.querySelector('a[href="/settings/devices"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Manage enrolled devices");
  });

  it("Tunnel: shows connector/hostname status and NO devices-list link", async () => {
    await render(TUNNEL_ACTIVE);
    expect(textOf()).toContain("Tunnel");
    expect(textOf()).toContain("running");
    expect(textOf()).toContain("loombre.example.com");
    expect(document.body.querySelector('a[href="/settings/devices"]')).toBeNull();
  });

  it("Direct: shows mode/domain/certificate status and NO devices-list link", async () => {
    await render(DIRECT_ACTIVE);
    expect(textOf()).toContain("Direct");
    expect(textOf()).toContain("acme");
    expect(textOf()).toContain("Valid");
    expect(document.body.querySelector('a[href="/settings/devices"]')).toBeNull();
  });

  it("always renders the posture-card seam for U3", async () => {
    await render(REMOTE_ACTIVE);
    expect(document.body.querySelector('[data-testid="posture-card-slot"]')).not.toBeNull();
  });
});

describe("PathManagementCard — disable flow", () => {
  it("shows a danger confirm block before disabling; Cancel makes no API call", async () => {
    await render(REMOTE_ACTIVE);
    await click("Disable…");
    expect(textOf()).toContain("Disable Loombre Remote?");
    expect(apiPostMock).not.toHaveBeenCalled();
    await click("Cancel");
    expect(textOf()).not.toContain("Disable Loombre Remote?");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("marks every DISABLE_VERIFICATION_STEPS entry done together (a 200 verifies all steps atomically — never a fabricated incremental animation)", async () => {
    apiPostMock.mockResolvedValue({});
    await render(REMOTE_ACTIVE);
    await click("Disable…");
    await click("Disable Loombre Remote");
    const doneItems = Array.from(document.body.querySelectorAll('li[data-done="true"]'));
    expect(doneItems.length).toBe(2); // remote's DISABLE_VERIFICATION_STEPS: revoke-peers, drop-listeners
  });
});

describe("PathManagementCard — disable flow, per path", () => {
  it("Remote disable: POSTs wireguard/disable, shows teardown checklist all-done, calls onChanged", async () => {
    apiPostMock.mockResolvedValue({});
    await render(REMOTE_ACTIVE);
    await click("Disable…");
    await click("Disable Loombre Remote");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[0]).toBe("/admin/remote/wireguard/disable");
    expect(textOf()).toContain("Revoke every enrolled device key");
    expect(textOf()).toContain("Stop listening for connections");
    expect(textOf()).toContain("verified");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onSwitchPath).not.toHaveBeenCalled();
  });

  it("Tunnel disable: POSTs tunnel/disable", async () => {
    apiPostMock.mockResolvedValue({});
    await render(TUNNEL_ACTIVE);
    await click("Disable…");
    await click("Disable Tunnel");
    expect(apiPostMock.mock.calls[0]?.[0]).toBe("/admin/remote/tunnel/disable");
    expect(textOf()).toContain("Stop the tunnel connector");
  });

  it("Direct disable: POSTs direct/disable", async () => {
    apiPostMock.mockResolvedValue({});
    await render(DIRECT_ACTIVE);
    await click("Disable…");
    await click("Disable Direct");
    expect(apiPostMock.mock.calls[0]?.[0]).toBe("/admin/remote/direct/disable");
  });

  it("a 501 (not implemented on this build) is shown honestly, not as a generic error, and returns to idle", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    await render(REMOTE_ACTIVE);
    await click("Disable…");
    await click("Disable Loombre Remote");
    expect(textOf()).toContain("isn't available in this build yet");
    expect(onChanged).not.toHaveBeenCalled();
    await click("OK");
    expect(buttonByText("Disable…")).toBeTruthy();
  });

  it("a real failure shows the error and returns to an actionable idle state (InvitesPanel regression class)", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(500, { title: "boom", status: 500 }));
    await render(REMOTE_ACTIVE);
    await click("Disable…");
    await click("Disable Loombre Remote");
    expect(textOf()).toContain("boom");
    expect(buttonByText("Disable…")).toBeTruthy();
    expect(buttonByText("Switch path…")).toBeTruthy();
  });
});

describe("PathManagementCard — switch flow (R8: switch = verified teardown then enable)", () => {
  it("shows a switch-specific confirm; confirming tears down the SAME way as disable, then calls onSwitchPath instead of settling idle", async () => {
    apiPostMock.mockResolvedValue({});
    await render(REMOTE_ACTIVE);
    await click("Switch path…");
    expect(textOf()).toContain("Switch away from Loombre Remote?");
    await click("Disable and switch");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls[0]?.[0]).toBe("/admin/remote/wireguard/disable");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onSwitchPath).toHaveBeenCalledTimes(1);
  });

  it("a 501 during switch teardown does NOT call onSwitchPath — stays honestly unavailable", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    await render(REMOTE_ACTIVE);
    await click("Switch path…");
    await click("Disable and switch");
    expect(textOf()).toContain("isn't available in this build yet");
    expect(onSwitchPath).not.toHaveBeenCalled();
  });
});
