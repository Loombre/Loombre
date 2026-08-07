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

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";
import { ToastProvider } from "../../ui/Toast.js";

const apiPostMock = vi.fn();
const apiGetMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../../lib/api-client.js", () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  apiGet: (...args: unknown[]) => apiGetMock(...args),
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

describe("AddLibrarySheet — Kind control (D-3 label-casing)", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
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

  function tablist(): HTMLElement {
    return view!.container.querySelector('[role="tablist"]') as HTMLElement;
  }

  function kindSegments(): HTMLButtonElement[] {
    return Array.from(tablist().querySelectorAll('button[role="tab"]'));
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
