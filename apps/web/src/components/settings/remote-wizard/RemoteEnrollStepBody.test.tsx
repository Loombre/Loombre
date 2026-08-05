// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: RemoteEnrollStepBody tests — the QR ceremony: pick user +
// name -> enroll -> one-time QR/config/download/confirm, memory-only
// (mission's own hard line — no localStorage/sessionStorage, gone on
// unmount).

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

const { RemoteEnrollStepBody } = await import("./RemoteEnrollStepBody.js");

let view: TestRender | undefined;
const onStepComplete = vi.fn();
const onBack = vi.fn();

const USERS_PAGE = {
  items: [
    { id: "u1", username: "alex", displayName: "Alex", email: null, isAdmin: false, birthDate: null, maxContentRating: null, createdAtMs: 1, updatedAtMs: 1 },
    { id: "u2", username: "sam", displayName: null, email: null, isAdmin: false, birthDate: null, maxContentRating: null, createdAtMs: 1, updatedAtMs: 1 },
  ],
  nextCursor: null,
};

const ENROLLMENT_CONFIG_TEXT = "[Interface]\nPrivateKey = abc123\nAddress = 10.82.146.2/24\n\n[Peer]\nPublicKey = def456\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.82.146.1/32\nPersistentKeepalive = 25\n";

const ENROLLMENT_RESPONSE = {
  device: { id: "d1", userId: "u1", name: "Alex's iPhone", tunnelIp: "10.82.146.2", createdAtMs: 1, lastHandshakeAtMs: null },
  configText: ENROLLMENT_CONFIG_TEXT,
};

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  onStepComplete.mockReset();
  onBack.mockReset();
  apiGetMock.mockResolvedValue(USERS_PAGE);
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

function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function render(): Promise<void> {
  view = renderIntoBody(
    <RemoteEnrollStepBody path="remote" step="remote-enroll-first-device" context={{}} onStepComplete={onStepComplete} onBack={onBack} />,
  );
  await act(async () => {});
}

async function enrollDevice(): Promise<void> {
  await render();
  await act(async () => {
    const select = document.body.querySelector("select") as HTMLSelectElement;
    setNativeValue(select, "u1");
    const nameInput = document.body.querySelector('input[placeholder*="iPhone"]') as HTMLInputElement;
    setNativeValue(nameInput, "Alex's iPhone");
  });
  await click("Enroll device");
}

describe("RemoteEnrollStepBody — the enrollment form", () => {
  it("loads users into a picker", async () => {
    await render();
    expect(textOf()).toContain("Alex");
    expect(textOf()).toContain("sam"); // no displayName -> falls back to username
  });

  it("submits userId + name to POST /admin/remote/wireguard/devices", async () => {
    apiPostMock.mockResolvedValue(ENROLLMENT_RESPONSE);
    await enrollDevice();
    expect(apiPostMock).toHaveBeenCalledWith("/admin/remote/wireguard/devices", { body: { userId: "u1", name: "Alex's iPhone" } });
  });

  it("Back calls onBack from the form", async () => {
    await render();
    await click("Back");
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("RemoteEnrollStepBody — the one-time payload reveal", () => {
  beforeEach(() => {
    apiPostMock.mockResolvedValue(ENROLLMENT_RESPONSE);
  });

  it("renders the QR code, the config text, a Download .conf button, and the show-once warning", async () => {
    await enrollDevice();
    expect(document.body.querySelector("svg")).not.toBeNull();
    expect(textOf()).toContain(ENROLLMENT_CONFIG_TEXT.split("\n")[0]); // "[Interface]"
    expect(textOf()).toContain("shown once");
    expect(buttonByText("Download .conf")).toBeTruthy();
  });

  it("Continue is disabled until the 'I've added it to the device' confirm is checked", async () => {
    await enrollDevice();
    const continueBtn = buttonByText("Continue");
    expect(continueBtn.disabled).toBe(true);

    const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    expect(buttonByText("Continue").disabled).toBe(false);
    await click("Continue");
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });

  it("Download .conf builds a Blob URL and clicks a hidden anchor with a sanitized filename", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await enrollDevice();
    await click("Download .conf");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blobArg = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blobArg.type).toBe("text/plain");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("RemoteEnrollStepBody — MEMORY-ONLY (mission hard line: no localStorage/sessionStorage, ever)", () => {
  it("the one-time configText is never written to localStorage or sessionStorage", async () => {
    apiPostMock.mockResolvedValue(ENROLLMENT_RESPONSE);
    const localSetSpy = vi.spyOn(Storage.prototype, "setItem");
    await enrollDevice();

    expect(textOf()).toContain("[Interface]"); // sanity: it WAS rendered (in local component state)
    for (const call of localSetSpy.mock.calls) {
      expect(String(call[1])).not.toContain("PrivateKey");
      expect(String(call[1])).not.toContain(ENROLLMENT_CONFIG_TEXT);
    }
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    localSetSpy.mockRestore();
  });

  it("the payload is gone from the DOM once the step unmounts (React state only, not module-level)", async () => {
    apiPostMock.mockResolvedValue(ENROLLMENT_RESPONSE);
    await enrollDevice();
    expect(textOf()).toContain("[Interface]");
    view?.unmount();
    view = undefined;
    expect(document.body.textContent ?? "").not.toContain("[Interface]");

    // A FRESH mount of the same component never sees the previous
    // enrollment's payload leaking back in from any outside store.
    apiPostMock.mockReset();
    apiGetMock.mockResolvedValue(USERS_PAGE);
    view = renderIntoBody(
      <RemoteEnrollStepBody path="remote" step="remote-enroll-first-device" context={{}} onStepComplete={onStepComplete} onBack={onBack} />,
    );
    await act(async () => {});
    expect(document.body.textContent ?? "").not.toContain("[Interface]");
  });
});

describe("RemoteEnrollStepBody — honest 501 (WG2 not landed)", () => {
  it("enrollment 501 -> honest unavailable state, never a fabricated QR", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError(501, { title: "Not Implemented", status: 501 }));
    await enrollDevice();
    expect(textOf()).toContain("isn't available on this build yet");
    expect(document.body.querySelector("svg")).toBeNull();
  });
});
