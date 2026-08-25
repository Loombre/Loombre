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
import { emitCatalogInvalidation } from "../../../lib/catalog-invalidation.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPutMock = vi.fn();
const subscribeMock = vi.fn();

// d4-e6: the fake mirrors the real LoombreApiError's SHAPE, not just its
// identity. Every error the SDK throws carries an HTTP `status`, and the
// surfaces now read their copy through `apiErrorCopy` (lib/api-error-
// message.ts), which duck-types that status instead of the class — so a
// fake without one is not a stand-in for anything the app can receive, and
// a test built on it would prove nothing about the real path. 422 is the
// ordinary validation rejection; tests that need another Object.assign it.
class FakeApiError extends Error {
  status = 422;
}

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

/** d3-d5: GET /libraries now takes a `scope` — reads it out of the
 *  request init the component passed, without asserting on the rest. */
function scopeOf(init: unknown): string | undefined {
  const query = (init as { params?: { query?: Record<string, unknown> } } | undefined)?.params?.query;
  return typeof query?.["scope"] === "string" ? (query["scope"] as string) : undefined;
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
    // Prefix match: d3-d9 appends the library's path to this label.
    expect(view!.container.querySelector('[aria-label^="Manage qa-restricted"]')).toBeNull();
    expect(view!.container.querySelector('[aria-label^="Manage Movies"]')).not.toBeNull();
    // …and the list was re-read rather than trusted to local state.
    // (Scope-qualified: d3-d5 added a SECOND GET /libraries per load, the
    // administration-scoped one — this assertion is about the viewer-scoped
    // list being re-read, which is the one that can lie.)
    expect(apiGetMock.mock.calls.filter(([path, init]) => path === "/libraries" && scopeOf(init) === undefined)).toHaveLength(2);
  });
});

