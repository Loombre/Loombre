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

/** Duck-typed LoombreApiError stand-in: apiErrorMessage (and the picker's
 *  own parseRemediation) deliberately duck-type `problem` rather than
 *  instanceof-checking (apiErrorMessage's own header), so this is exactly
 *  the shape a real 403 produces. `remediation` is optional — omitted
 *  reproduces the Linux/dev 403 (no scripted grant recipe), matching every
 *  pre-existing test in this file; callers that want the macOS grant-flow
 *  case pass it explicitly. */
function forbiddenError(remediation?: {
  summary: string;
  commands: string[];
  verify: string;
  note?: string;
  nativeGrantUrl?: string;
}): Error {
  return Object.assign(new Error("Forbidden"), {
    problem: {
      type: "urn:loombre:problem:forbidden",
      title: "Forbidden",
      status: 403,
      detail: PERMISSION_DETAIL,
      code: "filesystem-permission-denied",
      ...(remediation !== undefined ? { remediation } : {}),
    },
  });
}

const REMEDIATION = {
  summary: "Loombre's service account (_loombre) can't read this folder.",
  commands: [
    'chmod +a "user:_loombre allow search" /Users/ozzy',
    'chmod -R +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/ozzy/Media',
  ],
  verify: "sudo -u _loombre ls /Users/ozzy/Media",
};

// The server's step 1 for a bare personal home: a names-only listing grant
// (admin-directories.ts permissionRemediation) — the case the picker's
// most likely path (roots -> /Users -> click your username) produces.
const HOME_STEP_1 = {
  summary: "Loombre's service account (_loombre) can't list this home folder.",
  commands: ['chmod +a "user:_loombre allow list,search" /Users/ozzy'],
  verify: "sudo -u _loombre ls /Users/ozzy",
  note: "This reveals only the names of the folders directly inside your home — nothing inside them.",
  nativeGrantUrl: "loombre://grant?v=1&scope=names-only&path=%2FUsers%2Fozzy",
};

// Step 2, once the home is listable: the media folder's own read grant.
const HOME_STEP_2 = {
  summary: "Loombre's service account (_loombre) can't read this folder.",
  commands: [
    'chmod -R +a "user:_loombre allow read,execute,readattr,readextattr,list,search,file_inherit,directory_inherit" /Users/ozzy/Movies',
  ],
  verify: "sudo -u _loombre ls /Users/ozzy/Movies",
  note: "Read access on this folder and everything added to it later — nothing else in your home folder.",
};

