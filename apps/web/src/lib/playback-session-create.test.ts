// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/web/src/lib/playback-session-create.test.ts
//
// createPlaybackSession's request body — specifically that a subtitle pin
// travels as PlanRequest.selection (packages/contract/openapi.yaml's
// TrackSelection) and that no `selection` key is sent when nothing is
// pinned (additionalProperties: false on the server side; an unpinned
// create must look exactly as it always has).

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();
vi.mock("./api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("./api-client.js")>("./api-client.js");
  return { ...actual, apiPost: (...args: unknown[]) => apiPost(...args) };
});
vi.mock("./device-profile-override.js", () => ({
  resolveSessionDeviceProfile: async () => ({ name: "test-device" }),
}));
vi.mock("./network-conditions.js", () => ({
  buildNetworkConditions: () => ({ kind: "lan" }),
}));
vi.mock("./auth-store.js", () => ({
  getAuthStore: () => ({
    getSnapshot: () => ({ serverUrl: "http://server.test" }),
  }),
}));

import { createPlaybackSession } from "./playback-session.js";

describe("createPlaybackSession request body", () => {
  beforeEach(() => {
    apiPost.mockReset().mockResolvedValue({ id: "session-1" });
  });

  it("sends a subtitle pin as PlanRequest.selection", async () => {
    await createPlaybackSession("item-1", "stream", undefined, {
      subtitleStreamIndex: 3,
    });
    expect(apiPost).toHaveBeenCalledWith("/playback/sessions", {
      body: {
        itemId: "item-1",
        device: { name: "test-device" },
        network: { kind: "lan" },
        mode: "stream",
        selection: { subtitleStreamIndex: 3 },
      },
    });
  });

  it("sends no selection key at all when nothing is pinned", async () => {
    await createPlaybackSession("item-1", "stream", "file-1");
    expect(apiPost).toHaveBeenCalledWith("/playback/sessions", {
      body: {
        itemId: "item-1",
        mediaFileId: "file-1",
        device: { name: "test-device" },
        network: { kind: "lan" },
        mode: "stream",
      },
    });
  });
});
