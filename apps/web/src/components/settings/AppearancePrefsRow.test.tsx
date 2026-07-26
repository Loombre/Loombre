// SPDX-License-Identifier: AGPL-3.0-only
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppearancePrefsRow } from "./AppearancePrefsRow.js";
import { ACCENT_NAMES, getAppearancePrefs } from "../../lib/appearance-prefs.js";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

describe("AppearancePrefsRow", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-scanlines");
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-scanlines");
  });

  it("renders exactly the four README accent swatches, amber selected by default", () => {
    view = renderIntoBody(<AppearancePrefsRow />);
    const swatches = view.container.querySelectorAll('[role="radio"]');
    expect(swatches.length).toBe(ACCENT_NAMES.length);
    const selected = view.container.querySelector('[data-selected="true"]');
    expect(selected?.getAttribute("aria-label")).toBe("Amber");
  });

  it("clicking a swatch persists + applies the choice, and updates the selected state", () => {
    view = renderIntoBody(<AppearancePrefsRow />);
    const limeSwatch = Array.from(view.container.querySelectorAll('[role="radio"]')).find(
      (el) => el.getAttribute("aria-label") === "Lime",
    ) as HTMLButtonElement;

    act(() => {
      limeSwatch.click();
    });

    expect(getAppearancePrefs().accent).toBe("lime");
    expect(document.documentElement.getAttribute("data-accent")).toBe("lime");
    expect(limeSwatch.getAttribute("data-selected")).toBe("true");
    expect(limeSwatch.getAttribute("aria-checked")).toBe("true");
  });

  it("the scanlines toggle starts checked (default on) and toggling it off persists + applies", () => {
    view = renderIntoBody(<AppearancePrefsRow />);
    const toggleInput = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggleInput.checked).toBe(true);

    act(() => {
      toggleInput.click();
    });

    expect(getAppearancePrefs().scanlines).toBe(false);
    expect(document.documentElement.getAttribute("data-scanlines")).toBe("off");
    expect(toggleInput.checked).toBe(false);
  });
});
