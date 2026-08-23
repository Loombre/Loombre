// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: LibrariesSection regression test — LD-5 (owner QA,
// 2026-08-10): the in-content "Libraries · N" heading duplicated the page
// title heading rendered right above it (both said "Libraries"). Fixed by
// attaching the count directly to the page title instead of a second,
// redundant h2. This pins: exactly one heading renders, it carries the
// count, and the standalone "Libraries · N" sub-heading is gone.
//
// browser-admin-F7 (QA 2026-08-21, P2): the second describe pins the
// list's other half of the same defect — the pane used to splice the
// POST /libraries response straight into local state, so a restricted
// library the viewer-scoped GET /libraries deliberately withholds
// (default-deny, no creator auto-grant) showed up as a row that the next
// reload silently deleted. The list must show what the server says it
// shows, always.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { ToastProvider } from "../../ui/Toast.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPutMock = vi.fn();
const subscribeMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  apiPatch: vi.fn(),
  apiPut: (...args: unknown[]) => apiPutMock(...args),
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

const RESTRICTED_LIBRARY = {
  id: "lib-r",
  name: "qa-restricted",
  mediaKind: "movie",
  paths: ["/mnt/restricted"],
  contentClass: "restricted",
  createdAtMs: 0,
  updatedAtMs: 0,
};

let view: TestRender | undefined;

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPutMock.mockReset();
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

function setNativeInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("LibrariesSection — browser-admin-F7: the list never shows a library the server withheld", () => {
  it("does not splice a freshly created restricted library into the list; it re-reads GET /libraries instead", async () => {
    apiPostMock.mockImplementation((path: string) => {
      if (path === "/libraries") return Promise.resolve(RESTRICTED_LIBRARY);
      if (path === "/libraries/{id}/scan") return Promise.resolve({});
      return Promise.reject(new Error(`unexpected apiPost(${path})`));
    });

    await render();
    await click(buttonFor("+ Add library"));

    const nameField = Array.from(view!.container.querySelectorAll("label"))
      .find((l) => (l.textContent ?? "").startsWith("Name"))!
      .querySelector("input") as HTMLInputElement;
    setNativeInputValue(nameField, "qa-restricted");
    setTextareaValue(view!.container.querySelector("textarea") as HTMLTextAreaElement, "/mnt/restricted");
    await click(buttonFor("Restricted"));
    await click(buttonFor("Create & scan"));

    // The reported symptom: "Libraries · 6" for one render, then · 5 after
    // a reload. Server truth here is one library, before AND after.
    expect(view!.container.querySelector("h1")?.textContent).toBe("Libraries · 1");
    expect(view!.container.querySelector('[aria-label="Manage qa-restricted"]')).toBeNull();
    expect(view!.container.querySelector('[aria-label="Manage Movies"]')).not.toBeNull();
    // …and the list was re-read rather than trusted to local state.
    expect(apiGetMock.mock.calls.filter(([path]) => path === "/libraries")).toHaveLength(2);
  });
});
