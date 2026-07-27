// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/AccountSection.test.tsx
//
// Covers the three self-service account behaviours this section is
// responsible for keeping honest:
//   1. PATCH /users/me must be able to CLEAR a birth date (the contract's
//      `birthDate: [string, 'null']` null-to-clear semantics) — omitting
//      the key leaves the stored value untouched server-side
//      (apps/server/src/catalog/users.controller.ts's updateMe).
//   2. No control may exist here for a preference GET/PUT
//      /users/me/settings does not persist (owner ledger item 6 /
//      STATE.md "GET/PUT /users/me/settings is a COMPLETE STUB").
//   3. The change-password form submits ONLY the password (never the
//      profile fields) and clears its inputs on success.
//   4. The restricted-content PIN card can only ever submit a PIN the
//      UNLOCK surface can also enter. PinModal (the one and only unlock UI)
//      hard-requires exactly PIN_LENGTH digits, so a longer/shorter PIN set
//      here would lock the user out of restricted content with no way back
//      in — this file pins that both sides share lib/pin-entry.ts's rule.
//      The `Current PIN` field is the deliberate EXCEPTION: it proves an
//      ALREADY-STORED PIN, which on an install predating the 4-digit rule
//      may be any length, so it is digits-only but NOT length-clamped —
//      that field is such a user's only recovery path.
//
// apiGet/apiPatch/apiPut are mocked and the module under test imported
// afterwards — the established convention here (AlbumDetailScreen.test.tsx,
// use-watched-state.test.tsx). useRestricted is mocked too: its provider
// would otherwise need the whole auth stack. The mock reads a MUTABLE
// module-level `restrictedState` so individual tests can put the card in
// the opted-in / has-a-PIN shapes the PIN fields only render in.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { PIN_LENGTH } from "../../../lib/pin-entry.js";

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPutMock = vi.fn();

class FakeApiError extends Error {}

const RESTRICTED_DEFAULT = {
  loading: false,
  optIn: false,
  hasPin: false,
  unlockedUntilMs: null,
  locked: false,
  modalOpen: false,
  submitting: false,
  error: null,
};
let restrictedState: typeof RESTRICTED_DEFAULT = { ...RESTRICTED_DEFAULT };

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPatch: (...args: unknown[]) => apiPatchMock(...args),
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../restricted/RestrictedProvider.js", () => ({
  useRestricted: () => ({
    state: restrictedState,
    applyRestrictedSettings: () => {},
  }),
}));

const { AccountSection } = await import("./AccountSection.js");

