// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/libraries/StashConnectionPanel.test.tsx
//
// STATE.md FIX WAVE FX1: the connection editor's tri-state genreTagNames
// contract (K15 — omit=untouched/null=reset/array=replace) and the
// honest-empty-state ("no connection configured yet") + verbatim
// statusDetail (S3's exact admin notice) requirements. apiPut is mocked
// (LibrariesPanel.test.tsx's established apiGet/apiPost-mocking
// convention, extended to apiPut) so this exercises the real component
// against a fake network boundary only.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type AdminStashConnection = components["schemas"]["AdminStashConnection"];

const apiPutMock = vi.fn();

class FakeApiError extends Error {}

vi.mock("../../../lib/api-client.js", () => ({
  apiPut: (...args: unknown[]) => apiPutMock(...args),
  LoombreApiError: FakeApiError,
}));

const { StashConnectionPanel } = await import("./StashConnectionPanel.js");

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function unconfiguredConnection(): AdminStashConnection {
  return {
    libraryId: "lib-1",
    configured: false,
    sqlitePath: null,
    enabled: false,
    genreTagNames: null,
    blobsPath: null,
    status: "never_connected",
    statusDetail: null,
    lastSeenSchemaVersion: null,
    lastConnectedAtMs: null,
    lastCheckedAtMs: null,
  };
}

