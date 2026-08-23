// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/profile/ProfileSettings.test.tsx
//
// D-6 (Wave 2, this run — IA restructure): moved verbatim alongside
// ProfileSettings.tsx (formerly AccountSection.tsx/AccountSection.test.tsx —
// see that file's header) — only the import path, the destructured export
// name, and this comment changed; every assertion below still pins the same
// real behavior it always did.
//
// Covers the three self-service account behaviours this component is
// responsible for keeping honest:
//   1. PATCH /users/me must be able to CLEAR a birth date (the contract's
//      `birthDate: [string, 'null']` null-to-clear semantics) — omitting
//      the key leaves the stored value untouched server-side
//      (apps/server/src/catalog/users.controller.ts's updateMe).
//   2. The Playback card's two language pickers (H1, owner ledger item 6,
//      closed) round-trip through the REAL GET/PUT /users/me/settings, and
//      "Saved" renders ONLY after a genuine 2xx — a rejected PUT must show
//      the error state, never "Saved" (the lying-save bug this restores
//      from, commit 9552333).
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
import { renderIntoBody, type TestRender } from "../ui/test-render.js";
import { PIN_LENGTH } from "../../lib/pin-entry.js";

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

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPatch: (...args: unknown[]) => apiPatchMock(...args),
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  LoombreApiError: FakeApiError,
}));

vi.mock("../restricted/RestrictedProvider.js", () => ({
  useRestricted: () => ({
    state: restrictedState,
    applyRestrictedSettings: () => {},
  }),
}));

const { ProfileSettings } = await import("./ProfileSettings.js");

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

