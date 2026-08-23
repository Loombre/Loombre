// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/UsersSection.test.tsx
//
// Lane D additions to this pre-existing file: RowMenu's new "Reset
// password" action opens ResetPasswordDialog with the right `isSelf`
// (compared against GET /users/me), and a null email (E4/M1) renders
// gracefully instead of a blank/undefined sub-line. InvitesPanel (also
// rendered by this component) is covered by its own test file — this file
// only asserts it mounts, not its internals.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { ToastProvider } from "../../ui/Toast.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPutMock = vi.fn();
const apiDeleteMock = vi.fn();

class FakeApiError extends Error {}

const EMAIL_CONFLICT_DETAIL = "A user with this email address already exists.";
const GRANT_CONFLICT_DETAIL = "That library was removed while this modal was open.";

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  apiPatch: (...args: unknown[]) => apiPatchMock(...args),
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  apiDelete: (...args: unknown[]) => apiDeleteMock(...args),
  LoombreApiError: FakeApiError,
}));

const { UsersSection } = await import("./UsersSection.js");

function installMatchMedia(): void {
  // InvitesPanel -> CreateInviteSheet -> SheetOrModal calls matchMedia
  // unconditionally on every render (see InvitesPanel.test.tsx's header).
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
}

const ADMIN = {
  id: "admin-1",
  username: "maya",
  email: "maya@example.com",
  displayName: "Maya Reyes",
  isAdmin: true,
  birthDate: null,
  maxContentRating: null,
  createdAtMs: 0,
  updatedAtMs: 0,
};

const NO_EMAIL_USER = {
  id: "user-2",
  username: "june",
  email: null,
  displayName: null,
  isAdmin: false,
  birthDate: null,
  maxContentRating: null,
  createdAtMs: 0,
  updatedAtMs: 0,
};

