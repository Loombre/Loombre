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
});
