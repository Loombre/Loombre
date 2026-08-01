// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/apply-types.spec.ts
//
// K11: the stub apply is an HONEST no-op (never fabricates a non-empty
// changedFields for work it never did) — this is the exact property
// apps/worker/src/index.ts's production wiring depends on until Lane B's
// apply.ts lands. Input/deps shapes mirror the orchestrator's frozen B/C
// seam signature exactly.

import { describe, expect, it } from "vitest";
import { createStubApplyStashSceneMetadata } from "../../src/stash/apply-types.js";

describe("createStubApplyStashSceneMetadata", () => {
  it("reports changedFields: [] — never fabricates work it didn't do", async () => {
    const stub = createStubApplyStashSceneMetadata();
    const result = await stub(
      {} as never,
      { getBlob: () => null, enqueueImageJob: async () => undefined },
      {
        libraryId: "lib-1",
        itemId: "item-1",
        stashSceneId: "scene-1",
        scene: { id: "scene-1", title: null, details: null, date: null, rating100: null, studioId: null, code: null, director: null, organized: false, coverBlobChecksum: null, createdAtMs: 0, updatedAtMs: 0 },
        files: [],
        performers: [],
        studioChain: [],
        tags: [],
        markers: [],
        genreTagNames: null,
      }
    );
    expect(result).toEqual({ changedFields: [] });
  });
});
