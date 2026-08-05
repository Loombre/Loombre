// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: TunnelTokenStepBody tests — masked write-only token input,
// MailCredentialsCard's three-state pattern, validation feedback incl.
// missing-scopes detail.

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

const { TunnelTokenStepBody } = await import("./TunnelTokenStepBody.js");

let view: TestRender | undefined;
const onStepComplete = vi.fn();
const onBack = vi.fn();

const NOT_CONFIGURED_STATUS = {
  enabled: false,
  connectorState: "stopped",
  hostname: null,
  backoffMs: null,
  lastErrorMessage: null,
  tokenConfigured: false,
  tokenSetAtMs: null,
  tokenScopesOk: null,
};

const CONFIGURED_STATUS = {
  ...NOT_CONFIGURED_STATUS,
  tokenConfigured: true,
  tokenSetAtMs: 1_754_000_000_000,
  tokenScopesOk: true,
};

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

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
    <TunnelTokenStepBody path="tunnel" step="tunnel-token" context={{}} onStepComplete={onStepComplete} onBack={onBack} />,
  );
  await act(async () => {});
}

async function typeToken(value: string): Promise<void> {
  await act(async () => {
    const input = document.body.querySelector('input[type="password"]') as HTMLInputElement;
    setNativeValue(input, value);
  });
}

describe("TunnelTokenStepBody — not yet configured", () => {
  it("starts in the replacing (masked input) state when no token is configured", async () => {
    apiGetMock.mockResolvedValue(NOT_CONFIGURED_STATUS);
    await render();
    expect(document.body.querySelector('input[type="password"]')).not.toBeNull();
    expect(buttonByText("Continue").disabled).toBe(true);
  });

  it("a valid token saves, refetches status, and enables Continue", async () => {
    apiGetMock.mockResolvedValueOnce(NOT_CONFIGURED_STATUS).mockResolvedValueOnce(CONFIGURED_STATUS);
    apiPostMock.mockResolvedValue({ valid: true, detail: null });
    await render();
    await typeToken("cf-token-abc");
    await click("Validate & save");
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/tunnel/token", { body: { token: "cf-token-abc" } });
    expect(textOf()).toContain("TOKEN CONFIGURED");
    expect(buttonByText("Continue").disabled).toBe(false);
  });

  it("an invalid token shows the server's missing-scopes detail and stays editable", async () => {
    apiGetMock.mockResolvedValue(NOT_CONFIGURED_STATUS);
    apiPostMock.mockResolvedValue({ valid: false, detail: "Token is missing the Cloudflare Tunnel:Edit scope." });
    await render();
    await typeToken("cf-token-bad");
    await click("Validate & save");
    expect(textOf()).toContain("Token is missing the Cloudflare Tunnel:Edit scope.");
    expect(document.body.querySelector('input[type="password"]')).not.toBeNull();
    expect(buttonByText("Continue").disabled).toBe(true);
  });
});

describe("TunnelTokenStepBody — already configured (re-entry)", () => {
  it("shows the idle status view with a Replace option, Continue already enabled", async () => {
    apiGetMock.mockResolvedValue(CONFIGURED_STATUS);
    await render();
    expect(textOf()).toContain("TOKEN CONFIGURED");
    expect(buttonByText("Continue").disabled).toBe(false);
    expect(buttonByText("Replace token")).toBeTruthy();
  });
});

describe("TunnelTokenStepBody — navigation", () => {
  it("Back calls onBack; Continue calls onStepComplete once enabled", async () => {
    apiGetMock.mockResolvedValue(CONFIGURED_STATUS);
    await render();
    await click("Back");
    expect(onBack).toHaveBeenCalledTimes(1);
    await click("Continue");
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});
