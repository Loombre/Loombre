// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/reset/[token]/ResetPasswordScreen.test.tsx
//
// E3b/E8/M12/M16: happy path + invalid-link coverage. Same
// LoombreClient.prototype spy pattern as ClaimScreen.test.tsx — see that
// file's header.
//
// LD-15 (rc.6): this screen now PROBES the token with a GET at mount
// (previously it rendered the form unconditionally and only learned the
// link was dead from a 404 on submit), so every case here goes through
// that fetch. `getSpy` defaults to a live-token resolve in beforeEach —
// the cases that care about the probe's outcome override it — and each
// render is followed by `await act(async () => {})` to let the probe
// settle, the same shape ClaimScreen.test.tsx uses.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";
import { getAuthStore } from "../../../lib/auth-store.js";

const routerPush = vi.fn();
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

const { ResetPasswordScreen } = await import("./ResetPasswordScreen.js");

describe("ResetPasswordScreen — E3b/E8/M12/M16", () => {
  let view: TestRender | null = null;
  let getSpy: ReturnType<typeof vi.spyOn>;
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    routerPush.mockReset();
    routerReplace.mockReset();
    getSpy = vi.spyOn(LoombreClient.prototype, "get");
    // Default: the link is live. PasswordResetState is deliberately empty
    // (contract) — the 200 itself is the whole signal.
    getSpy.mockResolvedValue({});
    postSpy = vi.spyOn(LoombreClient.prototype, "post");
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    getSpy.mockRestore();
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

  // LD-15 (rc.6): the four cases below are the page-load probe itself —
  // live, dead, unreachable — plus the submit-time 404 the probe does NOT
  // replace.
  it("LIVE: the token is probed at page load, then the form renders", async () => {
    view = renderIntoBody(<ResetPasswordScreen token="tok-1" />);
    await act(async () => {});

    expect(getSpy).toHaveBeenCalledTimes(1);
    const [path, options] = getSpy.mock.calls[0] as [string, { params: { path: { token: string } } }];
    expect(path).toBe("/auth/reset-password/{token}");
    expect(options).toEqual({ params: { path: { token: "tok-1" } } });

    expect(view.container.textContent).toMatch(/set a new password/i);
    // The probe never consumes anything — nothing is submitted on load.
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("INVALID ON LOAD: a dead token shows the invalid-link screen with NO password form", async () => {
    getSpy.mockRejectedValue(new LoombreApiError(404, {}));
    view = renderIntoBody(<ResetPasswordScreen token="garbage-token" />);
    await act(async () => {});

    expect(view.container.textContent).toMatch(/this reset link isn't valid/i);
    // THE DEFECT LD-15 CLOSES: the viewer must not be asked to type a new
    // password twice before learning the link is dead.
    expect(view.container.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(view.container.textContent).not.toMatch(/set a new password/i);
    expect(postSpy).not.toHaveBeenCalled();

    await click(buttonFor("Request a new link"));
    expect(routerPush).toHaveBeenCalledWith("/forgot");
  });

  it("LOAD ERROR: a non-404 probe failure is never reported as a dead token", async () => {
    getSpy.mockRejectedValue(new Error("network down"));
    view = renderIntoBody(<ResetPasswordScreen token="tok-unreachable" />);
    await act(async () => {});

    expect(view.container.textContent).toMatch(/couldn't check this reset link/i);
    expect(view.container.textContent).not.toMatch(/isn't valid/i);
    // A retry affordance, not a dead end (window.location.reload is not
    // clicked here — jsdom has no navigation to run).
    expect(buttonFor("Try again")).toBeTruthy();
  });

  it("HAPPY: submit POSTs token+password, then shows a success screen linking to /login", async () => {
    postSpy.mockResolvedValue(undefined);
    view = renderIntoBody(<ResetPasswordScreen token="tok-happy" />);
    await act(async () => {});

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
    await act(async () => {});

    setNativeValue(inputFor("New password"), "aaaaaaaa");
    setNativeValue(inputFor("Confirm new password"), "bbbbbbbb");
    await click(buttonFor("Reset password"));

    expect(postSpy).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/don't match/i);
  });

  // The probe does NOT replace this guard: a token consumed between the
  // GET and the POST still lands here, exactly as on /claim.
  it("INVALID: a 404 ON SUBMIT (after a live probe) shows the same generic invalid-link treatment as /claim", async () => {
    postSpy.mockRejectedValue(new LoombreApiError(404, {}));
    view = renderIntoBody(<ResetPasswordScreen token="bad-token" />);
    await act(async () => {});

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
    await act(async () => {});

    setNativeValue(inputFor("New password"), "correct horse battery");
    setNativeValue(inputFor("Confirm new password"), "correct horse battery");
    await click(buttonFor("Reset password"));

    expect(view.container.textContent).toContain("Too many attempts.");
    expect(view.container.textContent).not.toMatch(/isn't valid/i);
  });
});

// ── d3-d4 (browser-shell-browse-F2 spillover): this screen resolved the
//    auth store alone, so it ignored a corrected sign-in pill and, on a
//    never-authenticated browser, posted at the same-origin GUESS instead
//    of the address the viewer actually typed on /login. The reset link
//    that brought them here is almost always opened on a browser with no
//    session at all, which is exactly the case the guess gets wrong.
//    resolvePublicServerUrl() is the one order every public page uses.
//
//    These drive the REAL LoombreClient against a stubbed global fetch
//    (api-client.test.ts's posture, replayed by login/forgot's own F2
//    describes): the assertion IS the request URL, which a
//    LoombreClient.prototype.post spy cannot see at all. ─────────────────
describe("ResetPasswordScreen — which server it posts to (d3-d4)", () => {
  let view: TestRender | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    routerPush.mockReset();
    routerReplace.mockReset();
    window.localStorage.clear();
    getAuthStore().clear();
    getAuthStore().setServerUrl("");
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
    window.localStorage.clear();
    getAuthStore().clear();
    getAuthStore().setServerUrl("");
  });

  function setNativeValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function submitReset(token: string): Promise<void> {
    view = renderIntoBody(<ResetPasswordScreen token={token} />);
    // LD-15 (rc.6): the page-load probe fires first and the form only
    // exists once it settles — and its URL is under test here too.
    await act(async () => {});
    const field = (labelText: string): HTMLInputElement =>
      Array.from(view!.container.querySelectorAll("label"))
        .find((l) => (l.textContent ?? "").startsWith(labelText))!
        .querySelector("input")!;
    setNativeValue(field("New password"), "correct horse battery");
    setNativeValue(field("Confirm new password"), "correct horse battery");
    const button = Array.from(view.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Reset password",
    )!;
    await act(async () => {
      button.click();
    });
  }

  function requestedUrls(): string[] {
    return fetchMock.mock.calls.map((call) => String(call[0]));
  }

  it("posts at the server the viewer chose on the sign-in screen, not the same-origin guess", async () => {
    window.localStorage.setItem("loombre.onboarding.serverUrl", "http://corrected:3001");
    await submitReset("tok-pref");
    // LD-15 (rc.6): BOTH the page-load probe and the submit resolve
    // through the same order — a probe aimed at the guess would report a
    // perfectly live link as dead.
    expect(requestedUrls()).toEqual([
      "http://corrected:3001/auth/reset-password/tok-pref",
      "http://corrected:3001/auth/reset-password",
    ]);
  });

  it("the corrected pill outranks a stale session's server URL", async () => {
    getAuthStore().setServerUrl("http://stale:3001");
    window.localStorage.setItem("loombre.onboarding.serverUrl", "http://corrected:3001");
    await submitReset("tok-stale");
    expect(requestedUrls()).toEqual([
      "http://corrected:3001/auth/reset-password/tok-stale",
      "http://corrected:3001/auth/reset-password",
    ]);
  });

  it("with nothing remembered it still falls back to the established session, then the guess", async () => {
    getAuthStore().setServerUrl("http://established:3001");
    await submitReset("tok-established");
    expect(requestedUrls()).toEqual([
      "http://established:3001/auth/reset-password/tok-established",
      "http://established:3001/auth/reset-password",
    ]);
  });
});
