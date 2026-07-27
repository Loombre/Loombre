// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/scan/local-artwork.spec.ts
//
// "Local artwork ... adjacent, cover art -> enqueue 'image' jobs with
// source paths" (docs/PLAN.md §8.1). The payload's entityType must be the
// canonical vocabulary value 'catalog_item' (packages/db/src/query/
// images.ts's ImageEntityType, the same value metadata/consumer.ts's
// provider-image path enqueues): the image consumer resolves the entity by
// that string and returns silently — job green, zero images rows, zero
// variants — for anything it does not recognize, so a mismatch here is a
// completely invisible no-op rather than a failure.

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/scanner.js";
import { createHashPool, type HashPool } from "../../src/scan/identity/pool.js";
import { createLibrary, makeDb, makeMemoryQueue, makeRawClient, makeTmpLibraryDir, resetSchema, writeFakeMediaFile } from "./helpers.js";

describe("scanner: local artwork image jobs", () => {
  const dbHandle = makeDb();
  const raw = makeRawClient();
  let hashPool: HashPool;
  let libraryId: string;
  let libraryDir: string;

  beforeAll(async () => {
    resetSchema();
    await raw.connect();
    hashPool = createHashPool(2);
    libraryDir = makeTmpLibraryDir("local-artwork");

    const movieDir = join(libraryDir, "Artwork Movie (2019)");
    writeFakeMediaFile(join(movieDir, "Artwork Movie (2019).mkv"), "artwork-movie", 512);
    writeFileSync(join(movieDir, "poster.jpg"), "not a real jpeg");
    writeFileSync(join(movieDir, "fanart.jpg"), "not a real jpeg either");

    libraryId = await createLibrary(raw, { name: "Artwork Library", mediaKind: "movie", paths: [libraryDir] });
  });

  afterAll(async () => {
    await hashPool.terminate();
    await dbHandle.destroy();
    await raw.end();
  });

  it("enqueues one 'image' job per adjacent artwork file, addressed to the catalog_item entity", async () => {
    const { queue, calls } = makeMemoryQueue();
    await runScan(
      { db: dbHandle, queue, hashPool },
      { libraryId, full: true },
      { jobId: "018f0005-0000-7000-8000-000000000001" }
    );

    const imageCalls = calls.filter((c) => c.type === "image");
    expect(imageCalls).toHaveLength(2);
    for (const call of imageCalls) {
      expect(call.payload.entityType).toBe("catalog_item");
      expect(typeof call.payload.entityId).toBe("string");
      expect(typeof call.payload.sourcePath).toBe("string");
    }
    expect(imageCalls.map((c) => c.payload.kind).sort()).toEqual(["backdrop", "poster"]);
  }, 30_000);
});