const HOME = {
  path: "/Users/ozzy",
  parent: "/Users",
  entries: [
    { name: "Media", path: "/Users/ozzy/Media", readable: true },
    { name: "Movies", path: "/Users/ozzy/Movies", readable: false },
  ],
};

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

  // ── The second rc.6 field screenshot: the 403 `detail` was correct but
  //    still a wall of text with nothing to click. When the server attaches
  //    a `remediation` extension member (macOS + _loombre), the picker
  //    should replace the paragraph with an actionable grant panel; when it
  //    doesn't (Linux/dev, or a malformed shape), every test above this one
  //    must keep passing UNCHANGED. ──
  describe("filesystem-permission-denied remediation grant flow", () => {
    function withDeniedResponse(rejection: Error): void {
      apiGetMock.mockImplementation((path: string, options?: { params?: { query?: { path?: string } } }) => {
        if (path !== "/admin/filesystem/directories") {
          return Promise.reject(new Error(`unexpected apiGet ${path}`));
        }
        const requested = options?.params?.query?.path;
        if (requested === undefined) return Promise.resolve(ROOTS);
        if (requested === "/Users") return Promise.resolve(USERS);
        if (requested === "/Users/ozzy") return Promise.reject(rejection);
        return Promise.reject(new Error(`unexpected path ${requested}`));
      });
    }

    function checkAgainButton(): HTMLButtonElement {
      const button = Array.from(view!.container.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").trim() === "Check again",
      );
      if (!button) throw new Error('no "Check again" button');
      return button as HTMLButtonElement;
    }

    it("renders the summary and both commands, and 'Check again' re-lists the exact same denied path", async () => {
      withDeniedResponse(forbiddenError(REMEDIATION));
      await render();
      await click(entryButton("/Users"));
      await click(entryButton("ozzy"));

      const text = view!.container.textContent ?? "";
      expect(text).toContain(REMEDIATION.summary);
      expect(text).toContain(REMEDIATION.commands[0]);
      expect(text).toContain(REMEDIATION.commands[1]);
      // finding 6: `verify` is required by the contract and validated, but
      // was never rendered — the grant panel must show it too.
      expect(text).toContain(REMEDIATION.verify);
      // The bare detail paragraph is REPLACED, not supplemented.
      expect(text).not.toContain(PERMISSION_DETAIL);

      apiGetMock.mockClear();
      await click(checkAgainButton());

      expect(apiGetMock).toHaveBeenCalledTimes(1);
      expect(apiGetMock).toHaveBeenCalledWith(
        "/admin/filesystem/directories",
        expect.objectContaining({ params: { query: { path: "/Users/ozzy" } } }),
      );
    });

    it("renders the scope note when the server sends one, and nothing extra when it doesn't", async () => {
      withDeniedResponse(forbiddenError(HOME_STEP_1));
      await render();
      await click(entryButton("/Users"));
      await click(entryButton("ozzy"));

      const text = view!.container.textContent ?? "";
      expect(text).toContain(HOME_STEP_1.summary);
      expect(text).toContain(HOME_STEP_1.note);
      expect(text).toContain(HOME_STEP_1.commands[0]);
    });

    // ── The two-step home-folder flow end to end, as the picker sees it:
    //    step 1's names-only grant is run out of band, "Check again" turns
    //    the 403 into a real listing of the home (panel gone, entries
    //    visible, 700 subfolders still marked), and clicking the media
    //    folder surfaces step 2's targeted grant. ──
    it("after 'Check again' succeeds, replaces the grant panel with the listing and lets step 2 surface", async () => {
      let homeGranted = false;
      apiGetMock.mockImplementation((path: string, options?: { params?: { query?: { path?: string } } }) => {
        if (path !== "/admin/filesystem/directories") {
          return Promise.reject(new Error(`unexpected apiGet ${path}`));
        }
        const requested = options?.params?.query?.path;
        if (requested === undefined) return Promise.resolve(ROOTS);
        if (requested === "/Users") return Promise.resolve(USERS);
        if (requested === "/Users/ozzy") {
          return homeGranted ? Promise.resolve(HOME) : Promise.reject(forbiddenError(HOME_STEP_1));
        }
        if (requested === "/Users/ozzy/Movies") return Promise.reject(forbiddenError(HOME_STEP_2));
        return Promise.reject(new Error(`unexpected path ${requested}`));
      });
      await render();
      await click(entryButton("/Users"));
      await click(entryButton("ozzy"));
      expect(view!.container.textContent ?? "").toContain(HOME_STEP_1.commands[0]);

      // The operator runs step 1 in Terminal, then clicks "Check again".
      homeGranted = true;
      await click(checkAgainButton());

      const afterStep1 = view!.container.textContent ?? "";
      expect(afterStep1).not.toContain(HOME_STEP_1.commands[0]);
      expect(afterStep1).not.toContain("Check again");
      expect(afterStep1).toContain("/Users/ozzy");
      expect(entryButton("Media").textContent).not.toContain("No access");
      expect(entryButton("Movies").textContent).toContain("No access");

      await click(entryButton("Movies"));
      const afterStep2 = view!.container.textContent ?? "";
      expect(afterStep2).toContain(HOME_STEP_2.commands[0]);
      expect(afterStep2).toContain(HOME_STEP_2.note);
      // Step 1's command is not repeated — the home is already traversable.
      expect(afterStep2).not.toContain("allow search");
      expect(afterStep2).not.toContain("allow list,search");
    });

    // ── The no-Terminal path: nativeGrantUrl hands the grant to the macOS
    //    menubar app. The picker must (1) open it on click, (2) keep the
    //    panel up while it quietly re-checks, (3) swap to the listing the
    //    moment the grant lands, and (4) show nothing of this on Linux,
    //    where the commands are the whole recipe. ──
    describe("native grant handoff (nativeGrantUrl)", () => {
      function allowButton(): HTMLButtonElement | undefined {
        return Array.from(view!.container.querySelectorAll("button")).find((b) =>
          (b.textContent ?? "").startsWith("Allow in Loombre"),
        ) as HTMLButtonElement | undefined;
      }

      it("renders no native button when the server sends no nativeGrantUrl", async () => {
        withDeniedResponse(forbiddenError(HOME_STEP_2));
        await render();
        await click(entryButton("/Users"));
        await click(entryButton("ozzy"));
        expect(allowButton()).toBeUndefined();
        expect(view!.container.textContent ?? "").toContain("Run this in Terminal");
      });

      it("drops a nativeGrantUrl that is not a loombre:// URL, keeping the commands", async () => {
        withDeniedResponse(forbiddenError({ ...HOME_STEP_1, nativeGrantUrl: "javascript:alert(1)" }));
        await render();
        await click(entryButton("/Users"));
        await click(entryButton("ozzy"));
        expect(allowButton()).toBeUndefined();
        expect(view!.container.textContent ?? "").toContain(HOME_STEP_1.commands[0]);
      });

      it("opens the URL on click, re-checks quietly on a timer with the panel still up, then shows the listing", async () => {
        vi.useFakeTimers();
        try {
          let homeGranted = false;
          apiGetMock.mockImplementation((path: string, options?: { params?: { query?: { path?: string } } }) => {
            if (path !== "/admin/filesystem/directories") {
              return Promise.reject(new Error(`unexpected apiGet ${path}`));
            }
            const requested = options?.params?.query?.path;
            if (requested === undefined) return Promise.resolve(ROOTS);
            if (requested === "/Users") return Promise.resolve(USERS);
            if (requested === "/Users/ozzy") {
              return homeGranted ? Promise.resolve(HOME) : Promise.reject(forbiddenError(HOME_STEP_1));
            }
            return Promise.reject(new Error(`unexpected path ${requested}`));
          });
          const openExternal = vi.fn();
          view = renderIntoBody(<DirectoryPicker open onClose={onClose} onSelect={onSelect} openExternal={openExternal} />);
          await act(async () => {});
          await click(entryButton("/Users"));
          await click(entryButton("ozzy"));

          const button = allowButton();
          expect(button).toBeDefined();
          expect(view!.container.textContent ?? "").toContain("Or run this in Terminal");
          await click(button!);
          expect(openExternal).toHaveBeenCalledWith(HOME_STEP_1.nativeGrantUrl);
          expect(view!.container.textContent ?? "").toContain("re-checking automatically");

          // First tick: still denied — the panel (and its command) must
          // stay on screen, not blink to a skeleton.
          apiGetMock.mockClear();
          await act(async () => {
            vi.advanceTimersByTime(1500);
          });
          expect(apiGetMock).toHaveBeenCalledWith(
            "/admin/filesystem/directories",
            expect.objectContaining({ params: { query: { path: "/Users/ozzy" } } }),
          );
          expect(view!.container.textContent ?? "").toContain(HOME_STEP_1.commands[0]);

          // The user clicked Allow in the native dialog: next tick lists.
          homeGranted = true;
          await act(async () => {
            vi.advanceTimersByTime(1500);
          });
          const text = view!.container.textContent ?? "";
          expect(text).not.toContain(HOME_STEP_1.commands[0]);
          expect(text).not.toContain("re-checking automatically");
          expect(entryButton("Movies").textContent).toContain("No access");
          expect(entryButton("Media").textContent).not.toContain("No access");

          // And the timer is gone: no further browse calls.
          apiGetMock.mockClear();
          await act(async () => {
            vi.advanceTimersByTime(6000);
          });
          expect(apiGetMock).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("falls back to the plain detail paragraph when remediation is absent (Linux/dev)", async () => {
      withDeniedResponse(forbiddenError());
      await render();
      await click(entryButton("/Users"));
      await click(entryButton("ozzy"));

      const text = view!.container.textContent ?? "";
      expect(text).toContain(PERMISSION_DETAIL);
      expect(text).not.toContain("Check again");
    });

    it("falls back to the plain detail paragraph when remediation is malformed (commands not an array)", async () => {
      const malformed = Object.assign(new Error("Forbidden"), {
        problem: {
          type: "urn:loombre:problem:forbidden",
          title: "Forbidden",
          status: 403,
          detail: PERMISSION_DETAIL,
          code: "filesystem-permission-denied",
          remediation: { summary: "x", commands: "not-an-array", verify: "y" },
        },
      });
      withDeniedResponse(malformed);
      await render();
      await click(entryButton("/Users"));
      await click(entryButton("ozzy"));

      const text = view!.container.textContent ?? "";
      expect(text).toContain(PERMISSION_DETAIL);
      expect(text).not.toContain("Check again");
    });
  });
});
