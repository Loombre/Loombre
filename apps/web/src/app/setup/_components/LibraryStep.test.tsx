// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/app/setup/_components/LibraryStep.test.tsx
//
// The wizard's library step used to claim "there is no folder-browse
// button yet" — written when the only imagined picker was a native OS one
// via the controller apps (the P4.6 deviation). That rationale went stale
// the day the server-enumeration DirectoryPicker landed for Settings >
// Library: the wizard is a fully authenticated admin by this step
// (AdminStep applies the first-admin TokenPair to the auth store), so the
// admin-only browse endpoint works here unchanged. These tests pin the
// re-wiring: Browse… opens the shared DirectoryPicker and a picked path
// lands in the form, while manual entry stays fully functional.
//
// apiGet/apiPost are mocked and the module under test imported afterwards
// — the established convention here (RestrictedStep.test.tsx).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../../components/ui/test-render.js";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock("../../../lib/api-client.js", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
}));

const { LibraryStep } = await import("./LibraryStep.js");

const ROOTS = {
  path: null,
  parent: null,
  entries: [{ name: "/Volumes", path: "/Volumes", readable: true }],
};

const VOLUMES = {
  path: "/Volumes",
  parent: "/",
  entries: [{ name: "Media", path: "/Volumes/Media", readable: true }],
};

describe("LibraryStep — folder browsing (the stale 'no browser yet' claim, reversed)", () => {
  let view: TestRender | null = null;
  const onNext = vi.fn();

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    onNext.mockReset();
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
      if (requested === "/Volumes") return Promise.resolve(VOLUMES);
      return Promise.reject(new Error(`unexpected path ${requested}`));
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.unstubAllGlobals();
  });

  async function render(): Promise<void> {
    view = renderIntoBody(<LibraryStep onNext={onNext} />);
    await act(async () => {});
  }

  function buttonContaining(text: string): HTMLButtonElement {
    const button = Array.from(view!.container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(text),
    );
    if (!button) throw new Error(`no button containing "${text}"`);
    return button as HTMLButtonElement;
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click();
    });
  }

  function pathInputs(): HTMLInputElement[] {
    return Array.from(view!.container.querySelectorAll('input[aria-label^="Library path"]'));
  }

  function setNativeValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Walk the picker: open → descend into /Volumes → choose it. */
  async function pickVolumes(): Promise<void> {
    await click(buttonContaining("Browse…"));
    await click(buttonContaining("/Volumes"));
    await click(buttonContaining("Use this folder"));
  }

  it("no longer claims a folder browser doesn't exist", async () => {
    await render();
    expect(view!.container.textContent ?? "").not.toContain("no folder-browse button");
  });

  it("Browse… opens the shared DirectoryPicker at the server's roots", async () => {
    await render();
    await click(buttonContaining("Browse…"));

    expect(view!.container.textContent ?? "").toContain("Choose a folder");
    expect(apiGetMock).toHaveBeenCalledWith("/admin/filesystem/directories", undefined);
  });

  it("a picked folder fills the first empty path field", async () => {
    await render();
    await pickVolumes();

    expect(pathInputs().map((i) => i.value)).toEqual(["/Volumes"]);
  });

  it("a picked folder appends a new row when every field is taken — and never duplicates", async () => {
    await render();
    setNativeValue(pathInputs()[0]!, "/existing/media");
    await pickVolumes();
    expect(pathInputs().map((i) => i.value)).toEqual(["/existing/media", "/Volumes"]);

    // Picking the same folder again must not add a second copy — the
    // scanner would walk it twice for nothing (AddLibrarySheet's rule).
    await pickVolumes();
    expect(pathInputs().map((i) => i.value)).toEqual(["/existing/media", "/Volumes"]);
  });
});
