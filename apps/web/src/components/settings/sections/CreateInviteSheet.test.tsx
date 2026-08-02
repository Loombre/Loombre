// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/settings/sections/CreateInviteSheet.test.tsx
//
// E2: create -> reveal -> copy. apiGet/apiPost mocked, module imported
// AFTER mocks (house convention — AccountSection.test.tsx). desktop dialog
// branch (installMatchMedia(false), SheetOrModal.test.tsx's own pattern)
// so the DOM shape is the simpler, non-sheet one.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  LoombreApiError: FakeApiError,
}));

const { CreateInviteSheet } = await import("./CreateInviteSheet.js");

type Listener = (event: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean): void {
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return initialMatches;
      },
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })),
  );
}

const NON_RESTRICTED_LIBRARY = { id: "lib-1", name: "Movies", mediaKind: "movie", contentClass: "general" };
const RESTRICTED_LIBRARY = { id: "lib-2", name: "Adult", mediaKind: "movie", contentClass: "restricted" };

const CREATED_INVITE = {
  id: "inv-1",
  createdByUserId: "admin-1",
  createdAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_259_200_000,
  usernamePreset: null,
  displayNamePreset: null,
  email: null,
  libraryIds: ["lib-1"],
  status: "pending",
  claimedByUserId: null,
  claimedAtMs: null,
  revokedAtMs: null,
};

describe("CreateInviteSheet — E2 create -> reveal -> copy", () => {
  let view: TestRender | null = null;
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    installMatchMedia(false);
    apiGetMock.mockResolvedValue({ items: [NON_RESTRICTED_LIBRARY, RESTRICTED_LIBRARY], nextCursor: null });
    Object.assign(navigator, { clipboard: { writeText } });
    writeText.mockClear();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

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

  it("only offers NON-restricted libraries — E2/M4, the server rejects a restricted grant anyway", async () => {
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={() => {}} />);
    await act(async () => {});
    expect(view.container.textContent).toContain("Movies");
    expect(view.container.textContent).not.toContain("Adult");
  });

  it("creates an invite, reveals the claimUrl (server-provided), and copies it", async () => {
    const onCreated = vi.fn();
    apiPostMock.mockResolvedValue({ invite: CREATED_INVITE, claimToken: "raw-token-abc", claimUrl: "https://loombre.example.com/claim/raw-token-abc" });
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={onCreated} />);
    await act(async () => {});

    await click(buttonFor("Create invite"));

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiPostMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/invites");
    expect(options.body["libraryIds"]).toEqual([]);
    expect(onCreated).toHaveBeenCalledWith(CREATED_INVITE);

    // Reveal step: the server-provided claimUrl, not the fallback.
    expect(view.container.textContent).toContain("https://loombre.example.com/claim/raw-token-abc");
    expect(view.container.textContent).toMatch(/will not be shown again/i);

    const copyButton = view.container.querySelector('button[title="Copy"]') as HTMLButtonElement;
    await click(copyButton);
    expect(writeText).toHaveBeenCalledWith("https://loombre.example.com/claim/raw-token-abc");
  });

  it("falls back to window.location.origin + /claim/<token> when claimUrl is null (M9)", async () => {
    apiPostMock.mockResolvedValue({ invite: CREATED_INVITE, claimToken: "raw-token-xyz", claimUrl: null });
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={() => {}} />);
    await act(async () => {});

    await click(buttonFor("Create invite"));

    expect(view.container.textContent).toContain(`${window.location.origin}/claim/raw-token-xyz`);
  });

  it("omits blank preset fields entirely rather than sending empty strings", async () => {
    apiPostMock.mockResolvedValue({ invite: CREATED_INVITE, claimToken: "t", claimUrl: null });
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={() => {}} />);
    await act(async () => {});

    await click(buttonFor("Create invite"));

    const [, options] = apiPostMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body).not.toHaveProperty("username");
    expect(options.body).not.toHaveProperty("displayName");
    expect(options.body).not.toHaveProperty("email");
    // Default expiry (72h) is always sent.
    expect(options.body["expiresInMs"]).toBe(259_200_000);
  });

  it("selecting a library includes it in libraryIds", async () => {
    apiPostMock.mockResolvedValue({ invite: CREATED_INVITE, claimToken: "t", claimUrl: null });
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={() => {}} />);
    await act(async () => {});

    const checkbox = view.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    await click(buttonFor("Create invite"));

    const [, options] = apiPostMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body["libraryIds"]).toEqual(["lib-1"]);
  });

  it("surfaces a server error inline and stays on the form", async () => {
    apiPostMock.mockRejectedValue(new FakeApiError("Invalid library id."));
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={() => {}} />);
    await act(async () => {});

    await click(buttonFor("Create invite"));

    expect(view.container.textContent).toContain("Invalid library id.");
    expect(view.container.querySelector('input[type="checkbox"]')).not.toBeNull();
  });
});
