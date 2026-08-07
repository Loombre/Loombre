// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/DirectoryPicker.test.tsx
//
// The macOS live-test field report behind this file: browsing /Users/ozzy
// under the installed pkg returned a 403 (the _loombre daemon cannot read
// a 700 home dir), and the picker rendered the literal word "Forbidden" —
// LoombreApiError.message carries only the RFC 9457 `title`, and the
// server's actionable `detail` sentence was dropped on the floor. These
// tests pin the two-part fix: (1) errors render via apiErrorMessage
// (detail-first, V-UX F2/F3), and (2) entries the server cannot descend
// into arrive as readable:false and are MARKED, not hidden, so the dead
// end is visible before the click.
//
// apiGet is mocked and the module under test imported afterwards — the
// established convention here (AddUserSheet.test.tsx,
// RestrictedStep.test.tsx).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}));

const { DirectoryPicker } = await import("./DirectoryPicker.js");

const PERMISSION_DETAIL =
  "Loombre's service account (_loombre) cannot read this folder — macOS keeps personal home folders private.";

const ROOTS = {
  path: null,
  parent: null,
  entries: [
    { name: "/", path: "/", readable: true },
    { name: "/Users", path: "/Users", readable: true },
  ],
};

const USERS = {
  path: "/Users",
  parent: "/",
  entries: [
    { name: "Shared", path: "/Users/Shared", readable: true },
    { name: "ozzy", path: "/Users/ozzy", readable: false },
  ],
};

/** Duck-typed LoombreApiError stand-in: apiErrorMessage deliberately
 *  duck-types `problem` rather than instanceof-checking (its own header),
 *  so this is exactly the shape a real 403 produces. */
function forbiddenError(): Error {
  return Object.assign(new Error("Forbidden"), {
    problem: {
      type: "urn:loombre:problem:forbidden",
      title: "Forbidden",
      status: 403,
      detail: PERMISSION_DETAIL,
      code: "filesystem-permission-denied",
    },
  });
}

describe("DirectoryPicker", () => {
  let view: TestRender | null = null;
  const onClose = vi.fn();
  const onSelect = vi.fn();

  beforeEach(() => {
    apiGetMock.mockReset();
    onClose.mockReset();
    onSelect.mockReset();
    // SheetOrModal calls matchMedia unconditionally on every render —
    // jsdom has no real implementation.
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
    apiGetMock.mockImplementation((path: string, options?: { params?: { query?: { path?: string } } }) => {
      if (path !== "/admin/filesystem/directories") {
        return Promise.reject(new Error(`unexpected apiGet ${path}`));
      }
      const requested = options?.params?.query?.path;
      if (requested === undefined) return Promise.resolve(ROOTS);
      if (requested === "/Users") return Promise.resolve(USERS);
      if (requested === "/Users/ozzy") return Promise.reject(forbiddenError());
      return Promise.reject(new Error(`unexpected path ${requested}`));
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<DirectoryPicker open onClose={onClose} onSelect={onSelect} />);
    await act(async () => {});
  }

  function entryButton(name: string): HTMLButtonElement {
    const button = Array.from(view!.container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(name),
    );
    if (!button) throw new Error(`no entry button containing "${name}"`);
    return button as HTMLButtonElement;
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
    });
  }

  it("renders the server's 403 detail sentence — never the bare problem title", async () => {
    await render();
    await click(entryButton("/Users"));
    await click(entryButton("ozzy"));

    const text = view!.container.textContent ?? "";
    expect(text).toContain(PERMISSION_DETAIL);
    // The regression this file exists for: the picker once showed exactly
    // the word "Forbidden" and nothing else.
    expect(text).not.toContain("Forbidden");
  });

  it("keeps the last good listing visible under the error, so a sibling stays pickable", async () => {
    await render();
    await click(entryButton("/Users"));
    await click(entryButton("ozzy"));

    // /Users's entries survive the failed descent into ozzy.
    expect((view!.container.textContent ?? "").includes("Shared")).toBe(true);
  });

  it("marks unreadable entries instead of hiding them", async () => {
    await render();
    await click(entryButton("/Users"));

    expect(entryButton("ozzy").textContent).toContain("No access");
    expect(entryButton("Shared").textContent).not.toContain("No access");
  });

  it("still lets an unreadable entry be clicked — that is how the actionable 403 guidance surfaces", async () => {
    await render();
    await click(entryButton("/Users"));
    await click(entryButton("ozzy"));

    expect(apiGetMock).toHaveBeenCalledWith(
      "/admin/filesystem/directories",
      expect.objectContaining({ params: { query: { path: "/Users/ozzy" } } }),
    );
  });
});
