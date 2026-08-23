// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/shell/QuickSearch.test.tsx
//
// Regression coverage for a verified review finding: the Cmd-K palette's
// Restricted screen entry (quick-search-sources.ts's `restrictedOnly` +
// filterPaletteScreens' `isRestrictedEntitled` param, defaulted to false so
// an unwired caller fails closed) was added but QuickSearch.tsx never
// threaded the real entitlement through — the entry could never render.
// This file proves the wiring: QuickSearch must derive entitlement the
// SAME way every other zone entry point does (Sidebar's RestrictedNavEntry,
// the Browse chip, the mobile tab, UserMenu — see restricted-zone-count.js)
// and pass it as filterPaletteScreens' third argument, so an entitled
// viewer sees the entry and an unentitled one never does (U10: the zone's
// existence itself must stay hidden, not just its contents).
//
// apiGet/getAuthStore/useRouter/useRestricted are mocked and the module
// under test imported afterwards — the established convention in this
// directory's siblings (SearchPanel.test.tsx, AccountSection.test.tsx).
// useRestrictedZoneCount is mocked (it's the network-backed hook); the real
// hasRestrictedZoneEntitlement predicate from restricted-zone-count.js is
// left untouched via importActual, so this test exercises the actual
// fail-closed predicate, not a stand-in for it.
//
// `accessTokenState.value` defaults to null (the token most of this file's
// describe blocks want: instant local screen/action matches only, never the
// debounced catalog SearchPanel, which requires a non-null token to mount)
// — the browser-shell-browse-F4 describe block below sets it to a real
// token for its one catalog-Enter-key case, reset to null in its afterEach.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../ui/test-render.js";

const pushMock = vi.fn();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

const accessTokenState = vi.hoisted(() => ({ value: null as string | null }));
const apiGetMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: "https://loombre.local" }),
    getAccessToken: () => Promise.resolve(accessTokenState.value),
    logout: () => Promise.resolve(),
  }),
}));

vi.mock("../restricted/RestrictedProvider.js", () => ({
  useRestricted: () => ({
    state: { locked: false },
    openUnlockModal: () => {},
    lock: () => Promise.resolve(),
  }),
}));

const restrictedZoneCountMock = vi.fn<() => { count: number | null; loading: boolean }>();
vi.mock("../../lib/restricted-zone-count.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/restricted-zone-count.js")>(
    "../../lib/restricted-zone-count.js",
  );
  return {
    // hasRestrictedZoneEntitlement is left as the REAL predicate — only the
    // network-backed hook is faked.
    hasRestrictedZoneEntitlement: actual.hasRestrictedZoneEntitlement,
    useRestrictedZoneCount: () => restrictedZoneCountMock(),
  };
});

const { QuickSearch } = await import("./QuickSearch.js");

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fieldInput(view: TestRender): HTMLInputElement {
  return view.container.querySelector('input[name="quick-search"]') as HTMLInputElement;
}

/** Palette rows are rendered as `<button><span>label</span><span>hint</span></button>` —
 *  hint is "Screen" or "Action". Matching on the two spans (rather than the
 *  CSS-module class name) keeps this independent of hashed class names. */
function screenEntryLabels(view: TestRender): string[] {
  return Array.from(view.container.querySelectorAll("button"))
    .filter((b) => b.querySelectorAll("span")[1]?.textContent === "Screen")
    .map((b) => b.querySelectorAll("span")[0]?.textContent ?? "");
}

function actionEntryLabels(view: TestRender): string[] {
  return Array.from(view.container.querySelectorAll("button"))
    .filter((b) => b.querySelectorAll("span")[1]?.textContent === "Action")
    .map((b) => b.querySelectorAll("span")[0]?.textContent ?? "");
}

async function typeQuery(view: TestRender, value: string): Promise<void> {
  await act(async () => {
    setNativeValue(fieldInput(view), value);
  });
}

