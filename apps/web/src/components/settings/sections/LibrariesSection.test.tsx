// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LibrariesSection regression test — LD-5 (owner QA,
// 2026-08-10): the in-content "Libraries · N" heading duplicated the page
// title heading rendered right above it (both said "Libraries"). Fixed by
// attaching the count directly to the page title instead of a second,
// redundant h2. This pins: exactly one heading renders, it carries the
// count, and the standalone "Libraries · N" sub-heading is gone.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { ToastProvider } from "../../ui/Toast.js";

const apiGetMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: subscribeMock }),
}));

const { LibrariesSection } = await import("./LibrariesSection.js");

const LIBRARIES = [
  {
    id: "lib-1",
    name: "Movies",
    mediaKind: "movie",
    paths: ["/mnt/movies"],
    contentClass: "general",
    itemCount: 42,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

let view: TestRender | undefined;

beforeEach(() => {
  apiGetMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockReturnValue(() => {});
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/libraries") return Promise.resolve({ items: LIBRARIES, nextCursor: null });
    return Promise.reject(new Error(`unexpected apiGet(${path})`));
  });
  // AddLibrarySheet's SheetOrModal calls useMediaQuery unconditionally on
  // every render (AddLibrarySheet.test.tsx's own established stub — jsdom
  // has no real matchMedia).
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
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  view = renderIntoBody(
    <ToastProvider>
      <LibrariesSection heading="Libraries" />
    </ToastProvider>,
  );
  await act(async () => {});
}

describe("LibrariesSection — LD-5 (owner QA, 2026-08-10): no duplicate heading", () => {
  it("renders exactly one heading, carrying the page title AND the count — no separate 'Libraries · N' sub-heading", async () => {
    await render();

    const headings = view!.container.querySelectorAll("h1, h2, h3");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.tagName).toBe("H1");
    expect(headings[0]?.textContent).toBe("Libraries · 1");
  });
});
