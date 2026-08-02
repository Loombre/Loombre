// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/forgot/page.test.tsx
//
// E3b/E8: the constant-copy assertion is the whole point of this file — a
// successful submit shows the SAME confirmation regardless of what the
// identifier was, and this test drives it with both an existing-looking
// and a made-up identifier to prove neither changes the outcome. No
// dynamic route param here (unlike /claim, /reset), so the page component
// itself is tested directly.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../components/ui/test-render.js";

const routerPush = vi.fn();
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

const { default: ForgotPasswordPage } = await import("./page.js");

describe("ForgotPasswordPage — E3b/E8 constant-copy anti-enumeration", () => {
  let view: TestRender | null = null;
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    routerPush.mockReset();
    routerReplace.mockReset();
    postSpy = vi.spyOn(LoombreClient.prototype, "post");
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    postSpy.mockRestore();
  });

  function buttonFor(text: string): HTMLButtonElement {
    const button = Array.from(view!.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === text,
    );
    if (!button) throw new Error(`no button labelled "${text}"`);
    return button as HTMLButtonElement;
  }

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

  async function submit(identifier: string): Promise<void> {
    setNativeValue(inputFor("Username or email"), identifier);
    await act(async () => {
      buttonFor("Send reset link").click();
    });
  }

  it("a real-looking account and a made-up one produce the IDENTICAL confirmation copy", async () => {
    postSpy.mockResolvedValue({});
    view = renderIntoBody(<ForgotPasswordPage />);
    await submit("real-admin@example.com");
    const realCopy = view.container.textContent;

    view.unmount();
    postSpy.mockClear();
    postSpy.mockResolvedValue({});
    view = renderIntoBody(<ForgotPasswordPage />);
    await submit("nobody-like-this-exists@example.com");
    const madeUpCopy = view.container.textContent;

    expect(realCopy).toBe(madeUpCopy);
    expect(realCopy).toMatch(/if that account has an email on file/i);
  });

  it("POSTs the identifier as given, unmodified", async () => {
    postSpy.mockResolvedValue({});
    view = renderIntoBody(<ForgotPasswordPage />);
    await submit("someone@example.com");

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [path, options] = postSpy.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/auth/forgot-password");
    expect(options.body).toEqual({ identifier: "someone@example.com" });
  });

  it("a genuine network failure is shown honestly — distinct from the constant confirmation, carries no account info", async () => {
    postSpy.mockRejectedValue(new Error("network down"));
    view = renderIntoBody(<ForgotPasswordPage />);
    await submit("someone@example.com");

    expect(view.container.textContent).toMatch(/could not reach the server/i);
    expect(view.container.textContent).not.toMatch(/if that account has an email on file/i);
  });

  it("a 422 (blank identifier server-side) surfaces as an inline error too", async () => {
    postSpy.mockRejectedValue(new LoombreApiError(422, { title: "identifier must not be empty." }));
    view = renderIntoBody(<ForgotPasswordPage />);
    await submit(" ");

    expect(view.container.textContent).toContain("identifier must not be empty.");
  });

  it("the confirmation screen links back to /login", async () => {
    postSpy.mockResolvedValue({});
    view = renderIntoBody(<ForgotPasswordPage />);
    await submit("someone@example.com");

    const link = Array.from(view.container.querySelectorAll("a")).find((a) => a.textContent === "Back to sign in");
    expect(link?.getAttribute("href")).toBe("/login");
  });
});
