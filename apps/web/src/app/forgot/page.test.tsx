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
import { getAuthStore } from "../../lib/auth-store.js";

const routerPush = vi.fn();
const routerReplace = vi.fn();

// A STABLE router object, not a fresh literal per call (login/page.test.tsx
// says why at length): LoginPage's mount effect depends on `[router]`, and a
// new object per render re-fires it after every keystroke — which re-reads
// the remembered server URL and silently reverts the field under the test.
const router = { push: routerPush, replace: routerReplace };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const { default: ForgotPasswordPage } = await import("./page.js");
// browser-shell-browse-F2 drives the real sign-in screen too (the defect
// spans both pages); LoginPage pulls in api-client.js, which is NOT mocked
// here — importing it has no side effects, and nothing in these tests takes
// an authenticated path through it.
const { default: LoginPage } = await import("../login/page.js");

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

  // d4-e6: the copy branch was `if (err instanceof LoombreApiError) {
  // setError(err.message) } else { setError("Could not reach the server at
  // …") }`. A server answer that is structurally a problem document but not
  // that exact class fell into the ELSE branch — so the page blamed the
  // viewer's network for a request the server had answered, and named a
  // server URL that was working fine. `apiErrorMessage` reads the RFC 9457
  // detail off the shape, and the honest network copy stays for the
  // failures that really are network failures (the test above).
  it("a rate-limit answer is reported as the server's own sentence, not as an unreachable server", async () => {
    const detail = "Too many reset requests from this address — try again in 10 minutes.";
    // Shaped exactly like a LoombreApiError (status + problem), but NOT an
    // instance of the class this page imported — a re-thrown copy, or a
    // second copy of the SDK in the graph.
    postSpy.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), {
        status: 429,
        problem: { type: "about:blank", title: "Too Many Requests", status: 429, detail },
      }),
    );
    view = renderIntoBody(<ForgotPasswordPage />);
    await submit("someone@example.com");

    expect(view.container.textContent).toContain(detail);
    expect(view.container.textContent).not.toMatch(/could not reach the server/i);
  });

  it("the confirmation screen links back to /login", async () => {
    postSpy.mockResolvedValue({});
    view = renderIntoBody(<ForgotPasswordPage />);
    await submit("someone@example.com");

    const link = Array.from(view.container.querySelectorAll("a")).find((a) => a.textContent === "Back to sign in");
    expect(link?.getAttribute("href")).toBe("/login");
  });
});

// ── browser-shell-browse-F2 (2026-08-20/21 QA, P2): WHICH server this page
//    posts to. The reported sequence was: a failed sign-in against
//    http://localhost:9 poisoned the auth store's serverUrl, the login pill
//    was corrected back to :3001, and /forgot still POSTed to :9 — across a
//    full reload — because it resolved the auth store rather than the value
//    the sign-in screen shows. Unlike the describe above these tests drive
//    the REAL LoombreClient against a stubbed global fetch, so what they
//    assert is the actual request URL, not a spy on the wrapper. ─────────
describe("ForgotPasswordPage — which server it reaches (browser-shell-browse-F2)", () => {
  let view: TestRender | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  const PREFERENCE_KEY = "loombre.onboarding.serverUrl";

  beforeEach(() => {
    routerPush.mockReset();
    routerReplace.mockReset();
    window.localStorage.clear();
    getAuthStore().clear();
    getAuthStore().setServerUrl("");
    // Anything on :9 is unreachable (the QA repro's ERR_UNSAFE_PORT);
    // anything else answers the server's real 202.
    fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("localhost:9/")) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 202 });
    });
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

  async function submitForgot(identifier: string): Promise<void> {
    const input = Array.from(view!.container.querySelectorAll("label"))
      .find((l) => (l.textContent ?? "").startsWith("Username or email"))!
      .querySelector("input")!;
    setNativeValue(input, identifier);
    const button = Array.from(view!.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Send reset link",
    )!;
    await act(async () => {
      button.click();
    });
  }

  function requestedUrls(): string[] {
    return fetchMock.mock.calls.map((call) => String(call[0]));
  }

  it("posts to the server the sign-in screen shows, not a stale auth-store value", async () => {
    window.localStorage.setItem(PREFERENCE_KEY, "http://localhost:3001");
    getAuthStore().setServerUrl("http://localhost:9");

    view = renderIntoBody(<ForgotPasswordPage />);
    await submitForgot("june");

    expect(requestedUrls()).toEqual(["http://localhost:3001/auth/forgot-password"]);
    expect(view.container.textContent).toMatch(/if that account has an email on file/i);
  });

  it("falls back to the established session's server when the sign-in screen remembers nothing", async () => {
    getAuthStore().setServerUrl("http://localhost:3001");

    view = renderIntoBody(<ForgotPasswordPage />);
    await submitForgot("june");

    expect(requestedUrls()).toEqual(["http://localhost:3001/auth/forgot-password"]);
  });

  it("names the server it could not reach instead of blaming the viewer's connection", async () => {
    window.localStorage.setItem(PREFERENCE_KEY, "http://localhost:9");

    view = renderIntoBody(<ForgotPasswordPage />);
    await submitForgot("june");

    expect(view.container.textContent).toMatch(/localhost:9/);
    expect(view.container.textContent).not.toMatch(/if that account has an email on file/i);
  });

  it("the full reported sequence: a failed sign-in against a wrong URL, the pill corrected, then /forgot", async () => {
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
    getAuthStore().setServerUrl("http://localhost:3001");

    const login = renderIntoBody(<LoginPage />);
    await act(async () => {});
    const clickIn = async (root: HTMLElement, text: string): Promise<void> => {
      const button = Array.from(root.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === text)!;
      await act(async () => {
        button.click();
      });
    };
    // Switch server URL to the unreachable one, submit, watch it fail.
    await clickIn(login.container, "Switch ▾");
    await act(async () => {
      setNativeValue(login.container.querySelector<HTMLInputElement>("#serverUrl")!, "http://localhost:9");
    });
    for (const [labelText, value] of [
      ["Username or email", "june"],
      ["Password", "correct horse battery"],
    ]) {
      const field = Array.from(login.container.querySelectorAll("label"))
        .find((l) => (l.textContent ?? "").startsWith(labelText!))!
        .querySelector("input")!;
      setNativeValue(field, value!);
    }
    await clickIn(login.container, "Sign in");
    expect(login.container.textContent).toMatch(/could not reach the server/i);

    // Correct the pill back and confirm it with Done.
    await act(async () => {
      setNativeValue(login.container.querySelector<HTMLInputElement>("#serverUrl")!, "http://localhost:3001");
    });
    await clickIn(login.container, "Done");
    expect(login.container.textContent).toMatch(/localhost:3001 · NO TLS/);
    login.unmount();

    fetchMock.mockClear();
    view = renderIntoBody(<ForgotPasswordPage />);
    await submitForgot("june");

    expect(requestedUrls()).toEqual(["http://localhost:3001/auth/forgot-password"]);
  });
});
