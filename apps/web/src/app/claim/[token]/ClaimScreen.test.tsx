// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/claim/[token]/ClaimScreen.test.tsx
//
// E2/M12/M16: valid/invalid/422 coverage for the public claim screen.
// LoombreClient.prototype.get/post are spied directly (no vi.mock of
// @loombre/sdk — there's no existing precedent for that, and the class
// methods are ordinary prototype methods, so spyOn is the narrower,
// house-consistent choice) rather than mocking api-client.js, which this
// screen deliberately does NOT go through (M16: "direct LoombreClient
// calls, no bearer").
//
// next/navigation's useRouter is mocked (no real Next router exists under
// this jsdom harness). window.matchMedia is stubbed because
// buildDeviceProfile()'s HDR probe calls it — jsdom has no real
// implementation (SheetOrModal.test.tsx's own header note).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoombreClient, LoombreApiError } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";

const routerPush = vi.fn();
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

const { ClaimScreen } = await import("./ClaimScreen.js");

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

const CLAIM_STATE_NO_PRESETS = { usernamePreset: null, displayNamePreset: null, emailPreset: null };
const CLAIM_STATE_WITH_USERNAME_PRESET = { usernamePreset: "junepreset", displayNamePreset: "June", emailPreset: "june@example.com" };

const TOKEN_PAIR = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  accessTokenExpiresAtMs: 9_999_999_999_999,
  deviceId: "device-1",
};

describe("ClaimScreen — E2/M12/M16", () => {
  let view: TestRender | null = null;
  let getSpy: ReturnType<typeof vi.spyOn>;
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    routerPush.mockReset();
    routerReplace.mockReset();
    stubMatchMedia();
    getSpy = vi.spyOn(LoombreClient.prototype, "get");
    postSpy = vi.spyOn(LoombreClient.prototype, "post");
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    getSpy.mockRestore();
    postSpy.mockRestore();
    vi.unstubAllGlobals();
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

  it("VALID: a live invite renders the account form, prefilled from the presets", async () => {
    getSpy.mockResolvedValue(CLAIM_STATE_WITH_USERNAME_PRESET);
    view = renderIntoBody(<ClaimScreen token="tok-1" />);
    await act(async () => {});

    expect(view.container.textContent).toMatch(/create your account/i);
    expect(inputFor("Username").value).toBe("junepreset");
    expect(inputFor("Username").disabled).toBe(true); // locked to preset
    expect(inputFor("Display name").value).toBe("June");
    expect(inputFor("Email").value).toBe("june@example.com");
  });

  it("VALID, no presets: username is editable and required, empty otherwise", async () => {
    getSpy.mockResolvedValue(CLAIM_STATE_NO_PRESETS);
    view = renderIntoBody(<ClaimScreen token="tok-2" />);
    await act(async () => {});

    expect(inputFor("Username").disabled).toBe(false);
    expect(inputFor("Username").value).toBe("");
  });

  it("INVALID: a 404 shows the ONE generic 'isn't valid' screen — never guesses why", async () => {
    getSpy.mockRejectedValue(new LoombreApiError(404, {}));
    view = renderIntoBody(<ClaimScreen token="bad-token" />);
    await act(async () => {});

    expect(view.container.textContent).toMatch(/this invite link isn't valid/i);
    expect(view.container.textContent).toMatch(/expired-or-used-or-mistyped|expired, already used, or mistyped/i);
    // The generic message never speculates which one applies.
    expect(view.container.textContent).not.toMatch(/expired\.$/i);
  });

  it("a network/load error is distinct from the invalid-link screen", async () => {
    getSpy.mockRejectedValue(new Error("network down"));
    view = renderIntoBody(<ClaimScreen token="tok-3" />);
    await act(async () => {});

    expect(view.container.textContent).toMatch(/couldn't load this invite/i);
    expect(view.container.textContent).not.toMatch(/isn't valid/i);
  });

  it("submit success: claims, applies the TokenPair, and navigates to /home", async () => {
    getSpy.mockResolvedValue(CLAIM_STATE_NO_PRESETS);
    postSpy.mockResolvedValue(TOKEN_PAIR);
    view = renderIntoBody(<ClaimScreen token="tok-4" />);
    await act(async () => {});

    setNativeValue(inputFor("Username"), "newperson");
    setNativeValue(inputFor("Password"), "correct horse battery");
    setNativeValue(inputFor("Confirm password"), "correct horse battery");
    await click(buttonFor("Create account"));

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [path, options] = postSpy.mock.calls[0] as [string, { params: { path: { token: string } }; body: Record<string, unknown> }];
    expect(path).toBe("/invites/claim/{token}");
    expect(options.params.path.token).toBe("tok-4");
    expect(options.body["username"]).toBe("newperson");
    expect(routerReplace).toHaveBeenCalledWith("/home");
  });

  it("submit: a username preset means the body omits `username` entirely — the preset wins server-side", async () => {
    getSpy.mockResolvedValue(CLAIM_STATE_WITH_USERNAME_PRESET);
    postSpy.mockResolvedValue(TOKEN_PAIR);
    view = renderIntoBody(<ClaimScreen token="tok-5" />);
    await act(async () => {});

    setNativeValue(inputFor("Password"), "correct horse battery");
    setNativeValue(inputFor("Confirm password"), "correct horse battery");
    await click(buttonFor("Create account"));

    const [, options] = postSpy.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body).not.toHaveProperty("username");
  });

  it("password mismatch is rejected client-side, no request made", async () => {
    getSpy.mockResolvedValue(CLAIM_STATE_NO_PRESETS);
    view = renderIntoBody(<ClaimScreen token="tok-6" />);
    await act(async () => {});

    setNativeValue(inputFor("Username"), "newperson");
    setNativeValue(inputFor("Password"), "aaaaaaaa");
    setNativeValue(inputFor("Confirm password"), "bbbbbbbb");
    await click(buttonFor("Create account"));

    expect(postSpy).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/don't match/i);
  });

  it("422 (e.g. username taken): inline error, the form stays — it is NOT the invalid-link screen", async () => {
    getSpy.mockResolvedValue(CLAIM_STATE_NO_PRESETS);
    postSpy.mockRejectedValue(new LoombreApiError(422, { title: "Username is already taken." }));
    view = renderIntoBody(<ClaimScreen token="tok-7" />);
    await act(async () => {});

    setNativeValue(inputFor("Username"), "taken");
    setNativeValue(inputFor("Password"), "correct horse battery");
    setNativeValue(inputFor("Confirm password"), "correct horse battery");
    await click(buttonFor("Create account"));

    expect(view.container.textContent).toContain("Username is already taken.");
    expect(view.container.textContent).toMatch(/create your account/i);
    expect(view.container.textContent).not.toMatch(/isn't valid/i);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("a 404 on submit (token consumed mid-flow) routes to the same generic invalid-link screen", async () => {
    getSpy.mockResolvedValue(CLAIM_STATE_NO_PRESETS);
    postSpy.mockRejectedValue(new LoombreApiError(404, {}));
    view = renderIntoBody(<ClaimScreen token="tok-8" />);
    await act(async () => {});

    setNativeValue(inputFor("Username"), "newperson");
    setNativeValue(inputFor("Password"), "correct horse battery");
    setNativeValue(inputFor("Confirm password"), "correct horse battery");
    await click(buttonFor("Create account"));

    expect(view.container.textContent).toMatch(/this invite link isn't valid/i);
  });
});
