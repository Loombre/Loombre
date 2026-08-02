// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/reset/[token]/ResetPasswordScreen.test.tsx
//
// E3b/E8/M12/M16: happy path + invalid-link coverage. Same
// LoombreClient.prototype spy pattern as ClaimScreen.test.tsx — see that
// file's header.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";

const routerPush = vi.fn();
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

const { ResetPasswordScreen } = await import("./ResetPasswordScreen.js");

describe("ResetPasswordScreen — E3b/E8/M12/M16", () => {
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

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
    });
  }

  it("renders the form immediately — no upfront GET to resolve state from", () => {
    view = renderIntoBody(<ResetPasswordScreen token="tok-1" />);
    expect(view.container.textContent).toMatch(/set a new password/i);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("HAPPY: submit POSTs token+password, then shows a success screen linking to /login", async () => {
    postSpy.mockResolvedValue(undefined);
    view = renderIntoBody(<ResetPasswordScreen token="tok-happy" />);

    setNativeValue(inputFor("New password"), "correct horse battery");
    setNativeValue(inputFor("Confirm new password"), "correct horse battery");
    await click(buttonFor("Reset password"));

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [path, options] = postSpy.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/auth/reset-password");
    expect(options.body).toEqual({ token: "tok-happy", password: "correct horse battery" });

    expect(view.container.textContent).toMatch(/password reset/i);
    const goToSignIn = buttonFor("Go to sign in");
    await click(goToSignIn);
    expect(routerPush).toHaveBeenCalledWith("/login");
  });

  it("password mismatch is rejected client-side, no request made", async () => {
    view = renderIntoBody(<ResetPasswordScreen token="tok-2" />);

    setNativeValue(inputFor("New password"), "aaaaaaaa");
    setNativeValue(inputFor("Confirm new password"), "bbbbbbbb");
    await click(buttonFor("Reset password"));

    expect(postSpy).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/don't match/i);
  });

  it("INVALID: a 404 shows the same generic invalid-link treatment as /claim", async () => {
    postSpy.mockRejectedValue(new LoombreApiError(404, {}));
    view = renderIntoBody(<ResetPasswordScreen token="bad-token" />);

    setNativeValue(inputFor("New password"), "correct horse battery");
    setNativeValue(inputFor("Confirm new password"), "correct horse battery");
    await click(buttonFor("Reset password"));

    expect(view.container.textContent).toMatch(/this reset link isn't valid/i);

    await click(buttonFor("Request a new link"));
    expect(routerPush).toHaveBeenCalledWith("/forgot");
  });

  it("a non-404 rejection shows an inline error and stays on the form", async () => {
    postSpy.mockRejectedValue(new LoombreApiError(429, { title: "Too many attempts." }));
    view = renderIntoBody(<ResetPasswordScreen token="tok-3" />);

    setNativeValue(inputFor("New password"), "correct horse battery");
    setNativeValue(inputFor("Confirm new password"), "correct horse battery");
    await click(buttonFor("Reset password"));

    expect(view.container.textContent).toContain("Too many attempts.");
    expect(view.container.textContent).not.toMatch(/isn't valid/i);
  });
});
