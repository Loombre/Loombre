// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/libraries/StashPathMappingsPanel.test.tsx
//
// STATE.md FIX WAVE FX1: the path-mapping editor's add/remove/reorder
// rows + the debounced LIVE PREVIEW against the CANDIDATE (unsaved)
// mappings (K10). apiGet/apiPost/apiPut are mocked (LibrariesPanel.test.tsx's
// established convention); fake timers drive the debounce the same way
// app/admin/sessions/page.test.tsx already does for its own debounced
// refresh.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type AdminStashConnection = components["schemas"]["AdminStashConnection"];

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPutMock = vi.fn();

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
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  LoombreApiError: FakeApiError,
}));

const { StashPathMappingsPanel } = await import("./StashPathMappingsPanel.js");

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function connection(overrides: Partial<AdminStashConnection> = {}): AdminStashConnection {
  return {
    libraryId: "lib-1",
    configured: true,
    sqlitePath: "/data/stash.sqlite",
    enabled: true,
    genreTagNames: null,
    blobsPath: null,
    status: "ok",
    statusDetail: null,
    lastSeenSchemaVersion: 80,
    lastConnectedAtMs: 1,
    lastCheckedAtMs: 1,
    ...overrides,
  };
}

function rowInputs(container: HTMLElement, index: number): { stash: HTMLInputElement; loombre: HTMLInputElement } {
  const row = container.querySelectorAll("li")[index] as HTMLElement;
  const inputs = row.querySelectorAll("input");
  return { stash: inputs[0] as HTMLInputElement, loombre: inputs[1] as HTMLInputElement };
}

describe("StashPathMappingsPanel", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPutMock.mockReset();
    // Benign default so a preview call triggered incidentally by a test
    // that isn't itself asserting on the preview (e.g. the Save flow,
    // which re-triggers the debounced preview once the saved rows land
    // back in state) never throws on an unmocked resolution.
    apiPostMock.mockResolvedValue({ totalStashScenes: 0, candidateMatchCount: 0, unmatchedCount: 0, unmatchedScenes: [] });
    vi.useFakeTimers();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    vi.useRealTimers();
  });

  it('shows "No path mappings yet" when the saved table is empty', async () => {
    apiGetMock.mockResolvedValue({ mappings: [] });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(view.container.textContent).toContain("No path mappings yet.");
  });

  it("renders one row per saved mapping with both prefixes filled in", async () => {
    apiGetMock.mockResolvedValue({ mappings: [{ stashPrefix: "/data/scenes", loombrePrefix: "/media/movies" }] });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const { stash, loombre } = rowInputs(view.container, 0);
    expect(stash.value).toBe("/data/scenes");
    expect(loombre.value).toBe("/media/movies");
  });

  it("Add mapping appends an empty row and Save stays disabled until both fields are filled", async () => {
    apiGetMock.mockResolvedValue({ mappings: [] });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const addButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add mapping")) as HTMLButtonElement;
    act(() => addButton.click());

    const saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Save mappings")) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const { stash, loombre } = rowInputs(view.container, 0);
    act(() => setNativeValue(stash, "/data/scenes"));
    act(() => setNativeValue(loombre, "/media/movies"));

    expect(saveButton.disabled).toBe(false);
  });

  it("debounces the live preview: no POST until the debounce window elapses, then fires once with only complete rows", async () => {
    apiGetMock.mockResolvedValue({ mappings: [] });
    apiPostMock.mockResolvedValue({ totalStashScenes: 10, candidateMatchCount: 7, unmatchedCount: 3, unmatchedScenes: [] });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const addButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add mapping")) as HTMLButtonElement;
    act(() => addButton.click());
    const { stash, loombre } = rowInputs(view.container, 0);
    act(() => setNativeValue(stash, "/data/scenes"));
    act(() => setNativeValue(loombre, "/media/movies"));

    // Still inside the debounce window — no preview call yet.
    expect(apiPostMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith(
      "/admin/libraries/{id}/stash-path-mappings/preview",
      expect.objectContaining({ body: { mappings: [{ stashPrefix: "/data/scenes", loombrePrefix: "/media/movies" }] } }),
    );
    expect(view.container.textContent).toContain("7 of 10 files matched");
  });

  it("never fires the preview for an incomplete row (only one prefix filled)", async () => {
    apiGetMock.mockResolvedValue({ mappings: [] });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const addButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add mapping")) as HTMLButtonElement;
    act(() => addButton.click());
    const { stash } = rowInputs(view.container, 0);
    act(() => setNativeValue(stash, "/data/scenes"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(apiPostMock).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Add at least one complete mapping to preview matches.");
  });

  it("Remove drops the targeted row", async () => {
    apiGetMock.mockResolvedValue({
      mappings: [
        { stashPrefix: "/a", loombrePrefix: "/1" },
        { stashPrefix: "/b", loombrePrefix: "/2" },
      ],
    });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const removeButtons = Array.from(view.container.querySelectorAll('button[title="Remove"]'));
    act(() => (removeButtons[0] as HTMLButtonElement).click());

    expect(rowInputs(view.container, 0).stash.value).toBe("/b");
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
  });

  it("reorders rows with the down button", async () => {
    apiGetMock.mockResolvedValue({
      mappings: [
        { stashPrefix: "/a", loombrePrefix: "/1" },
        { stashPrefix: "/b", loombrePrefix: "/2" },
      ],
    });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const moveDownButtons = Array.from(view.container.querySelectorAll('button[title="Move down"]'));
    act(() => (moveDownButtons[0] as HTMLButtonElement).click());

    expect(rowInputs(view.container, 0).stash.value).toBe("/b");
    expect(rowInputs(view.container, 1).stash.value).toBe("/a");
  });

  it("Save PUTs the wholesale table and reflects the response", async () => {
    apiGetMock.mockResolvedValue({ mappings: [{ stashPrefix: "/a", loombrePrefix: "/1" }] });
    apiPutMock.mockResolvedValue({ mappings: [{ stashPrefix: "/a", loombrePrefix: "/1-renamed" }] });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection()} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const { loombre } = rowInputs(view.container, 0);
    act(() => setNativeValue(loombre, "/1-renamed"));

    const saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Save mappings")) as HTMLButtonElement;
    await act(async () => {
      saveButton.click();
      await vi.runOnlyPendingTimersAsync();
    });

    expect(apiPutMock).toHaveBeenCalledWith(
      "/admin/libraries/{id}/stash-path-mappings",
      expect.objectContaining({ body: { mappings: [{ stashPrefix: "/a", loombrePrefix: "/1-renamed" }] } }),
    );
    expect(rowInputs(view.container, 0).loombre.value).toBe("/1-renamed");
  });

  it("shows the not-configured note when the library has no Stash connection yet", async () => {
    apiGetMock.mockResolvedValue({ mappings: [] });
    view = renderIntoBody(<StashPathMappingsPanel libraryId="lib-1" connection={connection({ configured: false })} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(view.container.textContent).toContain("This library has no Stash connection configured yet");
  });
});
