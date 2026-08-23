// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/AddUserSheet.test.tsx
//
// E4/M1: email is no longer part of the required-field gate, and a blank
// field submits null (not "") to CreateUserRequest — the honest
// null-to-clear-equivalent shape for a field that's optional from
// creation, not merely clearable later.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { ToastProvider } from "../../ui/Toast.js";

const apiPostMock = vi.fn();

class FakeApiError extends Error {}

const USERNAME_TAKEN_DETAIL = "A user with the username \"newperson\" already exists.";

vi.mock("../../../lib/api-client.js", () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { AddUserSheet } = await import("./AddUserSheet.js");

const CREATED_USER = {
  id: "user-9",
  username: "newperson",
  email: null,
  displayName: "New Person",
  isAdmin: false,
  birthDate: null,
  maxContentRating: null,
  createdAtMs: 0,
  updatedAtMs: 0,
};

describe("AddUserSheet — E4/M1 optional email", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiPostMock.mockReset();
    // AddUserSheet -> SheetOrModal calls matchMedia unconditionally on
    // every render — jsdom has no real implementation.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      })),
    );
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  function inputFor(labelText: string): HTMLInputElement {
    const label = Array.from(view!.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").startsWith(labelText),
    );
    if (!label) throw new Error(`no field labelled "${labelText}"`);
    return label.querySelector("input")!;
  }

  function setNativeValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function buttonFor(text: string): HTMLButtonElement {
    const button = Array.from(view!.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === text,
    );
    if (!button) throw new Error(`no button labelled "${text}"`);
    return button as HTMLButtonElement;
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
    });
  }

  it("the email field has no `required` attribute and is labelled optional", () => {
    view = renderIntoBody(
      <ToastProvider>
        <AddUserSheet open onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );
    expect(inputFor("Email").hasAttribute("required")).toBe(false);
    const label = Array.from(view.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").startsWith("Email"),
    )!;
    expect(label.textContent).toMatch(/optional/i);
  });

  it("Create user is enabled with name+username+password alone — no email required", () => {
    view = renderIntoBody(
      <ToastProvider>
        <AddUserSheet open onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );
    setNativeValue(inputFor("Name"), "Alex Rivera");
    setNativeValue(inputFor("Username"), "alex");
    setNativeValue(inputFor("Password"), "correct horse battery");

    expect(buttonFor("Create user").hasAttribute("disabled")).toBe(false);
  });

  it("submitting with a blank email sends email: null, not an empty string", async () => {
    apiPostMock.mockResolvedValue(CREATED_USER);
    view = renderIntoBody(
      <ToastProvider>
        <AddUserSheet open onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );
    setNativeValue(inputFor("Name"), "New Person");
    setNativeValue(inputFor("Username"), "newperson");
    setNativeValue(inputFor("Password"), "correct horse battery");
    await click(buttonFor("Create user"));

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPostMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/users");
    expect(options.body["email"]).toBeNull();
  });

  it("a set email still round-trips as the string", async () => {
    apiPostMock.mockResolvedValue(CREATED_USER);
    view = renderIntoBody(
      <ToastProvider>
        <AddUserSheet open onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );
    setNativeValue(inputFor("Name"), "New Person");
    setNativeValue(inputFor("Username"), "newperson");
    setNativeValue(inputFor("Email"), "new@example.com");
    setNativeValue(inputFor("Password"), "correct horse battery");
    await click(buttonFor("Create user"));

    const [, options] = apiPostMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body["email"]).toBe("new@example.com");
  });

  // browser-admin-F5: the sheet rendered `err.message`, built by the SDK
  // from the RFC 9457 problem TITLE alone — an admin saw the bare word
  // "Conflict" with no hint of WHICH field collided.
  it("browser-admin-F5: renders the server's problem detail, never the bare status title", async () => {
    apiPostMock.mockRejectedValue(
      Object.assign(new FakeApiError("Conflict"), {
        problem: { type: "about:blank", title: "Conflict", status: 409, detail: USERNAME_TAKEN_DETAIL },
      }),
    );
    view = renderIntoBody(
      <ToastProvider>
        <AddUserSheet open onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );
    setNativeValue(inputFor("Name"), "New Person");
    setNativeValue(inputFor("Username"), "newperson");
    setNativeValue(inputFor("Password"), "correct horse battery");
    await click(buttonFor("Create user"));
    await act(async () => {});

    const text = view.container.textContent ?? "";
    expect(text).toContain(USERNAME_TAKEN_DETAIL);
    expect(text).not.toContain("Conflict");
  });
});
