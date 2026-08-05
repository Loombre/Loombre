// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: DirectAcmeTestStepBody tests — domain entry, staged
// testRemoteDirectAcme run, failureStage guidance for EACH stage, then
// enableRemoteDirect + the restart-needed handoff copy.

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { ACME_FAILURE_STAGE_GUIDANCE } from "./acme-failure-stage.js";

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
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { DirectAcmeTestStepBody } = await import("./DirectAcmeTestStepBody.js");

let view: TestRender | undefined;
const onStepComplete = vi.fn();
const onBack = vi.fn();

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
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
    <DirectAcmeTestStepBody path="direct" step="direct-acme-test" context={{ directMode: "acme" }} onStepComplete={onStepComplete} onBack={onBack} />,
  );
  await act(async () => {});
}

async function enterDomain(domain: string): Promise<void> {
  await act(async () => {
    setNativeValue(document.body.querySelector("input") as HTMLInputElement, domain);
  });
}

describe("DirectAcmeTestStepBody — domain entry + staged test", () => {
  it("requires a domain before testing", async () => {
    await render();
    await click("Test certificate issuance");
    expect(textOf()).toContain("Enter the domain");
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("a successful test shows the success detail and an Enable button", async () => {
    apiPostMock.mockResolvedValue({ success: true, detail: "Certificate issued for media.example.com, valid until 2027." });
    await render();
    await enterDomain("media.example.com");
    await click("Test certificate issuance");
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/direct/acme-test", { body: { domain: "media.example.com" } });
    expect(textOf()).toContain("Certificate issued for media.example.com");
    expect(buttonByText("Enable Direct access")).toBeTruthy();
  });

  it("editing the domain after a successful test invalidates it (re-test required, never enables a stale domain)", async () => {
    apiPostMock.mockResolvedValue({ success: true, detail: "Certificate issued." });
    await render();
    await enterDomain("media.example.com");
    await click("Test certificate issuance");
    expect(buttonByText("Enable Direct access")).toBeTruthy();

    await enterDomain("other.example.com");
    expect(document.body.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(() => buttonByText("Enable Direct access")).toThrow();
    expect(buttonByText("Test certificate issuance")).toBeTruthy();
  });
});

describe("DirectAcmeTestStepBody — failureStage guidance, one per stage", () => {
  const cases: Array<{ detail: string; guidance: string }> = [
    { detail: "listen EADDRINUSE: address already in use 0.0.0.0:80", guidance: ACME_FAILURE_STAGE_GUIDANCE.portBind },
    {
      detail: '403 urn:ietf:params:acme:error:unauthorized :: The client lacks sufficient authorization',
      guidance: ACME_FAILURE_STAGE_GUIDANCE.challengeUnreachable,
    },
    { detail: "urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up A for media.example.com", guidance: ACME_FAILURE_STAGE_GUIDANCE.dns },
    { detail: "403 urn:ietf:params:acme:error:rateLimited :: too many certificates", guidance: ACME_FAILURE_STAGE_GUIDANCE.rateLimited },
    { detail: "something completely unexpected", guidance: ACME_FAILURE_STAGE_GUIDANCE.unknown },
  ];

  for (const { detail, guidance } of cases) {
    it(`renders the right guidance for detail: "${detail.slice(0, 40)}..."`, async () => {
      apiPostMock.mockResolvedValue({ success: false, detail });
      await render();
      await enterDomain("media.example.com");
      await click("Test certificate issuance");
      expect(textOf()).toContain(detail);
      expect(textOf()).toContain(guidance);
      // A failed test still offers Test again (retry), never Enable.
      expect(buttonByText("Test certificate issuance")).toBeTruthy();
      expect(() => buttonByText("Enable Direct access")).toThrow();
    });
  }
});

describe("DirectAcmeTestStepBody — enable + restart-needed handoff", () => {
  it("enabling calls enableRemoteDirect with mode:acme and the tested domain, then shows the restart-needed handoff", async () => {
    apiPostMock.mockResolvedValueOnce({ success: true, detail: "Certificate issued." }).mockResolvedValueOnce({
      enabled: true,
      mode: "acme",
      domain: "media.example.com",
      certValid: true,
      certExpiresAtMs: 1,
    });
    await render();
    await enterDomain("media.example.com");
    await click("Test certificate issuance");
    await click("Enable Direct access");
    expect(apiPostMock).toHaveBeenLastCalledWith("/admin/remote/direct/enable", { body: { mode: "acme", domain: "media.example.com" } });
    expect(textOf()).toContain("restart is needed");
    expect(buttonByText("Continue")).toBeTruthy();
  });

  it("a failed enable stays on the tested view with the error shown", async () => {
    apiPostMock
      .mockResolvedValueOnce({ success: true, detail: "Certificate issued." })
      .mockRejectedValueOnce(new FakeApiError(422, { title: "No valid certificate found for this domain" }));
    await render();
    await enterDomain("media.example.com");
    await click("Test certificate issuance");
    await click("Enable Direct access");
    expect(textOf()).toContain("No valid certificate found for this domain");
    expect(buttonByText("Enable Direct access")).toBeTruthy();
  });

  it("Continue calls onStepComplete only once enabled; Back calls onBack", async () => {
    apiPostMock.mockResolvedValueOnce({ success: true, detail: "ok" }).mockResolvedValueOnce({
      enabled: true,
      mode: "acme",
      domain: "media.example.com",
      certValid: true,
      certExpiresAtMs: 1,
    });
    await render();
    await click("Back");
    expect(onBack).toHaveBeenCalledTimes(1);
    await enterDomain("media.example.com");
    await click("Test certificate issuance");
    await click("Enable Direct access");
    await click("Continue");
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});
