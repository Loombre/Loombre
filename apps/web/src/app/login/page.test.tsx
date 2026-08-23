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

  // ── G10 (STATE.md "Current-password re-auth on self-changes"): the
  //    must-change PATCH now dependentRequires currentPassword, supplied by
  //    a "Temporary password" field on this screen. ────────────────────────
  it("renders a Temporary password field with autoComplete=current-password", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(true));
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});
    await signIn();

    const field = inputFor("Temporary password");
    expect(field.getAttribute("autocomplete")).toBe("current-password");
    expect(field.getAttribute("type")).toBe("password");
    expect(view.container.textContent).toMatch(/temporary password you just signed in with/i);
  });

  it("must-change: submitting sends currentPassword (the temporary password) + the new password, then proceeds to /home", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(true));
    apiPatchMock.mockResolvedValue({});
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});
    await signIn();

    setNativeValue(inputFor("Temporary password"), "correct horse battery");
    setNativeValue(inputFor("New password"), "a brand new password");
    setNativeValue(inputFor("Confirm new password"), "a brand new password");
    await click(buttonFor("Continue"));

    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/users/me");
    expect(options.body).toEqual({ password: "a brand new password", currentPassword: "correct horse battery" });
    expect(routerReplace).toHaveBeenCalledWith("/home");
  });

  it("must-change: a mismatch is rejected client-side, no PATCH sent", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(true));
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});
    await signIn();

    setNativeValue(inputFor("Temporary password"), "correct horse battery");
    setNativeValue(inputFor("New password"), "aaaaaaaa");
    setNativeValue(inputFor("Confirm new password"), "bbbbbbbb");
    await click(buttonFor("Continue"));

    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/don't match/i);
  });

  it("must-change: wrong currentPassword 403s onto the Temporary password field, preserving the typed new password", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(true));
    apiPatchMock.mockRejectedValueOnce(
      new LoombreApiError(403, {
        type: "urn:loombre:problem:current-password-invalid",
        title: "Current password is incorrect",
        status: 403,
        detail: "Current password is incorrect.",
        code: "current-password-invalid",
      }),
    );
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});
    await signIn();

    setNativeValue(inputFor("Temporary password"), "wrong");
    setNativeValue(inputFor("New password"), "a brand new password");
    setNativeValue(inputFor("Confirm new password"), "a brand new password");
    await click(buttonFor("Continue"));

    const field = inputFor("Temporary password");
    expect(field.closest("label")!.textContent).toMatch(/current password is incorrect/i);
    expect(field.value).toBe("wrong");
    expect(inputFor("New password").value).toBe("a brand new password");
    expect(routerReplace).not.toHaveBeenCalledWith("/home");
  });

  it("must-change: a 429 shows an honest rate-limited message, not a per-field error", async () => {
    getSpy.mockResolvedValue(CAPABILITIES_RESET_UNAVAILABLE);
    postSpy.mockResolvedValue(tokenPair(true));
    apiPatchMock.mockRejectedValueOnce(new LoombreApiError(429, { title: "Too Many Requests", status: 429 }));
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});
    await signIn();

    setNativeValue(inputFor("Temporary password"), "correct horse battery");
    setNativeValue(inputFor("New password"), "a brand new password");
    setNativeValue(inputFor("Confirm new password"), "a brand new password");
    await click(buttonFor("Continue"));

    expect(view.container.textContent).toMatch(/too many attempts/i);
    expect(inputFor("Temporary password").closest("label")!.textContent).not.toMatch(/incorrect/i);
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

// ── browser-shell-browse-F1 (2026-08-20/21 QA, P2): the other end of the
//    auth-loss redirect. AppShell now sends a viewer whose session died on
//    /browse?library=… to `/login?next=%2Fbrowse%3Flibrary%3Dabc`; this
//    page has to honour that (and refuse to be an open redirect while it
//    does — the parameter is attacker-supplied by construction, anyone can
//    mail a /login?next=… link). lib/auth-return-path.test.ts owns the full
//    sanitizer table; these tests are the wiring. ─────────────────────────
describe("LoginPage — return path (browser-shell-browse-F1)", () => {
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
    window.history.replaceState({}, "", "/login");
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    getSpy.mockRestore();
    postSpy.mockRestore();
    vi.unstubAllGlobals();
    getAuthStore().clear();
    window.history.replaceState({}, "", "/");
  });

  async function signInOn(url: string): Promise<void> {
    window.history.replaceState({}, "", url);
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});
    const label = Array.from(view.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").startsWith("Username or email"),
    )!;
    const password = Array.from(view.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").startsWith("Password"),
    )!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const [field, value] of [
      [label.querySelector("input")!, "june"],
      [password.querySelector("input")!, "correct horse battery"],
    ] as Array<[HTMLInputElement, string]>) {
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const button = Array.from(view.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Sign in",
    )!;
    await act(async () => {
      button.click();
    });
  }

  it("returns the viewer to where their session died instead of /home", async () => {
    postSpy.mockResolvedValue(tokenPair(false));
    await signInOn("/login?next=%2Fbrowse%3Flibrary%3Dabc");

    expect(routerReplace).toHaveBeenCalledWith("/browse?library=abc");
    expect(routerReplace).not.toHaveBeenCalledWith("/home");
  });

  it("still goes to /home when there is no return path", async () => {
    postSpy.mockResolvedValue(tokenPair(false));
    await signInOn("/login");

    expect(routerReplace).toHaveBeenCalledWith("/home");
  });

  it("refuses an off-origin return path (open-redirect guard)", async () => {
    postSpy.mockResolvedValue(tokenPair(false));
    await signInOn("/login?next=https%3A%2F%2Fevil.example.com%2F");

    expect(routerReplace).toHaveBeenCalledWith("/home");
    for (const call of routerReplace.mock.calls) expect(String(call[0])).not.toContain("evil.example.com");
  });

  it("honours the return path after the must-change-password step too", async () => {
    postSpy.mockResolvedValue(tokenPair(true));
    apiPatchMock.mockResolvedValue({});
    await signInOn("/login?next=%2Fwatchlist");

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const [labelText, value] of [
      ["Temporary password", "correct horse battery"],
      ["New password", "a brand new password"],
      ["Confirm new password", "a brand new password"],
    ]) {
      const field = Array.from(view!.container.querySelectorAll("label"))
        .find((l) => (l.textContent ?? "").startsWith(labelText!))!
        .querySelector("input")!;
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const button = Array.from(view!.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Continue",
    )!;
    await act(async () => {
      button.click();
    });

    expect(routerReplace).toHaveBeenCalledWith("/watchlist");
  });

  it("an already-signed-in viewer landing on /login?next=… is sent to the return path", async () => {
    getAuthStore().applyTokenPair({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAtMs: 9_999_999_999_999,
      deviceId: "device-1",
    });
    window.history.replaceState({}, "", "/login?next=%2Fwatchlist");
    view = renderIntoBody(<LoginPage />);
    await act(async () => {});

    expect(routerReplace).toHaveBeenCalledWith("/watchlist");
  });
});