describe("QuickSearch — Restricted palette entry entitlement wiring", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    restrictedZoneCountMock.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("renders the Restricted screen for a zone-entitled viewer, and navigating to it calls router.push('/restricted')", async () => {
    restrictedZoneCountMock.mockReturnValue({ count: 7, loading: false });
    view = renderIntoBody(<QuickSearch isAdmin={false} />);
    await typeQuery(view, "restricted");

    expect(screenEntryLabels(view)).toContain("Restricted");

    const restrictedButton = Array.from(view.container.querySelectorAll("button")).find(
      (b) => b.querySelectorAll("span")[0]?.textContent === "Restricted" && b.querySelectorAll("span")[1]?.textContent === "Screen",
    ) as HTMLButtonElement;
    await act(async () => {
      restrictedButton.click();
    });
    expect(pushMock).toHaveBeenCalledWith("/restricted");
  });

  it("hides the Restricted screen entirely for a viewer with no zone entitlement (count: null)", async () => {
    restrictedZoneCountMock.mockReturnValue({ count: null, loading: false });
    view = renderIntoBody(<QuickSearch isAdmin={false} />);
    await typeQuery(view, "restricted");

    expect(screenEntryLabels(view)).not.toContain("Restricted");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("fails closed while the entitlement fetch is still loading (count: null, loading: true) — same as every other zone entry point", async () => {
    restrictedZoneCountMock.mockReturnValue({ count: null, loading: true });
    view = renderIntoBody(<QuickSearch isAdmin={false} />);
    await typeQuery(view, "restricted");

    expect(screenEntryLabels(view)).not.toContain("Restricted");
  });

  it("still renders the (ungated) Watchlist screen regardless of restricted-zone entitlement", async () => {
    restrictedZoneCountMock.mockReturnValue({ count: null, loading: false });
    view = renderIntoBody(<QuickSearch isAdmin={false} />);
    await typeQuery(view, "watchlist");

    expect(screenEntryLabels(view)).toContain("Watchlist");
  });

  // Regression (orchestrator exit-gate UI walk): the lock/unlock ACTION — not
  // just the screen — must be entitlement-gated. An unentitled viewer seeing
  // "Unlock restricted content" is a trace the zone exists.
  it("offers the lock/unlock ACTION to a zone-entitled viewer", async () => {
    restrictedZoneCountMock.mockReturnValue({ count: 7, loading: false });
    view = renderIntoBody(<QuickSearch isAdmin={false} />);
    await typeQuery(view, "restricted");
    // mock state.locked === false ⇒ the action reads "Lock restricted content"
    expect(actionEntryLabels(view)).toContain("Lock restricted content");
  });

  it("hides the lock/unlock ACTION entirely from a viewer with no zone entitlement (the leak fix)", async () => {
    restrictedZoneCountMock.mockReturnValue({ count: null, loading: false });
    view = renderIntoBody(<QuickSearch isAdmin={false} />);
    for (const q of ["restricted", "unlock", "lock"]) {
      await typeQuery(view, q);
      expect(actionEntryLabels(view)).not.toContain("Lock restricted content");
      expect(actionEntryLabels(view)).not.toContain("Unlock restricted content");
    }
    // the ungated Sign out action still works for everyone
    await typeQuery(view, "sign");
    expect(actionEntryLabels(view)).toContain("Sign out");
  });
});

// browser-shell-browse-F4 (P3 QA lead): this file's OWN header comment said
// "Enter with no result highlighted falls through to the full page" — but
// SearchPanel's activeIndex has defaulted to 0 (and been reset to 0 on every
// fresh result set) since this file's very first commit, so a highlight
// always exists the instant results do; Enter has never actually needed an
// arrow-key press first. That's the SAME auto-highlight-first-result
// convention command palettes/search UIs commonly use (VS Code's Cmd+K,
// Spotlight) — a real UX choice, not a bug — so the fix here is the doc,
// not the behavior: this locks in the real contract (Enter activates
// whatever is highlighted, index 0 by default, only falling through to
// /search when there are zero results) so the header comment can't drift
// from it silently again.
const MOVIE = {
  itemType: "movie" as const,
  item: {
    id: "movie-1",
    libraryId: "lib-1",
    itemType: "movie" as const,
    title: "Low Orbit",
    sortTitle: "Low Orbit",
    year: 2025,
    communityRating: null,
    contentClass: "general" as const,
    addedAtMs: 0,
    updatedAtMs: 0,
    contentRating: "R",
    runtimeMs: 6_600_000,
    overview: null,
    genres: [],
    images: [],
  },
};

describe("QuickSearch — browser-shell-browse-F4: Enter activates the default-highlighted result", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    pushMock.mockReset();
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/search") return Promise.resolve({ items: [MOVIE], nextCursor: null });
      if (path === "/people") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
    accessTokenState.value = "tok";
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    accessTokenState.value = null;
  });

  it("navigates to the first (default-highlighted) catalog result on Enter, with no arrow-key press first", async () => {
    restrictedZoneCountMock.mockReturnValue({ count: null, loading: false });
    view = renderIntoBody(<QuickSearch isAdmin={false} />);
    await typeQuery(view, "low orbit");
    // Let the 250ms debounce fire + the /search+/people fetch resolve.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });

    fieldInput(view).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(pushMock).toHaveBeenCalledWith("/items/movie/movie-1");
  });
});