// browser-admin-F7 FOLLOW-UP (d3-d5, QA 2026-08-21 remediation dispatch 3,
// P2): the describe above is the "never show what the server withheld"
// half. Its cost was that a restricted library nobody holds a grant on is
// absent from the only listing that existed — and since the permissions
// editor is fed by that same listing, no grant could ever be issued to it
// from the UI. GET /libraries?scope=admin (admin-only) is the recovery
// route; this pane must surface the difference between the two scopes and
// offer the grant on it.
describe("LibrariesSection — d3-d5: grantless libraries are reachable from the admin-scoped listing", () => {
  function mockScopes(viewer: unknown[], admin: unknown[]): void {
    apiGetMock.mockImplementation((path: string, init?: unknown) => {
      if (path === "/libraries") {
        return Promise.resolve({ items: scopeOf(init) === "admin" ? admin : viewer, nextCursor: null });
      }
      if (path === "/users/me") return Promise.resolve({ id: "user-admin", username: "admin", isAdmin: true });
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
  }

  it("lists a restricted library the viewer-scoped list withholds, explains why, and offers the grant", async () => {
    mockScopes(LIBRARIES, [...LIBRARIES, RESTRICTED_LIBRARY]);
    await render();

    // The main list stays exactly what the viewer-scoped server answer says.
    expect(view!.container.querySelector("h1")?.textContent).toBe("Libraries · 1");
    expect(view!.container.querySelector('[aria-label^="Manage qa-restricted"]')).toBeNull();

    const text = view!.container.textContent ?? "";
    expect(text).toContain("Not visible to you");
    expect(text).toContain("qa-restricted");
    expect(text).toContain("/mnt/restricted");
    expect(buttonFor("Grant yourself access")).toBeTruthy();
  });

  it("grants the signed-in admin access to a hidden library and re-reads both scopes", async () => {
    mockScopes(LIBRARIES, [...LIBRARIES, RESTRICTED_LIBRARY]);
    apiPutMock.mockResolvedValue({ libraryId: "lib-r", permissions: [{ userId: "user-admin", granted: true }] });
    await render();

    await click(buttonFor("Grant yourself access"));

    expect(apiPutMock).toHaveBeenCalledWith("/libraries/{id}/permissions", {
      params: { path: { id: "lib-r" } },
      body: { libraryId: "lib-r", permissions: [{ userId: "user-admin", granted: true }] },
    });
    // A grant changes what the server will say — both scopes are re-read.
    expect(apiGetMock.mock.calls.filter(([path, init]) => path === "/libraries" && scopeOf(init) === undefined)).toHaveLength(2);
    expect(apiGetMock.mock.calls.filter(([path, init]) => path === "/libraries" && scopeOf(init) === "admin")).toHaveLength(2);
  });

  it("stays silent when the administration-scoped listing is refused — no group, no error banner", async () => {
    apiGetMock.mockImplementation((path: string, init?: unknown) => {
      if (path === "/libraries") {
        if (scopeOf(init) === "admin") return Promise.reject(new FakeApiError("Admin privileges are required."));
        return Promise.resolve({ items: LIBRARIES, nextCursor: null });
      }
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
    await render();

    expect(view!.container.querySelector("h1")?.textContent).toBe("Libraries · 1");
    expect(view!.container.textContent ?? "").not.toContain("Not visible to you");
    expect(view!.container.querySelector('[class*="errorBanner"]')).toBeNull();
  });
});

// d3-d7 (verify/settings-libraries-no-refresh-on-unlock, QA 2026-08-21
// remediation dispatch 3, P3): this pane loaded ONCE (useEffect(reload, []))
// and ignored emitCatalogInvalidation(), which RestrictedProvider fires on
// every confirmed lock<->unlock transition. Live: after granting access,
// unlocking flipped the header indicator but the list stayed "Libraries · 4"
// for 4s+; only a full reload showed 6 — while the F7 panel's own copy
// tells the admin that unlocking is what makes the library appear here.
describe("LibrariesSection — d3-d7: honours catalog invalidation", () => {
  function viewerReads(): unknown[] {
    return apiGetMock.mock.calls.filter(([path, init]) => path === "/libraries" && scopeOf(init) === undefined);
  }

  it("re-reads both scopes when a restricted lock/unlock invalidates the catalog", async () => {
    await render();
    expect(viewerReads()).toHaveLength(1);

    await act(async () => {
      emitCatalogInvalidation();
    });

    expect(viewerReads()).toHaveLength(2);
    expect(apiGetMock.mock.calls.filter(([path, init]) => path === "/libraries" && scopeOf(init) === "admin")).toHaveLength(2);
  });

  it("unsubscribes on unmount — a later invalidation must not refetch into a dead component", async () => {
    await render();
    view!.unmount();
    view = undefined;

    await act(async () => {
      emitCatalogInvalidation();
    });

    expect(viewerReads()).toHaveLength(1);
  });
});

// d3-d9 (verify/browser-admin-F9 adjacent, QA 2026-08-21 remediation
// dispatch 3, P3): library names are not unique, and this pane's own row
// menu was named `Manage ${library.name}` — two libraries called "Movies"
// gave assistive tech two buttons with the identical accessible name, and
// the Edit/Permissions dialogs were titled the same way. Sighted users get
// the path sub-line on the row; AT users got nothing. browser-admin-F9
// already solved this for the GRANT surfaces with library-path-label.ts —
// the same formatter belongs in all three places here.
describe("LibrariesSection — d3-d9: duplicate library names stay distinguishable", () => {
  const DUPLICATE_NAMES = [
    { ...LIBRARIES[0]! },
    {
      id: "lib-2",
      name: "Movies",
      mediaKind: "movie",
      paths: ["/srv/media/movies"],
      contentClass: "general",
      itemCount: 7,
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ];

  beforeEach(() => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/libraries") return Promise.resolve({ items: DUPLICATE_NAMES, nextCursor: null });
      if (path === "/users") return Promise.resolve({ items: [], nextCursor: null });
      if (path === "/libraries/{id}/permissions") return Promise.resolve({ libraryId: "lib-2", permissions: [] });
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
  });

  function menuLabels(): string[] {
    return Array.from(view!.container.querySelectorAll("button[aria-label]"))
      .map((b) => b.getAttribute("aria-label") ?? "")
      .filter((l) => l.startsWith("Manage "));
  }

  async function openRowMenu(index: number): Promise<void> {
    const triggers = Array.from(view!.container.querySelectorAll("button[aria-label^='Manage ']"));
    await click(triggers[index] as HTMLButtonElement);
  }

  function dialogLabel(): string {
    const dialog = view!.container.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("no dialog open");
    return dialog.getAttribute("aria-label") ?? "";
  }

  it("names each row menu by name AND path — never two identical 'Manage Movies' buttons", async () => {
    await render();

    const labels = menuLabels();
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain("/mnt/movies");
    expect(labels[1]).toContain("/srv/media/movies");
    expect(labels).not.toContain("Manage Movies");
  });

  it("titles the Edit dialog with the path, so the modal says WHICH 'Movies' is being edited", async () => {
    await render();
    await openRowMenu(1);
    await click(buttonFor("Edit"));

    expect(dialogLabel()).toContain("/srv/media/movies");
  });

  it("titles the Permissions dialog with the path too", async () => {
    await render();
    await openRowMenu(1);
    await click(buttonFor("Permissions"));

    expect(dialogLabel()).toContain("/srv/media/movies");
  });
});
