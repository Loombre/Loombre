// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/AddLibrarySheet.test.tsx
//
// D-3 (STATE.md W2+W3): the "Kind" SegmentedControl used to render the raw
// lowercase media_kind enum values (movie/tv/music) as its own labels.
// Fixed with a label map at the call site (same pattern app/setup/
// _components/LibraryStep.tsx already used) — this asserts BOTH halves of
// the contract: the rendered labels are title-case, AND the value that
// actually reaches the API (mediaKind on the POST /libraries body) stays
// the lowercase enum untouched.
//
// browser-admin-F7 (QA 2026-08-21, P2): the second describe pins the
// restricted-library creation flow. The server deliberately does NOT
// auto-grant the creating admin permission on a content_class='restricted'
// library (packages/db/src/query/libraries.ts — "default-deny, including
// for admins"), and GET /libraries is viewer-scoped, so the created
// library is invisible to its own creator until they hold a grant AND
// restricted content is unlocked. The UI used to hide that entirely: it
// closed the sheet and left the caller to insert a row that a reload
// silently dropped, with no surface anywhere that could issue the
// PUT /libraries/{id}/permissions the design requires next.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { ToastProvider } from "../../ui/Toast.js";

const apiPostMock = vi.fn();
const apiGetMock = vi.fn();
const apiPutMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../../lib/api-client.js", () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  LoombreApiError: FakeApiError,
}));

const { AddLibrarySheet } = await import("./AddLibrarySheet.js");

const CREATED_LIBRARY = {
  id: "lib-1",
  name: "Test Library",
  mediaKind: "tv",
  paths: ["/mnt/tv"],
  contentClass: "general",
  createdAtMs: 0,
  updatedAtMs: 0,
};

const RESTRICTED_LIBRARY = {
  id: "lib-r",
  name: "qa-restricted",
  mediaKind: "movie",
  paths: ["/mnt/restricted"],
  contentClass: "restricted",
  createdAtMs: 0,
  updatedAtMs: 0,
};

const ME = {
  id: "admin-1",
  username: "admin",
  email: null,
  isAdmin: true,
  birthDate: null,
  maxContentRating: null,
  createdAtMs: 0,
  updatedAtMs: 0,
};

let view: TestRender | null = null;

beforeEach(() => {
  apiPostMock.mockReset();
  apiGetMock.mockReset();
  apiPutMock.mockReset();
  // SheetOrModal -> useMediaQuery calls matchMedia unconditionally on
  // every render — jsdom has no real implementation (same stub
  // AddUserSheet.test.tsx already needs for the identical reason).
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
  view = null;
  vi.unstubAllGlobals();
});

function radiogroup(): HTMLElement {
  return view!.container.querySelector('[role="radiogroup"]') as HTMLElement;
}

function kindSegments(): HTMLButtonElement[] {
  return Array.from(radiogroup().querySelectorAll('button[role="radio"]'));
}