describe("UsersSection — Lane D additions", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
    apiPutMock.mockReset();
    apiDeleteMock.mockReset();
    installMatchMedia();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve({ items: [ADMIN, NO_EMAIL_USER], nextCursor: null });
      if (path === "/users/me") return Promise.resolve(ADMIN);
      if (path === "/invites") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  async function render(): Promise<void> {
    // AddUserSheet (rendered unconditionally, just `open={false}`) calls
    // useToast() — needs a real <ToastProvider> ancestor (the same one
    // AppProviders.tsx mounts at the root layout in production).
    view = renderIntoBody(
      <ToastProvider>
        <UsersSection heading={null} />
      </ToastProvider>,
    );
    await act(async () => {});
  }

  function rowMenuTriggers(): HTMLButtonElement[] {
    return Array.from(view!.container.querySelectorAll('button[aria-label^="Manage "]')) as HTMLButtonElement[];
  }

  async function click(el: HTMLElement): Promise<void> {
    await act(async () => {
      el.click();
    });
  }

  it("a user with no email on file renders a graceful fallback, not blank/undefined", async () => {
    await render();
    expect(view!.container.textContent).toContain("No email on file");
    expect(view!.container.textContent).not.toContain("undefined");
    expect(view!.container.textContent).not.toContain("null");
  });

  it("RowMenu offers Reset password, and it opens ResetPasswordDialog naming the user", async () => {
    await render();
    const trigger = rowMenuTriggers().find((b) => b.getAttribute("aria-label") === "Manage june")!;
    await click(trigger);

    const resetAction = Array.from(view!.container.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent ?? "").trim() === "Reset password",
    ) as HTMLButtonElement;
    expect(resetAction).toBeDefined();
    await click(resetAction);

    expect(view!.container.textContent).toContain("Reset password — june");
  });

  it("the self-reset case is detected via GET /users/me — the admin's own row shows the self warning", async () => {
    await render();
    const trigger = rowMenuTriggers().find((b) => b.getAttribute("aria-label") === "Manage maya")!;
    await click(trigger);
    const resetAction = Array.from(view!.container.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent ?? "").trim() === "Reset password",
    ) as HTMLButtonElement;
    await click(resetAction);

    expect(view!.container.textContent).toMatch(/your own account/i);
  });

  it("a non-self target gets no self-reset warning", async () => {
    await render();
    const trigger = rowMenuTriggers().find((b) => b.getAttribute("aria-label") === "Manage june")!;
    await click(trigger);
    const resetAction = Array.from(view!.container.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent ?? "").trim() === "Reset password",
    ) as HTMLButtonElement;
    await click(resetAction);

    expect(view!.container.textContent).not.toMatch(/your own account/i);
  });

  it("mounts the invites panel below the user list", async () => {
    await render();
    expect(view!.container.textContent).toContain("Invites");
    expect(view!.container.textContent).toContain("No invites yet");
  });

  it("LD-6 (owner QA, 2026-08-10): section heading reads 'Active Users', count intact", async () => {
    await render();
    const heading = view!.container.querySelector("h2");
    expect(heading?.textContent).toBe("Active Users · 2");
  });

  // browser-admin-F5: the modal used to render `err.message`, which the
  // SDK built from the RFC 9457 problem TITLE alone — an admin who typed a
  // taken address saw the literal word "Conflict" and nothing about which
  // field was wrong or why. The server's `detail` is the only actionable
  // half of the document, so it is what the surface must show.
  it("browser-admin-F5: EditUserModal renders the server's 409 detail sentence, never the bare problem title", async () => {
    apiPatchMock.mockRejectedValue(
      Object.assign(new FakeApiError("Conflict"), {
        problem: { type: "about:blank", title: "Conflict", status: 409, detail: EMAIL_CONFLICT_DETAIL },
      }),
    );
    await render();
    await click(rowMenuTriggers().find((b) => b.getAttribute("aria-label") === "Manage june")!);
    const editAction = Array.from(view!.container.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent ?? "").trim() === "Edit",
    ) as HTMLButtonElement;
    await click(editAction);

    const save = Array.from(view!.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    ) as HTMLButtonElement;
    await click(save);
    await act(async () => {});

    const text = view!.container.textContent ?? "";
    expect(text).toContain(EMAIL_CONFLICT_DETAIL);
    expect(text).not.toContain("Conflict");
  });

  it("browser-admin-F5: the library-access modal surfaces the detail of a failed grant too", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve({ items: [ADMIN, NO_EMAIL_USER], nextCursor: null });
      if (path === "/users/me") return Promise.resolve(ADMIN);
      if (path === "/invites") return Promise.resolve({ items: [], nextCursor: null });
      if (path === "/libraries")
        return Promise.resolve({
          items: [{ id: "lib-1", name: "Movies", mediaKind: "movie", contentClass: "general", paths: ["/mnt/movies"] }],
          nextCursor: null,
        });
      if (path === "/libraries/{id}/permissions") return Promise.resolve({ permissions: [] });
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    apiPutMock.mockRejectedValue(
      Object.assign(new FakeApiError("Conflict"), {
        problem: { title: "Conflict", status: 409, detail: GRANT_CONFLICT_DETAIL },
      }),
    );
    await render();
    await click(rowMenuTriggers().find((b) => b.getAttribute("aria-label") === "Manage june")!);
    const accessAction = Array.from(view!.container.querySelectorAll('[role="menuitem"]')).find((el) =>
      (el.textContent ?? "").trim().startsWith("Library access"),
    ) as HTMLButtonElement;
    await click(accessAction);
    await act(async () => {});

    const row = Array.from(view!.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").includes("Movies"),
    )!;
    await click(row.querySelector('input[type="checkbox"]') as HTMLInputElement);
    await act(async () => {});

    const text = view!.container.textContent ?? "";
    expect(text).toContain(GRANT_CONFLICT_DETAIL);
    expect(text).not.toContain("Conflict");
  });

  // browser-admin-F9: the shape that made this a P2 — the owner's real 4K
  // library and a seed fixture BOTH named "Movies". Granting the wrong one
  // was a coin flip; /settings/libraries already disambiguates by path.
  const DUPLICATE_NAME_LIBRARIES = [
    { id: "lib-real", name: "Movies", mediaKind: "movie", contentClass: "general", paths: ["/Users/ozzy/Desktop/Movies"] },
    { id: "lib-seed", name: "Movies", mediaKind: "movie", contentClass: "general", paths: ["/data/movies"] },
  ];

  function mockLibraries(items: unknown[]): void {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve({ items: [ADMIN, NO_EMAIL_USER], nextCursor: null });
      if (path === "/users/me") return Promise.resolve(ADMIN);
      if (path === "/invites") return Promise.resolve({ items: [], nextCursor: null });
      if (path === "/libraries") return Promise.resolve({ items, nextCursor: null });
      if (path === "/libraries/{id}/permissions") return Promise.resolve({ permissions: [] });
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
  }

  async function openLibraryAccess(): Promise<void> {
    await render();
    await click(rowMenuTriggers().find((b) => b.getAttribute("aria-label") === "Manage june")!);
    const accessAction = Array.from(view!.container.querySelectorAll('[role="menuitem"]')).find((el) =>
      (el.textContent ?? "").trim().startsWith("Library access"),
    ) as HTMLButtonElement;
    await click(accessAction);
    await act(async () => {});
  }

  it("browser-admin-F9: two libraries named 'Movies' are told apart by a library-path sub-line", async () => {
    mockLibraries(DUPLICATE_NAME_LIBRARIES);
    await openLibraryAccess();

    const rows = Array.from(view!.container.querySelectorAll("label")).filter((l) =>
      (l.textContent ?? "").includes("Movies"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("/Users/ozzy/Desktop/Movies");
    expect(rows[1]!.textContent).toContain("/data/movies");
    expect(rows[0]!.textContent).not.toBe(rows[1]!.textContent);
  });

  it("browser-admin-F9: a multi-path library lists every root, and a path-less row renders no junk sub-line", async () => {
    mockLibraries([
      { id: "lib-multi", name: "Movies", mediaKind: "movie", contentClass: "general", paths: ["/mnt/a", "/mnt/b"] },
      { id: "lib-none", name: "Shows", mediaKind: "tv", contentClass: "general", paths: [] },
    ]);
    await openLibraryAccess();

    const rows = Array.from(view!.container.querySelectorAll("label"));
    expect(rows.find((l) => (l.textContent ?? "").includes("Movies"))!.textContent).toContain("/mnt/a, /mnt/b");
    const none = rows.find((l) => (l.textContent ?? "").includes("Shows"))!;
    expect(none.textContent).not.toContain("undefined");
    expect(none.textContent).not.toContain("null");
  });
});
