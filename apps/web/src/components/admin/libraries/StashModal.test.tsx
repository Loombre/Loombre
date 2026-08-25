// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/components/admin/libraries/StashModal.test.tsx
//
// STATE.md FIX WAVE FX1: the modal chrome — loads the connection once,
// gates every tab's render on that load, and switches between the three
// panels via the tab strip. apiGet is mocked and routed by path
// (LibrariesPanel.test.tsx's established convention) since every one of
// the three panels fetches through the exact same api-client module this
// modal does.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@loombre/sdk";
import { renderIntoBody, type TestRender } from "../../ui/test-render.js";

type Library = components["schemas"]["Library"];
type AdminStashConnection = components["schemas"]["AdminStashConnection"];

const apiGetMock = vi.fn();

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
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  LoombreApiError: FakeApiError,
}));

vi.mock("../../../lib/events-socket.js", () => ({
  getEventsSocket: () => ({ subscribe: () => () => {} }),
}));

const { StashModal } = await import("./StashModal.js");

function library(): Library {
  return {
    id: "lib-1",
    name: "Adult Movies",
    mediaKind: "movie",
    paths: ["/media/restricted"],
    contentClass: "restricted",
    createdAtMs: 0,
    updatedAtMs: 0,
    itemCount: 12,
  };
}

function connectionFixture(): AdminStashConnection {
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
  };
}

describe("StashModal", () => {
  let view: TestRender | null = null;

  beforeEach(() => {
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/libraries/{id}/stash-connection") return Promise.resolve(connectionFixture());
      if (path === "/admin/libraries/{id}/stash-path-mappings") return Promise.resolve({ mappings: [] });
      if (path === "/admin/libraries/{id}/stash-sync-report") {
        return Promise.resolve({ report: null, unmatchedScenes: { items: [], nextCursor: null }, staleScenes: { items: [], nextCursor: null } });
      }
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
  });

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it("titles the dialog with the library name", async () => {
    view = renderIntoBody(<StashModal library={library()} onClose={() => {}} />);
    await act(async () => {});
    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Stash — Adult Movies");
  });

  it("defaults to the Connection tab, showing its sqlite path field", async () => {
    view = renderIntoBody(<StashModal library={library()} onClose={() => {}} />);
    await act(async () => {});
    expect(view.container.querySelector('input[placeholder="/path/to/stash-go.sqlite"]')).not.toBeNull();
  });

  it("switching to Path mappings renders that panel's empty state", async () => {
    view = renderIntoBody(<StashModal library={library()} onClose={() => {}} />);
    await act(async () => {});

    const tab = Array.from(view.container.querySelectorAll('[role="radio"]')).find((t) => t.textContent === "Path mappings") as HTMLButtonElement;
    await act(async () => tab.click());

    expect(view.container.textContent).toContain("No path mappings yet.");
  });

  it("switching to Sync renders that panel's never-synced empty state", async () => {
    view = renderIntoBody(<StashModal library={library()} onClose={() => {}} />);
    await act(async () => {});

    const tab = Array.from(view.container.querySelectorAll('[role="radio"]')).find((t) => t.textContent === "Sync") as HTMLButtonElement;
    await act(async () => tab.click());

    expect(view.container.textContent).toContain("Never synced yet");
  });

  it("shows an inline error when the initial connection load fails, without crashing", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/admin/libraries/{id}/stash-connection") return Promise.reject(new FakeApiError("Failed to load the Stash connection."));
      return Promise.reject(new Error(`unexpected apiGet(${path})`));
    });
    view = renderIntoBody(<StashModal library={library()} onClose={() => {}} />);
    await act(async () => {});
    expect(view.container.textContent).toContain("Failed to load the Stash connection.");
  });
});
