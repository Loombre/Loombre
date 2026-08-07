// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/UserMenu.test.tsx
//
// W11 (Wave 2, this run — IA restructure): covers the two behaviors that
// wave's brief called out by name —
//   1. "Profile settings" is a real row, alongside Watchlist and Sign out,
//      navigating to /profile (D-6's new user-scoped settings home).
//   2. Keyboard navigation: ArrowDown/ArrowUp roving focus among items,
//      Escape closes the menu and returns focus to the trigger button —
//      on top of the pre-existing role="menu"/role="menuitem" semantics.
// Restricted-zone-entitlement gating (hasRestrictedZoneEntitlement) is
// pre-existing behavior, pinned once here for good measure alongside the
// new coverage rather than left completely untested.
//
// next/navigation, auth-store, and the restricted-zone-count hook are
// mocked and the module under test imported afterwards — the established
// convention in this directory (QuickSearch.test.tsx).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const pushMock = vi.fn();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

const logoutMock = vi.fn(() => Promise.resolve());
vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({ logout: logoutMock }),
}));

let restrictedCount: number | null = null;
vi.mock("../../lib/restricted-zone-count.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/restricted-zone-count.js")>(
    "../../lib/restricted-zone-count.js",
  );
  return {
    // hasRestrictedZoneEntitlement is left as the REAL predicate — only the
    // network-backed hook is faked, same posture QuickSearch.test.tsx uses.
    hasRestrictedZoneEntitlement: actual.hasRestrictedZoneEntitlement,
    useRestrictedZoneCount: () => ({ count: restrictedCount, loading: false }),
  };
});

const { UserMenu } = await import("./UserMenu.js");

describe("UserMenu", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    logoutMock.mockClear();
    restrictedCount = null;
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<UserMenu username="ada" />);
    await act(async () => {});
  }

  function trigger(): HTMLButtonElement {
    return view!.container.querySelector('button[aria-label="User menu"]')!;
  }

  async function open(): Promise<void> {
    await act(async () => {
      trigger().click();
    });
  }

  function menuItems(): HTMLButtonElement[] {
    return Array.from(view!.container.querySelectorAll('[role="menuitem"]'));
  }

  function itemByText(text: string): HTMLButtonElement {
    const item = menuItems().find((el) => (el.textContent ?? "").trim() === text);
    if (!item) throw new Error(`no menuitem labelled "${text}"`);
    return item;
  }

  async function keydown(el: HTMLElement, key: string): Promise<void> {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  it("opens on trigger click, exposing role=menu with aria-expanded wired on the trigger", async () => {
    await render();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(view!.container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("renders Profile settings, Watchlist, and Sign out as real menuitem rows", async () => {
    await render();
    await open();
    expect(itemByText("Profile settings")).toBeDefined();
    expect(itemByText("Watchlist")).toBeDefined();
    expect(itemByText("Sign out")).toBeDefined();
  });

  it("Profile settings navigates to /profile and closes the menu", async () => {
    await render();
    await open();
    await act(async () => {
      itemByText("Profile settings").click();
    });
    expect(pushMock).toHaveBeenCalledWith("/profile");
    expect(view!.container.querySelector('[role="menu"]')).toBeNull();
  });

  it("Sign out calls the auth store's logout and redirects to /login", async () => {
    await render();
    await open();
    await act(async () => {
      itemByText("Sign out").click();
    });
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  it("hides the Restricted zone row for a viewer with no zone entitlement, shows it once entitled", async () => {
    restrictedCount = null;
    await render();
    await open();
    expect(menuItems().some((el) => (el.textContent ?? "").includes("Restricted zone"))).toBe(false);

    view!.unmount();
    restrictedCount = 3;
    await render();
    await open();
    expect(menuItems().some((el) => (el.textContent ?? "").includes("Restricted zone"))).toBe(true);
  });

  it("focuses the first menu item automatically once the menu opens", async () => {
    await render();
    await open();
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it("ArrowDown/ArrowUp move roving focus among items, wrapping at both ends", async () => {
    await render();
    await open();
    const items = menuItems();
    const last = items[items.length - 1]!;

    // Wrap backward from the first (already-focused) item to the last.
    await keydown(document.activeElement as HTMLElement, "ArrowUp");
    expect(document.activeElement).toBe(last);

    // Wrap forward from the last item back to the first.
    await keydown(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);
  });

  it("Escape closes the menu and returns focus to the trigger button", async () => {
    await render();
    await open();
    await keydown(document.activeElement as HTMLElement, "Escape");
    expect(view!.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("ArrowDown on the trigger opens the menu and focuses the first item", async () => {
    await render();
    await keydown(trigger(), "ArrowDown");
    expect(view!.container.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it("ArrowUp on the trigger opens the menu and focuses the last item", async () => {
    await render();
    await keydown(trigger(), "ArrowUp");
    const items = menuItems();
    expect(document.activeElement).toBe(items[items.length - 1]);
  });
});