const ME = {
  id: "11111111-1111-7111-8111-111111111111",
  username: "ada",
  email: "ada@example.com",
  displayName: null,
  isAdmin: false,
  birthDate: "1990-01-01",
  maxContentRating: null,
  createdAtMs: 0,
  updatedAtMs: 0,
};

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AccountSection", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPutMock.mockReset();
    restrictedState = { ...RESTRICTED_DEFAULT };
    apiPutMock.mockImplementation(() => Promise.resolve({ optIn: true, hasPin: true, unlockedUntilMs: null }));
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me") return Promise.resolve({ ...ME });
      return Promise.resolve({
        restrictedOptIn: false,
        locale: "en-US",
        theme: "system",
        subtitlePreferredLanguage: null,
        audioPreferredLanguage: null,
        autoplayNextEpisode: true,
        updatedAtMs: 0,
      });
    });
    apiPatchMock.mockImplementation(() => Promise.resolve({ ...ME }));
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<AccountSection heading={null} />);
    await act(async () => {});
  }

  function inputFor(labelText: string): HTMLInputElement {
    const label = Array.from(view!.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").startsWith(labelText),
    );
    if (!label) throw new Error(`no field labelled "${labelText}"`);
    return label.querySelector("input")!;
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

  it("clearing the birth date PATCHes birthDate: null (the contract's null-to-clear)", async () => {
    await render();
    setNativeValue(inputFor("Birth date"), "");
    await click(buttonFor("Save profile"));

    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/users/me");
    expect(options.body["birthDate"]).toBe(null);
  });

  it("a set birth date still round-trips as the ISO string", async () => {
    await render();
    setNativeValue(inputFor("Birth date"), "1991-02-03");
    await click(buttonFor("Save profile"));

    const [, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body["birthDate"]).toBe("1991-02-03");
  });

  it("exposes no control for preferences PUT /users/me/settings does not persist", async () => {
    await render();
    const text = view!.container.textContent ?? "";
    expect(text).not.toMatch(/Preferred audio language/);
    expect(text).not.toMatch(/Preferred subtitle language/);
    expect(apiPutMock.mock.calls.some(([path]) => path === "/users/me/settings")).toBe(false);
  });

  it("changing the password submits only the password and clears the inputs", async () => {
    await render();
    setNativeValue(inputFor("New password"), "correct horse battery");
    setNativeValue(inputFor("Confirm new password"), "correct horse battery");
    await click(buttonFor("Change password"));

    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/users/me");
    expect(options.body).toEqual({ password: "correct horse battery" });
    expect(inputFor("New password").value).toBe("");
    expect(inputFor("Confirm new password").value).toBe("");
  });

  it("a confirmation mismatch is rejected client-side without any request", async () => {
    await render();
    setNativeValue(inputFor("New password"), "correct horse battery");
    setNativeValue(inputFor("Confirm new password"), "correct horse batteru");
    await click(buttonFor("Change password"));

    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(view!.container.textContent ?? "").toMatch(/don't match/i);
  });

  it("surfaces a server rejection instead of reporting success", async () => {
    await render();
    apiPatchMock.mockImplementationOnce(() => Promise.reject(new FakeApiError("Password is too short.")));
    setNativeValue(inputFor("New password"), "x");
    setNativeValue(inputFor("Confirm new password"), "x");
    await click(buttonFor("Change password"));

    const text = view!.container.textContent ?? "";
    expect(text).toMatch(/Password is too short\./);
    expect(text).not.toMatch(/Saved/);
  });

  // ── Restricted-content PIN card ───────────────────────────────────────
  //
  // The lockout bug this covers: this card used to accept a PIN of ANY
  // length while PinModal — the only unlock UI — can submit exactly
  // PIN_LENGTH digits. Setting a 5-digit PIN here therefore made restricted
  // content permanently unreachable.
  describe("restricted-content PIN", () => {
    it("clamps the New PIN field to PIN_LENGTH digits and strips non-digits", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: false };
      await render();

      setNativeValue(inputFor("New PIN"), "1a2b3c4d5");
      expect(inputFor("New PIN").value).toBe("1234");
      expect(inputFor("New PIN").value.length).toBe(PIN_LENGTH);
    });

    it("names the required length in the New PIN label", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: false };
      await render();

      const label = Array.from(view!.container.querySelectorAll("label")).find((l) =>
        (l.textContent ?? "").startsWith("New PIN"),
      )!;
      expect(label.textContent).toContain(`${PIN_LENGTH} digits`);
    });

    it("refuses to submit a short PIN — inline message, no PUT /users/me/restricted", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: false };
      await render();

      setNativeValue(inputFor("New PIN"), "12");
      await click(buttonFor("Save"));

      expect(apiPutMock).not.toHaveBeenCalled();
      expect(view!.container.textContent ?? "").toMatch(new RegExp(`${PIN_LENGTH}-digit PIN`));
    });

    it("refuses to submit an empty PIN when no PIN exists yet", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: false };
      await render();

      await click(buttonFor("Save"));

      expect(apiPutMock).not.toHaveBeenCalled();
      expect(view!.container.textContent ?? "").toMatch(new RegExp(`${PIN_LENGTH}-digit PIN`));
    });

    it("submits a PIN of exactly PIN_LENGTH digits — the only value PinModal can send back", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: false };
      await render();

      setNativeValue(inputFor("New PIN"), "1234");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [path, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(path).toBe("/users/me/restricted");
      expect(options.body["pin"]).toBe("1234");
    });

    it("a blank New PIN with an existing PIN still saves — 'leave blank to keep current' is not a short PIN", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: true };
      await render();

      setNativeValue(inputFor("Current PIN"), "1234");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).not.toHaveProperty("pin");
      expect(options.body["currentPin"]).toBe("1234");
    });

    // Opting out is server-side gated on `currentPin`, so the field that
    // supplies it has to survive flipping the toggle to Off — it used to be
    // nested inside the `optIn &&` branch, which hid it exactly when it was
    // required and made opt-out unreachable from this UI.
    it("keeps Current PIN visible when toggling to Off — the field opting out requires", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: true };
      await render();

      await click(buttonFor("Off"));

      const labels = Array.from(view!.container.querySelectorAll("label")).map((l) => l.textContent ?? "");
      expect(labels.some((t) => t.startsWith("Current PIN"))).toBe(true);
      expect(labels.some((t) => t.startsWith("New PIN"))).toBe(false);

      setNativeValue(inputFor("Current PIN"), "1234");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({ optIn: false, currentPin: "1234" });
    });

    it("a half-typed New PIN abandoned by toggling Off never blocks or reaches the wire", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: true };
      await render();

      setNativeValue(inputFor("New PIN"), "12");
      await click(buttonFor("Off"));
      setNativeValue(inputFor("Current PIN"), "1234");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).not.toHaveProperty("pin");
    });

    // THE recovery path for anyone who set a longer PIN before the rule
    // existed: `currentPin` proves an ALREADY-STORED secret, so it is
    // digits-only but deliberately NOT clamped to PIN_LENGTH. Clamping it
    // would make those users unable to change their PIN or even opt out —
    // strictly worse than the bug being fixed.
    it("does NOT clamp Current PIN — a legacy longer PIN must stay provable", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: true };
      await render();

      setNativeValue(inputFor("Current PIN"), "5a4321");
      expect(inputFor("Current PIN").value).toBe("54321");

      setNativeValue(inputFor("New PIN"), "1234");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({ optIn: true, pin: "1234", currentPin: "54321" });
    });
  });
});
