// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/login/page.test.tsx
//
// Lane D coverage: the "Forgot password?" link's capability gating (M8)
// and the must-change-password routing (M14). Existing login logic
// (server-url switching, the ordinary sign-in path) is exercised
// incidentally by the tests below but isn't re-derived from scratch here —
// this file's job is the two NEW behaviors.
//
// LoombreClient.prototype.get/post are spied (ClaimScreen.test.tsx's
// pattern — see its header for why, over vi.mock'ing @loombre/sdk).
// apiPatch (the must-change step's authenticated PATCH) is mocked
// separately since login/page.tsx imports it from api-client.js, not a raw
// LoombreClient. The real AuthStore singleton is used (this page reads/
// writes it directly, same as production) — cleared before every test so
// no state leaks between them.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../components/ui/test-render.js";
import { getAuthStore } from "../../lib/auth-store.js";

const routerPush = vi.fn();
const routerReplace = vi.fn();
// A STABLE object reference, not a fresh literal per call: page.tsx's own
// mount effect depends on `[router]`, and next/navigation's real
// useRouter() returns the same router instance across renders — a mock
// returning a new object every call would make that effect re-fire after
// every re-render (caught by this file's own must-change test: it kept
// re-triggering the mount effect's isAuthenticated() check and calling
// router.replace("/home") the moment applyTokenPair flipped it true).
const router = { push: routerPush, replace: routerReplace };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const apiPatchMock = vi.fn();
vi.mock("../../lib/api-client.js", () => ({
  apiPatch: (...args: unknown[]) => apiPatchMock(...args),
}));

const { default: LoginPage } = await import("./page.js");

function stubMatchMedia(): void {
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
}

const CAPABILITIES_RESET_AVAILABLE = { flags: [], details: {}, passwordResetAvailable: true };
const CAPABILITIES_RESET_UNAVAILABLE = { flags: [], details: {}, passwordResetAvailable: false };

function tokenPair(mustChangePassword?: boolean): Record<string, unknown> {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessTokenExpiresAtMs: 9_999_999_999_999,
    deviceId: "device-1",
    ...(mustChangePassword !== undefined ? { mustChangePassword } : {}),
  };
}

describe("LoginPage — M8 forgot-link gating + M14 must-change routing", () => {
  let view: TestRender | null = null;
  let getSpy: ReturnType<typeof vi.spyOn>;
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    routerPush.mockReset();
    routerReplace.mockReset();
    apiPatchMock.mockReset();
    stubMatchMedia();
    window.localStorage.clear();
    getAuthStore().clear();
    getAuthStore().setServerUrl("https://loombre.example.com");
    getSpy = vi.spyOn(LoombreClient.prototype, "get").mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy = vi.spyOn(LoombreClient.prototype, "post");
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    getSpy.mockRestore();
    postSpy.mockRestore();
    vi.unstubAllGlobals();
    getAuthStore().clear();
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

  async function signIn(): Promise<void> {
    setNativeValue(inputFor("Username or email"), "june");
    setNativeValue(inputFor("Password"), "correct horse battery");
    await click(buttonFor("Sign in"));
  }

  it("no Forgot-password link while capabilities haven't resolved / say unavailable", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});

    expect(Array.from(view.container.querySelectorAll("a")).some((a) => a.textContent === "Forgot password?")).toBe(
      false,
    );
  });

  it("shows 'Forgot password?' -> /forgot only when GET /system/capabilities says passwordResetAvailable", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_AVAILABLE);
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});

    const link = Array.from(view.container.querySelectorAll("a")).find((a) => a.textContent === "Forgot password?");
    expect(link).toBeDefined();
    expect(link?.getAttribute("href")).toBe("/forgot");
  });

  it("a capabilities fetch failure fails closed — no link, no crash", async () => {
    getSpy.mockRejectedValue(new Error("network down"));
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});

    expect(Array.from(view.container.querySelectorAll("a")).some((a) => a.textContent === "Forgot password?")).toBe(
      false,
    );
    expect(view.container.textContent).toMatch(/sign in to this server/i);
  });

  it("ordinary login (mustChangePassword false/absent) applies the token pair and goes straight to /home", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(false));
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});

    await signIn();

    expect(routerReplace).toHaveBeenCalledWith("/home");
    expect(getAuthStore().isAuthenticated()).toBe(true);
    expect(view.container.textContent).not.toMatch(/set a new password/i);
  });

  it("M14: mustChangePassword:true applies the token pair but routes to the must-change screen INSTEAD of /home", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(true));
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});

    await signIn();

    expect(routerReplace).not.toHaveBeenCalledWith("/home");
    // The session IS valid — applyTokenPair already ran.
    expect(getAuthStore().isAuthenticated()).toBe(true);
    expect(view.container.textContent).toMatch(/set a new password/i);
    expect(view.container.textContent).toMatch(/an admin reset your password/i);
  });

  it("must-change: submitting a new password PATCHes /users/me then proceeds to /home", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(true));
    apiPatchMock.mockResolvedValue({});
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});
    await signIn();

    setNativeValue(inputFor("New password"), "a brand new password");
    setNativeValue(inputFor("Confirm new password"), "a brand new password");
    await click(buttonFor("Continue"));

    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/users/me");
    expect(options.body).toEqual({ password: "a brand new password" });
    expect(routerReplace).toHaveBeenCalledWith("/home");
  });

  it("must-change: a mismatch is rejected client-side, no PATCH sent", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(true));
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});
    await signIn();

    setNativeValue(inputFor("New password"), "aaaaaaaa");
    setNativeValue(inputFor("Confirm new password"), "bbbbbbbb");
    await click(buttonFor("Continue"));

    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/don't match/i);
  });

  it("a failed login shows the usual 401 message and never touches must-change", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockRejectedValue(new LoombreApiError(401, {}));
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});

    await signIn();

    expect(view.container.textContent).toMatch(/invalid username or password/i);
    expect(view.container.textContent).not.toMatch(/set a new password/i);
    expect(getAuthStore().isAuthenticated()).toBe(false);
  });
});