function inputFor(labelText: string): HTMLInputElement {
  const label = Array.from(view!.container.querySelectorAll("label")).find((l) =>
    (l.textContent ?? "").startsWith(labelText),
  );
  if (!label) throw new Error(`no field labelled "${labelText}"`);
  return label.querySelector("input")!;
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

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(view!.container.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;
}

function buttonFor(text: string): HTMLButtonElement {
  const button = findButton(text);
  if (!button) throw new Error(`no button labelled "${text}"`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

describe("AddLibrarySheet — Kind control (D-3 label-casing)", () => {
  it("renders title-case Kind labels, never the raw lowercase enum", () => {
    view = renderIntoBody(
      <ToastProvider>
        <AddLibrarySheet open onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );
    const labels = kindSegments().map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Movie", "TV", "Music"]);
    // The exact regression: the raw enum string appearing as a label.
    expect(labels).not.toContain("movie");
    expect(labels).not.toContain("tv");
    expect(labels).not.toContain("music");
  });

  it("selecting the 'TV' label sends the lowercase 'tv' enum value to the API, unchanged", async () => {
    apiPostMock.mockResolvedValueOnce(CREATED_LIBRARY).mockResolvedValueOnce({});
    view = renderIntoBody(
      <ToastProvider>
        <AddLibrarySheet open onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );

    setNativeInputValue(inputFor("Name"), "Test Library");
    await click(buttonFor("TV"));
    const pathsField = view.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(pathsField, "/mnt/tv");

    await click(buttonFor("Create & scan"));

    expect(apiPostMock).toHaveBeenCalledTimes(2);
    const [path, options] = apiPostMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/libraries");
    expect(options.body["mediaKind"]).toBe("tv");
  });

  it("defaults to the 'Movie' label selected, mapping to the 'movie' enum value", async () => {
    apiPostMock.mockResolvedValueOnce(CREATED_LIBRARY).mockResolvedValueOnce({});
    view = renderIntoBody(
      <ToastProvider>
        <AddLibrarySheet open onClose={() => {}} onCreated={() => {}} />
      </ToastProvider>,
    );

    expect(kindSegments()[0]!.getAttribute("data-active")).toBe("true");
    expect(kindSegments()[0]!.textContent?.trim()).toBe("Movie");

    setNativeInputValue(inputFor("Name"), "Default Kind Library");
    const pathsField = view.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(pathsField, "/mnt/movies");
    await click(buttonFor("Create & scan"));

    const [, options] = apiPostMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body["mediaKind"]).toBe("movie");
  });
});

describe("AddLibrarySheet — browser-admin-F7: restricted creation must not be a dead end", () => {
  /** d3-d6 note: `optOut` turns OFF the "Grant myself access" checkbox the
   *  restricted branch now carries (default ON), which is the only way to
   *  reach the panel with the manual grant offer still owed — the state
   *  these two cases were written against. */
  async function createRestricted(
    handlers: { onClose?: () => void; onCreated?: (lib: unknown) => void; optOut?: boolean } = {},
  ): Promise<void> {
    apiPostMock.mockResolvedValueOnce(RESTRICTED_LIBRARY).mockResolvedValueOnce({});
    view = renderIntoBody(
      <ToastProvider>
        <AddLibrarySheet open onClose={handlers.onClose ?? (() => {})} onCreated={handlers.onCreated ?? (() => {})} />
      </ToastProvider>,
    );
    setNativeInputValue(inputFor("Name"), "qa-restricted");
    const pathsField = view.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(pathsField, "/mnt/restricted");
    await click(buttonFor("Restricted"));
    if (handlers.optOut) {
      const checkbox = Array.from(view.container.querySelectorAll("label"))
        .find((l) => /grant myself access/i.test(l.textContent ?? ""))!
        .querySelector("input")!;
      await act(async () => {
        checkbox.click();
      });
    }
    await click(buttonFor("Create & scan"));
  }

  it("keeps the sheet open on a next-step panel that says the library is not visible yet", async () => {
    const onClose = vi.fn();
    await createRestricted({ onClose, optOut: true });

    // The trap: the sheet used to close on success exactly like a general
    // library, so the only feedback was a row the next reload deleted.
    expect(onClose).not.toHaveBeenCalled();
    expect(view!.container.textContent).toMatch(/will not appear/i);
    expect(findButton("Grant yourself access")).toBeTruthy();
  });

  it("'Grant yourself access' PUTs the creating admin into the new library's permissions", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me") return Promise.resolve(ME);
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
    await createRestricted({ optOut: true });

    await click(buttonFor("Grant yourself access"));

    expect(apiPutMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPutMock.mock.calls[0] as [
      string,
      { params: { path: { id: string } }; body: { libraryId: string; permissions: { userId: string; granted: boolean }[] } },
    ];
    expect(path).toBe("/libraries/{id}/permissions");
    expect(options.params.path.id).toBe("lib-r");
    expect(options.body.libraryId).toBe("lib-r");
    expect(options.body.permissions).toEqual([{ userId: "admin-1", granted: true }]);
    // Grant is gate 4 only — the panel must not claim the library is now
    // browsable (gate 5, the live unlock, is still owed).
    expect(view!.container.textContent).toMatch(/unlock restricted content/i);
  });

  it("a general library still closes the sheet immediately — no grant step", async () => {
    const onClose = vi.fn();
    apiPostMock.mockResolvedValueOnce(CREATED_LIBRARY).mockResolvedValueOnce({});
    view = renderIntoBody(
      <ToastProvider>
        <AddLibrarySheet open onClose={onClose} onCreated={() => {}} />
      </ToastProvider>,
    );
    setNativeInputValue(inputFor("Name"), "Test Library");
    const pathsField = view.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(pathsField, "/mnt/tv");
    await click(buttonFor("Create & scan"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(findButton("Grant yourself access")).toBeUndefined();
    expect(apiPutMock).not.toHaveBeenCalled();
  });
});

// d3-d6 (verify/admin-F7-residual-close-without-grant, QA 2026-08-21
// remediation dispatch 3, P2): the panel above explained the two remaining
// gates and OFFERED the grant — but its Close button dismissed the whole
// thing without one, reproduced live ("qa-restricted-orphan": zero
// library_permissions rows, absent from every listing the UI had). One
// click, and the original F7 trap was back. d3-d5 makes such a library
// recoverable; this makes producing one by accident impossible: the grant
// now rides along with the create by default, and opting out is an
// explicit choice that says what it costs.
describe("AddLibrarySheet — d3-d6: a restricted create can no longer orphan the library", () => {
  function stubSelfGrant(): void {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me") return Promise.resolve(ME);
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
    apiPutMock.mockResolvedValue({ libraryId: "lib-r", permissions: [{ userId: "admin-1", granted: true }] });
  }

  function grantSelfCheckbox(): HTMLInputElement {
    const label = Array.from(view!.container.querySelectorAll("label")).find((l) =>
      /grant myself access/i.test(l.textContent ?? ""),
    );
    if (!label) throw new Error("no 'Grant myself access' checkbox");
    return label.querySelector("input")!;
  }

  /** Fills the form and flips it to Restricted — stops before submitting so
   *  a case can inspect or toggle the grant checkbox, which only exists in
   *  the restricted branch. */
  async function fillRestricted(): Promise<void> {
    apiPostMock.mockResolvedValueOnce(RESTRICTED_LIBRARY).mockResolvedValueOnce({});
    setNativeInputValue(inputFor("Name"), "qa-restricted-orphan");
    setTextareaValue(view!.container.querySelector("textarea") as HTMLTextAreaElement, "/mnt/restricted");
    await click(buttonFor("Restricted"));
  }

  async function submit(): Promise<void> {
    await click(buttonFor("Create & scan"));
  }

  function mount(onClose = () => {}): void {
    view = renderIntoBody(
      <ToastProvider>
        <AddLibrarySheet open onClose={onClose} onCreated={() => {}} />
      </ToastProvider>,
    );
  }

  it("issues the self-grant as part of the create, so dismissing the panel cannot leave an orphan", async () => {
    stubSelfGrant();
    mount();
    await fillRestricted();
    expect(grantSelfCheckbox().checked).toBe(true);
    await submit();

    expect(apiPutMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPutMock.mock.calls[0] as [
      string,
      { params: { path: { id: string } }; body: { permissions: { userId: string; granted: boolean }[] } },
    ];
    expect(path).toBe("/libraries/{id}/permissions");
    expect(options.params.path.id).toBe("lib-r");
    expect(options.body.permissions).toEqual([{ userId: "admin-1", granted: true }]);

    // Nothing is left owed but gate 5, so there is no grant offer and the
    // dismiss button is an ordinary one.
    expect(findButton("Grant yourself access")).toBeUndefined();
    expect(findButton("Close without access")).toBeUndefined();
    expect(view!.container.textContent).toMatch(/unlock restricted content/i);
  });

  it("opting out is explicit, and the dismiss button then says what it costs and where the library went", async () => {
    stubSelfGrant();
    mount();
    await fillRestricted();
    await act(async () => {
      grantSelfCheckbox().click();
    });
    expect(grantSelfCheckbox().checked).toBe(false);
    await submit();

    expect(apiPutMock).not.toHaveBeenCalled();
    expect(findButton("Grant yourself access")).toBeTruthy();
    expect(buttonFor("Close without access")).toBeTruthy();
    // The recovery route d3-d5 added, named at the moment it becomes the
    // only way back.
    expect(view!.container.textContent).toMatch(/not visible to you/i);
  });

  it("a failed grant is reported, never silently swallowed into a 'created' close", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me") return Promise.resolve(ME);
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
    apiPutMock.mockRejectedValue(new FakeApiError("Admin privileges are required."));
    const onClose = vi.fn();
    mount(onClose);
    await fillRestricted();
    await submit();

    expect(onClose).not.toHaveBeenCalled();
    expect(view!.container.textContent).toContain("Admin privileges are required.");
    expect(findButton("Grant yourself access")).toBeTruthy();
    expect(findButton("Close without access")).toBeTruthy();
  });

  it("the grant checkbox is restricted-only — a general library never shows it and never PUTs", async () => {
    const onClose = vi.fn();
    apiPostMock.mockResolvedValueOnce(CREATED_LIBRARY).mockResolvedValueOnce({});
    view = renderIntoBody(
      <ToastProvider>
        <AddLibrarySheet open onClose={onClose} onCreated={() => {}} />
      </ToastProvider>,
    );
    setNativeInputValue(inputFor("Name"), "Test Library");
    const pathsField = view.container.querySelector("textarea") as HTMLTextAreaElement;
    setTextareaValue(pathsField, "/mnt/tv");
    // The checkbox belongs to the restricted branch only: a general
    // library already auto-grants its creator server-side.
    expect(
      Array.from(view.container.querySelectorAll("label")).some((l) => /grant myself access/i.test(l.textContent ?? "")),
    ).toBe(false);
    await click(buttonFor("Create & scan"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(findButton("Grant yourself access")).toBeUndefined();
    expect(apiPutMock).not.toHaveBeenCalled();
  });
});

// d4-e3 (D/d3-d6-adjacent, backlog #106): d3-d6 relabelled the panel's own
// dismiss button to "Close without access" — but SheetOrModal's HEADER
// dismiss control (the shared primitive's Done button, present in both the
// sheet and the dialog branch) ran the same plain onClose while still saying
// "Done". An ungranted restricted library could be abandoned from a control
// whose label claimed the flow was finished, with no warning at the click
// itself. The sheet already OWNS that label — SheetOrModal takes doneLabel —
// it simply never passed one.
describe("AddLibrarySheet — d4-e3: the sheet's own header dismiss cannot claim 'Done'", () => {
  function stubSelfGrant(): void {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me") return Promise.resolve(ME);
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
    apiPutMock.mockResolvedValue({ libraryId: "lib-r", permissions: [{ userId: "admin-1", granted: true }] });
  }

  function mount(onClose = () => {}): void {
    view = renderIntoBody(
      <ToastProvider>
        <AddLibrarySheet open onClose={onClose} onCreated={() => {}} />
      </ToastProvider>,
    );
  }

  /** The dismiss control SheetOrModal renders itself — the first button in
   *  whichever child of the dialog carries its title. Structural rather than
   *  by class so it finds the same control in the phone (BottomSheet) and
   *  desktop (dialog) branch alike. */
  function headerDismiss(): HTMLButtonElement {
    const dialog = view!.container.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("no dialog rendered");
    const header = Array.from(dialog.children).find((child) => child.querySelector("h2"));
    if (!header) throw new Error("no dialog header");
    const button = header.querySelector("button");
    if (!button) throw new Error("no header dismiss control");
    return button as HTMLButtonElement;
  }

  async function createRestricted(optOut: boolean): Promise<void> {
    apiPostMock.mockResolvedValueOnce(RESTRICTED_LIBRARY).mockResolvedValueOnce({});
    setNativeInputValue(inputFor("Name"), "qa-restricted-header-dismiss");
    setTextareaValue(view!.container.querySelector("textarea") as HTMLTextAreaElement, "/mnt/restricted");
    await click(buttonFor("Restricted"));
    if (optOut) {
      const checkbox = Array.from(view!.container.querySelectorAll("label"))
        .find((l) => /grant myself access/i.test(l.textContent ?? ""))!
        .querySelector("input")!;
      await act(async () => {
        checkbox.click();
      });
    }
    await click(buttonFor("Create & scan"));
  }

  it("relabels its header dismiss while a grant is still owed", async () => {
    stubSelfGrant();
    mount();
    await createRestricted(true);

    expect(headerDismiss().textContent?.trim()).toBe("Close without access");
    // The exact regression: a control that says the flow finished, on a
    // panel whose whole point is that it did not.
    expect(findButton("Done")).toBeUndefined();
  });

  it("still dismisses — the relabel is a warning, never a trap", async () => {
    const onClose = vi.fn();
    stubSelfGrant();
    mount(onClose);
    await createRestricted(true);

    await click(headerDismiss());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says 'Done' again once the grant landed, because then it really is done", async () => {
    stubSelfGrant();
    mount();
    await createRestricted(false);

    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(headerDismiss().textContent?.trim()).toBe("Done");
  });

  it("a failed grant gets the same warning label as an opted-out one", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users/me") return Promise.resolve(ME);
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
    apiPutMock.mockRejectedValue(new FakeApiError("Admin privileges are required."));
    mount();
    await createRestricted(false);

    expect(headerDismiss().textContent?.trim()).toBe("Close without access");
  });

  it("the ordinary create form keeps the plain 'Done' header control", () => {
    mount();
    expect(headerDismiss().textContent?.trim()).toBe("Done");
  });
});
