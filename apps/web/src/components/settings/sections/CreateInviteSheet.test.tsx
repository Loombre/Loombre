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

const EXPIRY_DETAIL = "expiresInMs must be between 1 hour and 30 days.";

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

const NON_RESTRICTED_LIBRARY = {
  id: "lib-1",
  name: "Movies",
  mediaKind: "movie",
  contentClass: "general",
  paths: ["/mnt/movies"],
};
const RESTRICTED_LIBRARY = {
  id: "lib-2",
  name: "Adult",
  mediaKind: "movie",
  contentClass: "restricted",
  paths: ["/mnt/private"],
};

// browser-admin-F9: the real-world shape that made this finding a P2 —
// the owner's own 4K library and a seed fixture BOTH named "Movies".
const DUPLICATE_NAME_LIBRARIES = [
  { id: "lib-real", name: "Movies", mediaKind: "movie", contentClass: "general", paths: ["/Users/ozzy/Desktop/Movies"] },
  { id: "lib-seed", name: "Movies", mediaKind: "movie", contentClass: "general", paths: ["/data/movies"] },
];

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

  // browser-admin-F5: the sheet rendered `err.message`, built by the SDK
  // from the RFC 9457 problem TITLE alone, so a 422 read "Unprocessable
  // Entity" and the server's explanation was dropped on the floor.
  it("browser-admin-F5: renders the server's problem detail, never the bare status title", async () => {
    apiPostMock.mockRejectedValue(
      Object.assign(new FakeApiError("Unprocessable Entity"), {
        problem: { type: "about:blank", title: "Unprocessable Entity", status: 422, detail: EXPIRY_DETAIL },
      }),
    );
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={() => {}} />);
    await act(async () => {});

    await click(buttonFor("Create invite"));
    await act(async () => {});

    const text = view.container.textContent ?? "";
    expect(text).toContain(EXPIRY_DETAIL);
    expect(text).not.toContain("Unprocessable Entity");
  });

  // browser-admin-F9: an invite grant is unrevokable once claimed, so
  // picking the WRONG "Movies" here is not a recoverable mistake. The
  // /settings/libraries screen disambiguates with a path sub-line; this
  // grant surface must too.
  it("browser-admin-F9: two libraries named 'Movies' are told apart by a library-path sub-line", async () => {
    apiGetMock.mockResolvedValue({ items: DUPLICATE_NAME_LIBRARIES, nextCursor: null });
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={() => {}} />);
    await act(async () => {});

    const rows = Array.from(view.container.querySelectorAll("label")).filter((l) =>
      (l.textContent ?? "").includes("Movies"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("/Users/ozzy/Desktop/Movies");
    expect(rows[1]!.textContent).toContain("/data/movies");
    expect(rows[0]!.textContent).not.toBe(rows[1]!.textContent);
  });

  it("browser-admin-F9: a multi-path library lists every root, and no row renders an empty sub-line", async () => {
    apiGetMock.mockResolvedValue({
      items: [
        { id: "lib-multi", name: "Movies", mediaKind: "movie", contentClass: "general", paths: ["/mnt/a", "/mnt/b"] },
        { id: "lib-none", name: "Shows", mediaKind: "tv", contentClass: "general", paths: [] },
      ],
      nextCursor: null,
    });
    view = renderIntoBody(<CreateInviteSheet open onClose={() => {}} onCreated={() => {}} />);
    await act(async () => {});

    const multi = Array.from(view.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").includes("Movies"),
    )!;
    expect(multi.textContent).toContain("/mnt/a, /mnt/b");
    const none = Array.from(view.container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").includes("Shows"),
    )!;
    expect(none.textContent).not.toContain("undefined");
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