describe("StashConnectionPanel", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiPutMock.mockReset();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it('shows the "no connection yet" note when configured is false', () => {
    view = renderIntoBody(<StashConnectionPanel connection={unconfiguredConnection()} onSaved={() => {}} />);
    expect(view.container.textContent).toContain("This library has no Stash connection yet");
  });

  it("renders the status pill label for each known status", () => {
    view = renderIntoBody(
      <StashConnectionPanel connection={{ ...unconfiguredConnection(), configured: true, status: "unreachable" }} onSaved={() => {}} />,
    );
    expect(view.container.textContent).toContain("Unreachable");
  });

  it("renders statusDetail verbatim when status is unsupported_schema", () => {
    view = renderIntoBody(
      <StashConnectionPanel
        connection={{
          ...unconfiguredConnection(),
          configured: true,
          status: "unsupported_schema",
          statusDetail: "Stash schema v99 unsupported; supported: 67-85",
        }}
        onSaved={() => {}}
      />,
    );
    expect(view.container.textContent).toContain("Stash schema v99 unsupported; supported: 67-85");
  });

  it("renders — for null lastConnectedAtMs/lastCheckedAtMs rather than a fabricated date", () => {
    view = renderIntoBody(<StashConnectionPanel connection={unconfiguredConnection()} onSaved={() => {}} />);
    const dds = Array.from(view.container.querySelectorAll("dd")).map((dd) => dd.textContent);
    expect(dds).toEqual(["—", "—", "—"]);
  });

  it("defaults the genre control to Default (automatic) when genreTagNames is null", () => {
    view = renderIntoBody(<StashConnectionPanel connection={unconfiguredConnection()} onSaved={() => {}} />);
    expect(view.container.textContent).toContain("built-in heuristic");
    expect(view.container.querySelector("textarea")).toBeNull();
  });

  it("defaults the genre control to Custom list and shows the saved names when genreTagNames is an array", () => {
    view = renderIntoBody(
      <StashConnectionPanel connection={{ ...unconfiguredConnection(), configured: true, genreTagNames: ["Thriller", "Western"] }} onSaved={() => {}} />,
    );
    const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe("Thriller\nWestern");
  });

  it("Save is disabled until sqlitePath is non-empty", () => {
    view = renderIntoBody(<StashConnectionPanel connection={unconfiguredConnection()} onSaved={() => {}} />);
    const saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it('saving with "Default (automatic)" selected sends genreTagNames: null explicitly', async () => {
    apiPutMock.mockResolvedValue({ ...unconfiguredConnection(), configured: true, sqlitePath: "/data/stash.sqlite" });
    view = renderIntoBody(<StashConnectionPanel connection={unconfiguredConnection()} onSaved={() => {}} />);

    const pathInput = view.container.querySelector('input[type="text"], input:not([type])') as HTMLInputElement;
    act(() => setNativeValue(pathInput, "/data/stash.sqlite"));

    const saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
    await act(async () => saveButton.click());

    expect(apiPutMock).toHaveBeenCalledWith(
      "/admin/libraries/{id}/stash-connection",
      expect.objectContaining({ body: expect.objectContaining({ sqlitePath: "/data/stash.sqlite", genreTagNames: null }) }),
    );
  });

  it('switching to "Custom list" and typing names sends the parsed array wholesale (empty lines dropped)', async () => {
    apiPutMock.mockResolvedValue({ ...unconfiguredConnection(), configured: true, sqlitePath: "/data/stash.sqlite" });
    view = renderIntoBody(<StashConnectionPanel connection={{ ...unconfiguredConnection(), sqlitePath: "/data/stash.sqlite" }} onSaved={() => {}} />);

    const customTab = Array.from(view.container.querySelectorAll('[role="radio"]')).find((t) => t.textContent === "Custom list") as HTMLButtonElement;
    act(() => customTab.click());

    const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setNativeValue(textarea, "Thriller\n\nWestern\n"));

    const saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
    await act(async () => saveButton.click());

    expect(apiPutMock).toHaveBeenCalledWith(
      "/admin/libraries/{id}/stash-connection",
      expect.objectContaining({ body: expect.objectContaining({ genreTagNames: ["Thriller", "Western"] }) }),
    );
  });

  it("sends blobsPath when a filesystem blobs path is typed, and null when the field is left blank", async () => {
    apiPutMock.mockResolvedValue({ ...unconfiguredConnection(), configured: true, sqlitePath: "/data/stash.sqlite" });
    view = renderIntoBody(<StashConnectionPanel connection={unconfiguredConnection()} onSaved={() => {}} />);
    const inputs = Array.from(view.container.querySelectorAll("input")) as HTMLInputElement[];
    act(() => setNativeValue(inputs[0]!, "/data/stash.sqlite")); // sqlite path (first field)
    const blobsInput = Array.from(view.container.querySelectorAll("input")).find(
      (i) => (i as HTMLInputElement).placeholder === "/path/to/stash/blobs",
    ) as HTMLInputElement;
    act(() => setNativeValue(blobsInput, "/data/stash/blobs"));

    let saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
    await act(async () => saveButton.click());
    expect(apiPutMock).toHaveBeenLastCalledWith(
      "/admin/libraries/{id}/stash-connection",
      expect.objectContaining({ body: expect.objectContaining({ blobsPath: "/data/stash/blobs" }) }),
    );

    act(() => setNativeValue(blobsInput, "   ")); // cleared → null
    saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
    await act(async () => saveButton.click());
    expect(apiPutMock).toHaveBeenLastCalledWith(
      "/admin/libraries/{id}/stash-connection",
      expect.objectContaining({ body: expect.objectContaining({ blobsPath: null }) }),
    );
  });

  it("calls onSaved with the PUT response on success", async () => {
    const saved = { ...unconfiguredConnection(), configured: true, sqlitePath: "/data/stash.sqlite", status: "ok" };
    apiPutMock.mockResolvedValue(saved);
    const onSaved = vi.fn();
    view = renderIntoBody(<StashConnectionPanel connection={{ ...unconfiguredConnection(), sqlitePath: "/data/stash.sqlite" }} onSaved={onSaved} />);

    const saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
    await act(async () => saveButton.click());

    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it("shows an inline error and does not call onSaved when the PUT fails", async () => {
    apiPutMock.mockRejectedValue(new FakeApiError("Failed to save"));
    const onSaved = vi.fn();
    view = renderIntoBody(<StashConnectionPanel connection={{ ...unconfiguredConnection(), sqlitePath: "/data/stash.sqlite" }} onSaved={onSaved} />);

    const saveButton = Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLButtonElement;
    await act(async () => saveButton.click());

    expect(view.container.textContent).toContain("Failed to save");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