describe("ProfileSettings", () => {
  let view: TestRender | null = null;

  const SETTINGS_DEFAULT = {
    restrictedOptIn: false,
    locale: "en-US",
    theme: "system",
    subtitlePreferredLanguage: null,
    audioPreferredLanguage: null,
    autoplayNextEpisode: true,
    updatedAtMs: 0,
  };

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPutMock.mockReset();
    restrictedState = { ...RESTRICTED_DEFAULT };
    // apiPut is shared by BOTH the restricted-content card (PUT
    // /users/me/restricted) and the Playback card (PUT /users/me/settings)
    // below — path-aware so each gets its own realistic response shape.
    // The settings branch echoes the body back with a fresh updatedAtMs,
    // mirroring putMySettings' real "returns what it just persisted"
    // contract (apps/server/src/catalog/users.controller.ts).
    apiPutMock.mockImplementation((path: string, options?: { body?: Record<string, unknown> }) => {
      if (path === "/users/me/restricted") {
        return Promise.resolve({ optIn: true, hasPin: true, unlockedUntilMs: null });
      }
      if (path === "/users/me/settings") {
        return Promise.resolve({ ...SETTINGS_DEFAULT, ...options?.body, updatedAtMs: 999 });
      }
      return Promise.resolve({});
    });
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me") return Promise.resolve({ ...ME });
      return Promise.resolve({ ...SETTINGS_DEFAULT });
    });
    apiPatchMock.mockImplementation(() => Promise.resolve({ ...ME }));
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<ProfileSettings heading={null} />);
    await act(async () => {});
  }

  // `root` scopes the lookup to a single card — needed once "Current
  // password" (G10) appears in up to three cards at once (Profile only
  // when email is dirty; Password and Restricted content always), so a
  // container-wide search is ambiguous for anything but the first one in
  // DOM order.
  function inputFor(labelText: string, root: ParentNode = view!.container): HTMLInputElement {
    const label = Array.from(root.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").startsWith(labelText),
    );
    if (!label) throw new Error(`no field labelled "${labelText}"`);
    return label.querySelector("input")!;
  }

  // W6: Birth date is the one field NOT looked up via `inputFor` — its
  // DatePicker (components/ui/DatePicker.tsx) pairs an explicit
  // `<label htmlFor="account-birth-date">` with the control rather than the
  // implicit label-wraps-input pattern every other field here uses (see
  // ProfileSettings.tsx's own comment on that field: DatePicker's popover
  // renders two more <select>s of its own, so nesting the whole thing
  // inside one <label> would make that label ambiguously "own" three
  // controls). The underlying text input is still a real, typeable
  // <input> — `setNativeValue`/dispatch("input") works on it exactly like
  // every other text field in this file.
  function birthDateInput(): HTMLInputElement {
    const el = view!.container.querySelector<HTMLInputElement>("#account-birth-date");
    if (!el) throw new Error("no birth date field");
    return el;
  }

  /** The `<form>` for the card whose `<h2>` reads exactly `title` — see
   *  `inputFor`'s header for why cards need scoping now. */
  function sectionForm(title: string): HTMLFormElement {
    const heading = Array.from(view!.container.querySelectorAll("h2")).find((h) => (h.textContent ?? "") === title);
    if (!heading) throw new Error(`no section titled "${title}"`);
    const form = heading.closest("form");
    if (!form) throw new Error(`section "${title}" is not inside a form`);
    return form as HTMLFormElement;
  }

  /** A well-formed 403 `current-password-invalid` (G3) — the shape
   *  apps/server/src/gateway/current-password-invalid.exception.ts sends,
   *  reduced to what these components actually read (`.status`, `.problem.
   *  code`, `.message`). */
  function currentPasswordInvalidError(): FakeApiError {
    const err = new FakeApiError("Current password is incorrect");
    Object.assign(err, {
      status: 403,
      problem: {
        type: "urn:loombre:problem:current-password-invalid",
        title: "Current password is incorrect",
        status: 403,
        detail: "Current password is incorrect.",
        code: "current-password-invalid",
      },
    });
    return err;
  }

  /** A well-formed 429 (the shared per-user currentPassword limiter, G4). */
  function rateLimitedError(): FakeApiError {
    const err = new FakeApiError("Too Many Requests");
    Object.assign(err, { status: 429, problem: { title: "Too Many Requests", status: 429 } });
    return err;
  }

  function selectFor(labelText: string): HTMLSelectElement {
    const label = Array.from(view!.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").startsWith(labelText),
    );
    if (!label) throw new Error(`no field labelled "${labelText}"`);
    return label.querySelector("select")!;
  }

  // React's <select> onChange listens for the native 'change' event (unlike
  // <input>, which it tracks via 'input') — mirrors setNativeValue above for
  // the picker fields.
  function setSelectValue(el: HTMLSelectElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
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
    setNativeValue(birthDateInput(), "");
    await click(buttonFor("Save profile"));

    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/users/me");
    expect(options.body["birthDate"]).toBe(null);
  });

  // ── G10: dirty-fields-only submission + the conditional currentPassword
  //    field (STATE.md "Current-password re-auth on self-changes") ───────
  describe("dirty-fields-only submission + currentPassword (G10)", () => {
    it("no Current password field renders until email is actually touched", async () => {
      await render();
      expect(
        Array.from(sectionForm("Profile").querySelectorAll("label")).some((l) =>
          (l.textContent ?? "").startsWith("Current password"),
        ),
      ).toBe(false);
    });

    it("editing email reveals Current password (autoComplete=current-password); editing it back to the loaded value hides it again", async () => {
      await render();
      setNativeValue(inputFor("Email", sectionForm("Profile")), "new@example.com");
      const field = inputFor("Current password", sectionForm("Profile"));
      expect(field.getAttribute("autocomplete")).toBe("current-password");
      expect(field.getAttribute("type")).toBe("password");

      setNativeValue(inputFor("Email", sectionForm("Profile")), ME.email);
      expect(
        Array.from(sectionForm("Profile").querySelectorAll("label")).some((l) =>
          (l.textContent ?? "").startsWith("Current password"),
        ),
      ).toBe(false);
    });

    it("a displayName-only save sends ONLY displayName — no email, no currentPassword, no birthDate", async () => {
      await render();
      setNativeValue(inputFor("Display name"), "Ada");
      await click(buttonFor("Save profile"));

      expect(apiPatchMock).toHaveBeenCalledTimes(1);
      const [, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({ displayName: "Ada" });
    });

    it("a birthDate-only save sends ONLY birthDate — dirty-fields-only holds for both re-auth-free members", async () => {
      await render();
      setNativeValue(birthDateInput(), "1991-02-03");
      await click(buttonFor("Save profile"));

      const [, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({ birthDate: "1991-02-03" });
    });

    it("changing displayName AND email sends both, plus currentPassword — never a full-form resubmit of the untouched field", async () => {
      await render();
      setNativeValue(inputFor("Display name"), "Ada");
      setNativeValue(inputFor("Email"), "new@example.com");
      setNativeValue(inputFor("Current password", sectionForm("Profile")), "hunter2");
      await click(buttonFor("Save profile"));

      const [, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({ displayName: "Ada", email: "new@example.com", currentPassword: "hunter2" });
      expect(options.body).not.toHaveProperty("birthDate");
    });
  });

  // ── E4/M1: email is now an OPTIONAL profile field ───────────────────────
  describe("optional email (E4/M1)", () => {
    it("the email field has no `required` attribute and is labelled optional", async () => {
      await render();
      expect(inputFor("Email").hasAttribute("required")).toBe(false);
      const label = Array.from(view!.container.querySelectorAll("label")).find((l) =>
        (l.textContent ?? "").startsWith("Email"),
      )!;
      expect(label.textContent).toMatch(/optional/i);
    });

    it("clearing the email PATCHes email: null and sends currentPassword — the same null-to-clear precedent as birthDate, plus re-auth", async () => {
      await render();
      expect(inputFor("Email").value).toBe(ME.email);
      setNativeValue(inputFor("Email"), "");
      setNativeValue(inputFor("Current password", sectionForm("Profile")), "hunter2");
      await click(buttonFor("Save profile"));

      expect(apiPatchMock).toHaveBeenCalledTimes(1);
      const [path, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(path).toBe("/users/me");
      expect(options.body["email"]).toBe(null);
      expect(options.body["currentPassword"]).toBe("hunter2");
    });

    it("a user with no email on file loads with an empty field, not a crash", async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path === "/users/me") return Promise.resolve({ ...ME, email: null });
        return Promise.resolve({ ...SETTINGS_DEFAULT });
      });
      await render();
      expect(inputFor("Email").value).toBe("");
    });

    it("a set email still round-trips as the string, alongside currentPassword", async () => {
      await render();
      setNativeValue(inputFor("Email"), "new@example.com");
      setNativeValue(inputFor("Current password", sectionForm("Profile")), "hunter2");
      await click(buttonFor("Save profile"));

      const [, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body["email"]).toBe("new@example.com");
      expect(options.body["currentPassword"]).toBe("hunter2");
    });

    it("wrong currentPassword 403s onto the Current password field, preserving the typed email", async () => {
      await render();
      apiPatchMock.mockImplementationOnce(() => Promise.reject(currentPasswordInvalidError()));
      setNativeValue(inputFor("Email"), "new@example.com");
      setNativeValue(inputFor("Current password", sectionForm("Profile")), "wrong");
      await click(buttonFor("Save profile"));

      const field = inputFor("Current password", sectionForm("Profile"));
      expect(field.closest("label")!.textContent).toMatch(/current password is incorrect/i);
      expect(field.value).toBe("wrong");
      expect(inputFor("Email").value).toBe("new@example.com");
    });
  });

  it("a set birth date still round-trips as the ISO string", async () => {
    await render();
    setNativeValue(birthDateInput(), "1991-02-03");
    await click(buttonFor("Save profile"));

    const [, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body["birthDate"]).toBe("1991-02-03");
  });

  // ── Playback preferences (H1, owner ledger item 6, closed) ─────────────
  describe("Playback preferences (language pickers)", () => {
    it("renders both pickers defaulted to 'No preference' when the server has no stored prefs", async () => {
      await render();
      expect(selectFor("Preferred audio language").value).toBe("");
      expect(selectFor("Preferred subtitle language").value).toBe("");
    });

    it("pre-selects whatever GET /users/me/settings returned", async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path === "/users/me") return Promise.resolve({ ...ME });
        return Promise.resolve({ ...SETTINGS_DEFAULT, audioPreferredLanguage: "fra", subtitlePreferredLanguage: "jpn" });
      });
      await render();
      expect(selectFor("Preferred audio language").value).toBe("fra");
      expect(selectFor("Preferred subtitle language").value).toBe("jpn");
    });

    it("saving sends the picked ISO 639-2 codes, and 'Saved' renders only after the PUT resolves 2xx", async () => {
      await render();
      setSelectValue(selectFor("Preferred audio language"), "fra");
      setSelectValue(selectFor("Preferred subtitle language"), "eng");

      const playbackCard = selectFor("Preferred audio language").closest("form")!;
      await click(Array.from(playbackCard.querySelectorAll("button")).find((b) => b.textContent === "Save")!);

      const call = apiPutMock.mock.calls.find(([path]) => path === "/users/me/settings");
      expect(call).toBeDefined();
      const [, options] = call as [string, { body: Record<string, unknown> }];
      expect(options.body["audioPreferredLanguage"]).toBe("fra");
      expect(options.body["subtitlePreferredLanguage"]).toBe("eng");
      // theme/autoplayNextEpisode/restrictedOptIn round-trip UNCHANGED —
      // this form offers no control for any of them (A-6).
      expect(options.body["theme"]).toBe(SETTINGS_DEFAULT.theme);
      expect(options.body["autoplayNextEpisode"]).toBe(SETTINGS_DEFAULT.autoplayNextEpisode);
      expect(options.body["restrictedOptIn"]).toBe(SETTINGS_DEFAULT.restrictedOptIn);

      expect(playbackCard.textContent ?? "").toMatch(/Saved/);
    });

    it("selecting 'No preference' after a stored language sends null", async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path === "/users/me") return Promise.resolve({ ...ME });
        return Promise.resolve({ ...SETTINGS_DEFAULT, audioPreferredLanguage: "fra" });
      });
      await render();
      expect(selectFor("Preferred audio language").value).toBe("fra");

      setSelectValue(selectFor("Preferred audio language"), "");
      const playbackCard = selectFor("Preferred audio language").closest("form")!;
      await click(Array.from(playbackCard.querySelectorAll("button")).find((b) => b.textContent === "Save")!);

      const [, options] = apiPutMock.mock.calls.find(([path]) => path === "/users/me/settings") as [
        string,
        { body: Record<string, unknown> },
      ];
      expect(options.body["audioPreferredLanguage"]).toBeNull();
    });

    it("browser-restricted-settings-F6 REGRESSION GUARD: each language name appears as exactly ONE option, not a B/T-code duplicate pair", async () => {
      await render();
      const options = Array.from(selectFor("Preferred audio language").querySelectorAll("option"));
      const albanian = options.filter((o) => o.textContent === "Albanian");
      expect(albanian).toHaveLength(1);
      const french = options.filter((o) => o.textContent === "French");
      expect(french).toHaveLength(1);
      // The de-dupe keeps the terminologic (T) code as the one option, not
      // the bibliographic (B) code — "fra" stays selectable, "fre" doesn't.
      expect(french[0]!.getAttribute("value")).toBe("fra");
    });

    it("a stored bibliographic (B) code still pre-selects correctly once the picker only offers its terminologic (T) pair", async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path === "/users/me") return Promise.resolve({ ...ME });
        return Promise.resolve({ ...SETTINGS_DEFAULT, audioPreferredLanguage: "fre" });
      });
      await render();
      // "fre" (French B code) no longer has its own <option> — the picker
      // must land on its "fra" (T code) equivalent, not a blank selection.
      expect(selectFor("Preferred audio language").value).toBe("fra");
    });

    it("a rejected PUT shows the error state and never 'Saved' — the lying-save bug this restores from", async () => {
      await render();
      apiPutMock.mockImplementation((path: string) => {
        if (path === "/users/me/settings") {
          return Promise.reject(new FakeApiError("subtitlePreferredLanguage must be a known ISO 639-2 language code."));
        }
        return Promise.resolve({ optIn: true, hasPin: true, unlockedUntilMs: null });
      });

      setSelectValue(selectFor("Preferred audio language"), "fra");
      const playbackCard = selectFor("Preferred audio language").closest("form")!;
      await click(Array.from(playbackCard.querySelectorAll("button")).find((b) => b.textContent === "Save")!);

      expect(playbackCard.textContent ?? "").toMatch(/must be a known ISO 639-2 language code/);
      expect(playbackCard.textContent ?? "").not.toMatch(/Saved/);
    });
  });

  // ── ChangePasswordSection: currentPassword re-auth (G10/F1-F3) ─────────
  describe("ChangePasswordSection currentPassword re-auth (G10)", () => {
    it("renders a Current password field with autoComplete=current-password", async () => {
      await render();
      const field = inputFor("Current password", sectionForm("Password"));
      expect(field.getAttribute("autocomplete")).toBe("current-password");
      expect(field.getAttribute("type")).toBe("password");
    });

    it("changing the password submits currentPassword + password and clears all three inputs", async () => {
      await render();
      setNativeValue(inputFor("Current password", sectionForm("Password")), "old-pw");
      setNativeValue(inputFor("New password"), "correct horse battery");
      setNativeValue(inputFor("Confirm new password"), "correct horse battery");
      await click(buttonFor("Change password"));

      expect(apiPatchMock).toHaveBeenCalledTimes(1);
      const [path, options] = apiPatchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(path).toBe("/users/me");
      expect(options.body).toEqual({ password: "correct horse battery", currentPassword: "old-pw" });
      expect(inputFor("Current password", sectionForm("Password")).value).toBe("");
      expect(inputFor("New password").value).toBe("");
      expect(inputFor("Confirm new password").value).toBe("");
    });

    it("a confirmation mismatch is rejected client-side without any request", async () => {
      await render();
      setNativeValue(inputFor("Current password", sectionForm("Password")), "old-pw");
      setNativeValue(inputFor("New password"), "correct horse battery");
      setNativeValue(inputFor("Confirm new password"), "correct horse batteru");
      await click(buttonFor("Change password"));

      expect(apiPatchMock).not.toHaveBeenCalled();
      expect(view!.container.textContent ?? "").toMatch(/don't match/i);
    });

    it("surfaces a server rejection instead of reporting success", async () => {
      await render();
      apiPatchMock.mockImplementationOnce(() => Promise.reject(new FakeApiError("Password is too short.")));
      setNativeValue(inputFor("Current password", sectionForm("Password")), "old-pw");
      setNativeValue(inputFor("New password"), "x");
      setNativeValue(inputFor("Confirm new password"), "x");
      await click(buttonFor("Change password"));

      const text = view!.container.textContent ?? "";
      expect(text).toMatch(/Password is too short\./);
      expect(text).not.toMatch(/Saved/);
    });

    it("wrong currentPassword 403s onto the Current password field, preserving the typed new password", async () => {
      await render();
      apiPatchMock.mockImplementationOnce(() => Promise.reject(currentPasswordInvalidError()));
      setNativeValue(inputFor("Current password", sectionForm("Password")), "wrong");
      setNativeValue(inputFor("New password"), "correct horse battery");
      setNativeValue(inputFor("Confirm new password"), "correct horse battery");
      await click(buttonFor("Change password"));

      const field = inputFor("Current password", sectionForm("Password"));
      expect(field.closest("label")!.textContent).toMatch(/current password is incorrect/i);
      expect(field.value).toBe("wrong");
      expect(inputFor("New password").value).toBe("correct horse battery");
      expect(inputFor("Confirm new password").value).toBe("correct horse battery");
      expect(view!.container.textContent ?? "").not.toMatch(/Saved/);
    });

    it("a 429 shows an honest rate-limited message, not a per-field error", async () => {
      await render();
      apiPatchMock.mockImplementationOnce(() => Promise.reject(rateLimitedError()));
      setNativeValue(inputFor("Current password", sectionForm("Password")), "old-pw");
      setNativeValue(inputFor("New password"), "correct horse battery");
      setNativeValue(inputFor("Confirm new password"), "correct horse battery");
      await click(buttonFor("Change password"));

      expect(view!.container.textContent ?? "").toMatch(/too many attempts/i);
      expect(
        inputFor("Current password", sectionForm("Password")).closest("label")!.textContent,
      ).not.toMatch(/incorrect/i);
    });

    it("'Other devices have been signed out.' renders only after the PATCH resolves 2xx — lying-Saved law", async () => {
      await render();
      setNativeValue(inputFor("Current password", sectionForm("Password")), "old-pw");
      setNativeValue(inputFor("New password"), "correct horse battery");
      setNativeValue(inputFor("Confirm new password"), "correct horse battery");

      const form = sectionForm("Password");
      // The intro paragraph legitimately says "your other devices" too —
      // assert the SPECIFIC success sentence, not the broader phrase.
      expect(form.textContent ?? "").not.toMatch(/other devices have been signed out/i);

      await click(buttonFor("Change password"));
      expect(form.textContent ?? "").toMatch(/saved/i);
      expect(form.textContent ?? "").toMatch(/other devices have been signed out/i);
    });

    it("a rejected change never renders the devices-signed-out sentence", async () => {
      await render();
      apiPatchMock.mockImplementationOnce(() => Promise.reject(new FakeApiError("Password is too short.")));
      setNativeValue(inputFor("Current password", sectionForm("Password")), "old-pw");
      setNativeValue(inputFor("New password"), "x");
      setNativeValue(inputFor("Confirm new password"), "x");
      await click(buttonFor("Change password"));

      expect(sectionForm("Password").textContent ?? "").not.toMatch(/other devices have been signed out/i);
    });
  });

  // ── Restricted-content PIN card ───────────────────────────────────────
  //
  // The lockout bug this covers: this card used to accept a PIN of ANY
  // length while PinModal — the only unlock UI — can submit exactly
  // PIN_LENGTH digits. Setting a 5-digit PIN here therefore made restricted
  // content permanently unreachable.
  describe("restricted-content PIN", () => {
    // ── G10/F4: currentPassword is ALWAYS present on this card — every
    //    call to PUT /users/me/restricted is account-critical, unlike the
    //    New PIN / Current PIN fields which come and go with optIn/hasPin.
    it("renders a Current password field (autoComplete=current-password) even before opting in", async () => {
      await render();
      const field = inputFor("Current password", sectionForm("Restricted content"));
      expect(field.getAttribute("autocomplete")).toBe("current-password");
      expect(field.getAttribute("type")).toBe("password");
    });

    it("wrong currentPassword 403s onto the Current password field, preserving the typed PIN", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: false };
      await render();
      apiPutMock.mockImplementationOnce(() => Promise.reject(currentPasswordInvalidError()));

      setNativeValue(inputFor("New PIN"), "1234");
      setNativeValue(inputFor("Current password", sectionForm("Restricted content")), "wrong");
      await click(buttonFor("Save"));

      const field = inputFor("Current password", sectionForm("Restricted content"));
      expect(field.closest("label")!.textContent).toMatch(/current password is incorrect/i);
      expect(field.value).toBe("wrong");
      expect(inputFor("New PIN").value).toBe("1234");
    });

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

      // Current password is `required` now too (G10) — fill it so the
      // native required-field check doesn't block the submit event before
      // this form's own PIN guard ever gets a chance to run.
      setNativeValue(inputFor("Current password", sectionForm("Restricted content")), "hunter2");
      setNativeValue(inputFor("New PIN"), "12");
      await click(buttonFor("Save"));

      expect(apiPutMock).not.toHaveBeenCalled();
      expect(view!.container.textContent ?? "").toMatch(new RegExp(`${PIN_LENGTH}-digit PIN`));
    });

    it("refuses to submit an empty PIN when no PIN exists yet", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: false };
      await render();

      setNativeValue(inputFor("Current password", sectionForm("Restricted content")), "hunter2");
      await click(buttonFor("Save"));

      expect(apiPutMock).not.toHaveBeenCalled();
      expect(view!.container.textContent ?? "").toMatch(new RegExp(`${PIN_LENGTH}-digit PIN`));
    });

    it("submits a PIN of exactly PIN_LENGTH digits — the only value PinModal can send back", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: false };
      await render();

      setNativeValue(inputFor("New PIN"), "1234");
      setNativeValue(inputFor("Current password", sectionForm("Restricted content")), "hunter2");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [path, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(path).toBe("/users/me/restricted");
      expect(options.body).toEqual({ optIn: true, pin: "1234", currentPassword: "hunter2" });
    });

    it("a blank New PIN with an existing PIN still saves — 'leave blank to keep current' is not a short PIN", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: true };
      await render();

      setNativeValue(inputFor("Current PIN"), "1234");
      setNativeValue(inputFor("Current password", sectionForm("Restricted content")), "hunter2");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).not.toHaveProperty("pin");
      expect(options.body["currentPin"]).toBe("1234");
      expect(options.body["currentPassword"]).toBe("hunter2");
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
      setNativeValue(inputFor("Current password", sectionForm("Restricted content")), "hunter2");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({ optIn: false, currentPin: "1234", currentPassword: "hunter2" });
    });

    it("a half-typed New PIN abandoned by toggling Off never blocks or reaches the wire", async () => {
      restrictedState = { ...RESTRICTED_DEFAULT, optIn: true, hasPin: true };
      await render();

      setNativeValue(inputFor("New PIN"), "12");
      await click(buttonFor("Off"));
      setNativeValue(inputFor("Current PIN"), "1234");
      setNativeValue(inputFor("Current password", sectionForm("Restricted content")), "hunter2");
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
      setNativeValue(inputFor("Current password", sectionForm("Restricted content")), "hunter2");
      await click(buttonFor("Save"));

      expect(apiPutMock).toHaveBeenCalledTimes(1);
      const [, options] = apiPutMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(options.body).toEqual({ optIn: true, pin: "1234", currentPin: "54321", currentPassword: "hunter2" });
    });
  });
});
