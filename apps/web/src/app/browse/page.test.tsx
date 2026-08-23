// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/browse/page.test.tsx
//
// REGRESSION GUARD (browser-shell-browse-F6, P3): sort lived only in a
// plain `useState`, never touching the URL — a fresh load/reload/share
// always landed back on "Recently Added" no matter what the user had
// picked, and there was no way to bookmark or link a sorted view. Pins the
// two-way sync: `?sort=` seeds the initial state, and picking a different
// sort writes it back via router.replace (alongside whatever `?library=`
// is already there).

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../components/ui/test-render.js";

const apiGetMock = vi.fn();
const nav = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

vi.mock("../../lib/auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: "https://loombre.local" }),
    getAccessToken: () => Promise.resolve("tok"),
  }),
}));

// Entitlement-gated chip, irrelevant to sort/URL sync — reduced to a
// passthrough (it otherwise needs a fuller auth-store double than this
// suite cares to build).
vi.mock("../../components/restricted/RestrictedZoneBrowseChip.js", () => ({
  RestrictedZoneBrowseChip: (): null => null,
}));

vi.mock("../../lib/now-playing.js", () => ({
  useNowPlayingItemIds: () => new Set<string>(),
}));

// The shell mounts the sidebar/websocket/providers, irrelevant to sort/URL
// sync — reduced to a passthrough (same convention as
// app/restricted/scenes/[id]/page.test.tsx).
vi.mock("../../components/shell/AppShell.js", () => ({
  AppShell: ({ children }: { children: React.ReactNode }): React.JSX.Element => <>{children}</>,
}));

const { default: BrowsePage } = await import("./page.js");

const LIBRARY = { id: "lib1", name: "Movies", mediaKind: "movie" };

function emptyPage(): Promise<{ items: unknown[]; nextCursor: null }> {
  return Promise.resolve({ items: [], nextCursor: null });
}

function installApiGetMock(): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/libraries") return Promise.resolve({ items: [LIBRARY] });
    if (path === "/movies") return emptyPage();
    return Promise.reject(new Error(`unexpected apiGet(${path})`));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("BrowsePage — browser-shell-browse-F6: sort round-trips through the URL", () => {
  let view: TestRender | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
    apiGetMock.mockReset();
    nav.replace.mockReset();
    nav.search = "";
  });

  it("seeds the active sort from ?sort= at mount, and requests that sort from the server", async () => {
    nav.search = "library=lib1&sort=title";
    installApiGetMock();
    view = renderIntoBody(<BrowsePage />);
    await flush();

    const sortGroup = view.container.querySelector('[role="radiogroup"][aria-label="Sort"]');
    const checked = sortGroup?.querySelector('[role="radio"][aria-checked="true"]');
    expect(checked?.textContent).toBe("Title A–Z");

    const moviesCall = apiGetMock.mock.calls.find((c) => c[0] === "/movies");
    expect(moviesCall?.[1]?.params?.query?.sort).toBe("title");
  });

  it("writes the new sort to the URL (preserving ?library=) when the user picks a different one", async () => {
    nav.search = "library=lib1";
    installApiGetMock();
    view = renderIntoBody(<BrowsePage />);
    await flush();

    const titlePill = Array.from(view.container.querySelectorAll('[role="radio"]')).find(
      (r) => r.textContent === "Title A–Z",
    ) as HTMLButtonElement;
    await act(async () => {
      titlePill.click();
    });
    await flush();

    expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining("sort=title"));
    expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining("library=lib1"));
  });
});
