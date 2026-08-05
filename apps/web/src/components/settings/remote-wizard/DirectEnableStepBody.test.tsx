// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: DirectEnableStepBody tests — branches on context.directMode:
// acme (confirm-only, GET /admin/remote/state) vs reverse-proxy
// (trust-proxy guidance + enableRemoteDirect itself), both ending at the
// restart-needed handoff pointing at /settings/server.

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

const { DirectEnableStepBody } = await import("./DirectEnableStepBody.js");

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

async function render(directMode: "acme" | "reverse-proxy"): Promise<void> {
  view = renderIntoBody(
    <DirectEnableStepBody
      path="direct"
      step="direct-enable"
      context={{ directMode }}
      onStepComplete={onStepComplete}
      onBack={onBack}
    />,
  );
  await act(async () => {});
}

describe("DirectEnableStepBody — acme branch (confirm-only, already enabled by the previous step)", () => {
  it("reads GET /admin/remote/state and shows the domain/cert confirmation + restart handoff", async () => {
    apiGetMock.mockResolvedValue({
      activePath: "direct",
      wireguard: { enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 },
      tunnel: { enabled: false, connectorState: "stopped", hostname: null, backoffMs: null, lastErrorMessage: null, tokenConfigured: false, tokenSetAtMs: null, tokenScopesOk: null },
      direct: { enabled: true, mode: "acme", domain: "media.example.com", certValid: true, certExpiresAtMs: 1 },
    });
    await render("acme");
    expect(apiPostMock).not.toHaveBeenCalled(); // confirm-only, no new mutation
    expect(textOf()).toContain("media.example.com");
    expect(textOf()).toContain("restart is needed");
    const link = document.body.querySelector('a[href="/settings/server"]');
    expect(link).not.toBeNull();
  });

  it("a 501 confirmation read never blocks the already-known 'enabled' fact — degrades quietly instead", async () => {
    apiGetMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    await render("acme");
    expect(textOf()).toContain("Direct access is enabled");
    expect(textOf()).toContain("Live confirmation details aren't available on this build yet.");
    expect(textOf()).toContain("restart is needed");
  });

  it("Continue calls onStepComplete; Back calls onBack", async () => {
    apiGetMock.mockResolvedValue({
      activePath: "direct",
      wireguard: { enabled: false, listening: false, listenPort: 51820, subnet: "10.82.146.0/24", endpointHost: null, peerCount: 0 },
      tunnel: { enabled: false, connectorState: "stopped", hostname: null, backoffMs: null, lastErrorMessage: null, tokenConfigured: false, tokenSetAtMs: null, tokenScopesOk: null },
      direct: { enabled: true, mode: "acme", domain: "media.example.com", certValid: true, certExpiresAtMs: 1 },
    });
    await render("acme");
    await click("Back");
    expect(onBack).toHaveBeenCalledTimes(1);
    await click("Continue");
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});

describe("DirectEnableStepBody — reverse-proxy branch (trust-proxy guidance + its own enable call)", () => {
  it("shows trust-proxy guidance and a docs reference before enabling", async () => {
    await render("reverse-proxy");
    expect(textOf()).toContain("network.trustProxy");
    expect(textOf()).toContain("docs/ops/reverse-proxy.md");
    expect(buttonByText("Enable Direct access")).toBeTruthy();
  });

  it("enabling posts mode:reverse-proxy with no domain, then shows the restart handoff", async () => {
    apiPostMock.mockResolvedValue({ enabled: true, mode: "reverse-proxy", domain: null, certValid: null, certExpiresAtMs: null });
    await render("reverse-proxy");
    await click("Enable Direct access");
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/direct/enable", { body: { mode: "reverse-proxy" } });
    expect(textOf()).toContain("reverse-proxy mode");
    expect(textOf()).toContain("restart is needed");
  });

  it("surfaces the server's trust-proxy-not-configured error honestly", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(422, { title: "network.trustProxy is not configured — set it from Settings before enabling the Direct path in reverse-proxy mode." }));
    await render("reverse-proxy");
    await click("Enable Direct access");
    expect(textOf()).toContain("network.trustProxy is not configured");
    expect(buttonByText("Enable Direct access")).toBeTruthy();
  });
});
