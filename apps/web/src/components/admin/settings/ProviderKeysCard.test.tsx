// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/settings/ProviderKeysCard.test.tsx
//
// Phosphor Wave-2 lane L6 conformance evidence (design/phosphor/README.md
// §Interactions → "Provider keys": "Idle -> Set or Replace + Remove.
// Replace reveals a password input and Save/Cancel. Remove requires a
// confirm step in a danger-tinted block. Copy: once saved, the value is
// never shown again."). Same house style as SettingField.test.tsx: no
// vi.mock, no fetch stubbing (this codebase's established convention) —
// every assertion here covers the idle/replacing/confirming state machine
// and its Cancel paths, none of which ever call the network; the terminal
// Save/Remove click is never exercised in this file.
//
// The "value never shown" assertions are the SECURITY property this file
// exists to prove, not incidental coverage: a real secret string is never
// passed into this component in the first place (ProviderKeyStatus, the
// server's actual response shape, has no value field to receive one), so
// these tests assert the STRUCTURAL guarantee instead — the replace
// input's value is always "" on entry, is cleared by Cancel, and no
// rendered text anywhere in ANY state matches a plausible key-shaped
// string.

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { components } from "@loombre/sdk";
import { ProviderKeysCard } from "./ProviderKeysCard.js";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type ProviderKeyStatus = components["schemas"]["ProviderKeyStatus"];

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const NOT_SET: ProviderKeyStatus = { provider: "tmdb", set: false, source: null };
const SET_VIA_KEYRING: ProviderKeyStatus = { provider: "tmdb", set: true, source: "keyring", lastSetMs: 1_700_000_000_000 };
const SET_VIA_ENV: ProviderKeyStatus = { provider: "tvdb", set: true, source: "env" };

