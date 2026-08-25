// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/InvitesPanel.test.tsx
//
// E2: list rendering (status chips) + per-row revoke's inline danger
// confirm. CreateInviteSheet's own create/reveal flow is covered in its
// own test file; this file mocks apiGet/apiDelete only (apiPost is unused
// by this component directly, but CreateInviteSheet — rendered inside —
// needs it too, so it's included in the mock for completeness even though
// no test here drives it).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();

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
  apiDelete: (...args: unknown[]) => apiDeleteMock(...args),
  LoombreApiError: FakeApiError,
}));

const { InvitesPanel } = await import("./InvitesPanel.js");

// CreateInviteSheet (rendered unconditionally inside InvitesPanel, just
// `open={false}` until "+ Create invite" is clicked) uses SheetOrModal,
// whose useMediaQuery hook calls window.matchMedia on EVERY render
// regardless of `open` — jsdom has no matchMedia implementation at all
// (SheetOrModal.test.tsx's own header note), so every test below needs
// this stub even though none of them actually open the create sheet.
type Listener = (event: { matches: boolean }) => void;
function installMatchMedia(): void {
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })),
  );
}

function invite(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "inv-1",
    createdByUserId: "admin-1",
    createdAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_259_200_000,
    usernamePreset: "newperson",
    displayNamePreset: null,
    email: null,
    libraryIds: [],
    status: "pending",
    claimedByUserId: null,
    claimedAtMs: null,
    revokedAtMs: null,
    ...overrides,
  };
}

describe("InvitesPanel — E2 list + revoke", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiDeleteMock.mockReset();
    installMatchMedia();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<InvitesPanel />);
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

  it("shows an empty state when there are no invites", async () => {
    apiGetMock.mockResolvedValue({ items: [], nextCursor: null });
    await render();
    expect(view!.container.textContent).toMatch(/No invites yet/);
  });

  it("renders every status (pending/claimed/revoked/expired) — all are shown, not just pending", async () => {
    apiGetMock.mockResolvedValue({
      items: [
        invite({ id: "a", status: "pending" }),
        invite({ id: "b", status: "claimed", usernamePreset: "claimed-user" }),
        invite({ id: "c", status: "revoked", usernamePreset: "revoked-user" }),
        invite({ id: "d", status: "expired", usernamePreset: "expired-user" }),
      ],
      nextCursor: null,
    });
    await render();

    expect(view!.container.textContent).toContain("Pending");
    expect(view!.container.textContent).toContain("Claimed");
    expect(view!.container.textContent).toContain("Revoked");
    expect(view!.container.textContent).toContain("Expired");
    expect(view!.container.textContent).toContain("· 4");
  });

  it("only a pending invite offers Revoke", async () => {
    apiGetMock.mockResolvedValue({
      items: [invite({ id: "a", status: "pending" }), invite({ id: "b", status: "claimed", usernamePreset: "someone-else" })],
      nextCursor: null,
    });
    await render();

    const revokeButtons = Array.from(view!.container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === "Revoke",
    );
    expect(revokeButtons.length).toBe(1);
  });

  it("Revoke opens a danger-tinted inline confirm naming the invite, not an immediate delete", async () => {
    apiGetMock.mockResolvedValue({ items: [invite()], nextCursor: null });
    await render();

    await click(buttonFor("Revoke"));

    expect(apiDeleteMock).not.toHaveBeenCalled();
    expect(view!.container.textContent).toMatch(/Revoke the invite for newperson\? This cannot be undone\./);
  });

  it("Cancel from the confirm step does not revoke", async () => {
    apiGetMock.mockResolvedValue({ items: [invite()], nextCursor: null });
    await render();

    await click(buttonFor("Revoke"));
    await click(buttonFor("Cancel"));

    expect(apiDeleteMock).not.toHaveBeenCalled();
    expect(view!.container.textContent).not.toMatch(/cannot be undone/);
  });

  it("confirming revoke calls DELETE /invites/{id} and updates the row to revoked", async () => {
    apiGetMock.mockResolvedValue({ items: [invite()], nextCursor: null });
    apiDeleteMock.mockResolvedValue(undefined);
    await render();

    await click(buttonFor("Revoke"));
    const confirmButtons = Array.from(view!.container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === "Revoke",
    );
    await click(confirmButtons[0]!);

    expect(apiDeleteMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiDeleteMock.mock.calls[0] as [string, { params: { path: { id: string } } }];
    expect(path).toBe("/invites/{id}");
    expect(options.params.path.id).toBe("inv-1");

    expect(view!.container.textContent).toContain("Revoked");
    expect(view!.container.querySelector('button')?.textContent).not.toBe("Revoke");
  });

  it("a failed revoke shows an error and returns to the confirm step, not silently dropped", async () => {
    apiGetMock.mockResolvedValue({ items: [invite()], nextCursor: null });
    apiDeleteMock.mockRejectedValue(new FakeApiError("Invite already claimed."));
    await render();

    await click(buttonFor("Revoke"));
    const confirmButtons = Array.from(view!.container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === "Revoke",
    );
    await click(confirmButtons[0]!);

    expect(view!.container.textContent).toContain("Invite already claimed.");
  });
});