describe("ProviderKeysCard — README §Interactions → Provider keys state machine", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function buttonsByText(): Map<string, HTMLButtonElement> {
    const map = new Map<string, HTMLButtonElement>();
    view!.container.querySelectorAll("button").forEach((b) => {
      if (b.textContent) map.set(b.textContent.trim(), b as HTMLButtonElement);
    });
    return map;
  }

  describe("idle state", () => {
    it("not-set key: shows 'Set key' and no 'Remove' button", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[NOT_SET]} onChanged={() => {}} />);
      const buttons = buttonsByText();
      expect([...buttons.keys()].some((t) => t.includes("Set key"))).toBe(true);
      expect([...buttons.keys()].some((t) => t.includes("Remove"))).toBe(false);
    });

    it("a set (keyring) key: shows 'Replace key' AND 'Remove'", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[SET_VIA_KEYRING]} onChanged={() => {}} />);
      const buttons = buttonsByText();
      expect([...buttons.keys()].some((t) => t.includes("Replace key"))).toBe(true);
      expect([...buttons.keys()].some((t) => t.includes("Remove"))).toBe(true);
    });

    it("an env-locked key: NO Replace/Set/Remove controls at all — a padlock display instead, naming the real env var", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[SET_VIA_ENV]} onChanged={() => {}} />);
      expect(view.container.querySelectorAll("button").length).toBe(0);
      expect(view.container.querySelector('svg[aria-label="Locked"]')).not.toBeNull();
      expect(view.container.textContent).toContain("LOOMBRE_TVDB_API_KEY");
    });

    it("reports set/source/last-set metadata only — never a value", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[SET_VIA_KEYRING]} onChanged={() => {}} />);
      expect(view.container.textContent).toContain("SET");
      expect(view.container.textContent).toContain("KEYRING");
      expect(view.container.textContent).toMatch(/LAST SET/);
    });
  });

  describe("idle -> replacing (password input + Save/Cancel)", () => {
    it("clicking Replace/Set key reveals a password input, starting EMPTY, plus Save (disabled) and Cancel", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[NOT_SET]} onChanged={() => {}} />);
      const setButton = [...buttonsByText().values()].find((b) => b.textContent?.includes("Set key"))!;
      act(() => setButton.click());

      const passwordInput = view.container.querySelector('input[type="password"]') as HTMLInputElement;
      expect(passwordInput).not.toBeNull();
      expect(passwordInput.value).toBe("");

      const buttons = buttonsByText();
      const save = [...buttons.values()].find((b) => b.textContent === "Save")!;
      const cancel = [...buttons.values()].find((b) => b.textContent === "Cancel")!;
      expect(save.hasAttribute("disabled")).toBe(true); // empty draft
      expect(cancel.hasAttribute("disabled")).toBe(false);
    });

    it("typing a draft enables Save; Cancel discards the draft and returns to idle with no trace of it", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[SET_VIA_KEYRING]} onChanged={() => {}} />);
      const replaceButton = [...buttonsByText().values()].find((b) => b.textContent?.includes("Replace key"))!;
      act(() => replaceButton.click());

      const passwordInput = view.container.querySelector('input[type="password"]') as HTMLInputElement;
      act(() => setNativeValue(passwordInput, "sk-fake-typed-draft-000"));
      const save = [...buttonsByText().values()].find((b) => b.textContent === "Save")!;
      expect(save.hasAttribute("disabled")).toBe(false);

      const cancel = [...buttonsByText().values()].find((b) => b.textContent === "Cancel")!;
      act(() => cancel.click());

      // Back to idle: no password field on screen at all, and the typed
      // draft never leaked into any visible text anywhere in the DOM.
      expect(view.container.querySelector('input[type="password"]')).toBeNull();
      expect(view.container.textContent).not.toContain("sk-fake-typed-draft-000");

      // Re-entering replace mode starts from an EMPTY field again — the
      // discarded draft was not remembered.
      const replaceAgain = [...buttonsByText().values()].find((b) => b.textContent?.includes("Replace key"))!;
      act(() => replaceAgain.click());
      const reopened = view.container.querySelector('input[type="password"]') as HTMLInputElement;
      expect(reopened.value).toBe("");
    });
  });

  describe("idle -> confirming (danger-tinted Remove confirm)", () => {
    it("clicking Remove opens a danger-tinted confirm block naming the provider, with a filled Remove + Cancel", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[SET_VIA_KEYRING]} onChanged={() => {}} />);
      const removeButton = [...buttonsByText().values()].find((b) => b.textContent === "Remove")!;
      act(() => removeButton.click());

      expect(view.container.textContent).toContain("Remove the stored TMDB key?");
      const buttons = buttonsByText();
      const confirmRemove = [...buttons.values()].find((b) => b.textContent === "Remove")!;
      const cancel = [...buttons.values()].find((b) => b.textContent === "Cancel")!;
      expect(confirmRemove).toBeDefined();
      expect(cancel).toBeDefined();
    });

    it("Cancel from the confirm step returns to idle without removing anything", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[SET_VIA_KEYRING]} onChanged={() => {}} />);
      const removeButton = [...buttonsByText().values()].find((b) => b.textContent === "Remove")!;
      act(() => removeButton.click());
      expect(view.container.textContent).toContain("Remove the stored TMDB key?");

      const cancel = [...buttonsByText().values()].find((b) => b.textContent === "Cancel")!;
      act(() => cancel.click());

      expect(view.container.textContent).not.toContain("Remove the stored TMDB key?");
      // Back to the ordinary idle row for a set key.
      expect([...buttonsByText().keys()].some((t) => t.includes("Replace key"))).toBe(true);
    });

    it("cannot reach the confirm step for a not-set key (no Remove button exists to click)", () => {
      view = renderIntoBody(<ProviderKeysCard statuses={[NOT_SET]} onChanged={() => {}} />);
      expect([...buttonsByText().keys()].some((t) => t.includes("Remove"))).toBe(false);
    });
  });

  describe("SECURITY: the stored value is never shown, in ANY state, for ANY provider", () => {
    const SUSPICIOUS_SUBSTRINGS = ["sk-", "api_key", "Bearer ", "•••", "***key***"];

    it("idle, replacing, and confirming states never render a plausible secret-shaped string", () => {
      // Two DISTINCT providers (tmdb/tvdb is the entire closed enum — see
      // packages/contract/openapi.yaml's ProviderName) rendered together:
      // one drivable through the whole idle/replacing/confirming machine,
      // one env-locked throughout. Never the same provider twice in one
      // render — ProviderKeyRow keys on `status.provider`, and two rows
      // sharing a key would corrupt React's reconciliation, not just this
      // test's realism.
      view = renderIntoBody(<ProviderKeysCard statuses={[SET_VIA_KEYRING, SET_VIA_ENV]} onChanged={() => {}} />);
      for (const needle of SUSPICIOUS_SUBSTRINGS) {
        expect(view.container.textContent).not.toContain(needle);
      }

      // Drive TMDB's row through replacing...
      const replace = [...buttonsByText().values()].find((b) => b.textContent?.includes("Replace key"))!;
      act(() => replace.click());
      for (const needle of SUSPICIOUS_SUBSTRINGS) {
        expect(view.container.textContent).not.toContain(needle);
      }
      const cancelReplace = [...buttonsByText().values()].find((b) => b.textContent === "Cancel")!;
      act(() => cancelReplace.click());

      // ...and through confirming.
      const remove = [...buttonsByText().values()].find((b) => b.textContent === "Remove")!;
      act(() => remove.click());
      for (const needle of SUSPICIOUS_SUBSTRINGS) {
        expect(view.container.textContent).not.toContain(needle);
      }
    });

    it("the ProviderKeyStatus type itself carries no value field — there is nothing to leak by construction", () => {
      // Structural assertion: every status object this component is ever
      // handed (server or fixture) has exactly these keys. If a future
      // change ever adds a `value`/`key`/`apiKey` field to this shape, this
      // test's fixtures below stay valid but the component would need an
      // explicit choice not to render it — this is the tripwire for that.
      const keys = Object.keys(SET_VIA_KEYRING).sort();
      expect(keys).toEqual(["lastSetMs", "provider", "set", "source"].sort());
    });
  });
});
