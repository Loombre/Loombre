// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/pipeline.spec.ts
//
// Review lane R2 (S4 audit). apps/worker/src/stash/pipeline.ts's own header
// has always claimed "unit-testable without a real queue
// (test/stash/pipeline.spec.ts)" — this file is that spec, written to close
// the gap the audit found: matching-integration.spec.ts hand-rolls S4's
// two-pass loop (it calls matchStashScenes twice itself), so the REAL
// runMatchingPass — the only thing production ever executes — had no test
// of its own, and its central PERFORMANCE claim went unproven.
//
// The claim under test (S4, verbatim): "Secondary = size + Stash oshash
// (computed lazily Loombre-side for UNMATCHED CANDIDATES ONLY — 64KB
// head/tail hash)". That is a bound on file I/O at the owner's 33k scale:
// a scene resolved by the free path tier must never cause its file to be
// opened and hashed. The observable proof is the file system itself, so
// these tests count real reads by pointing candidates at real files and
// spying on the module boundary that touches them.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createDb,
  listStashSceneLinksForLibrary,
  replaceLibraryPathMappings,
  resolveTestDatabaseUrl,
  upsertStashSceneLinksFromInventory,
} from "@loombre/db";
import { computeOshashForFile } from "../../src/stash/oshash.js";
import { runMatchingPass } from "../../src/stash/pipeline.js";

// The lazy-oshash claim is about FILE I/O, so the spy goes on the one
// module that performs it. pipeline.ts imports computeOshashForFile from
// './oshash.js'; vi.mock replaces that binding for this suite while
// delegating to the real implementation, so behavior is unchanged and only
// the call set is observed.
const oshashCalls: string[] = [];
vi.mock("../../src/stash/oshash.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stash/oshash.js")>();
  return {
    ...actual,
    computeOshashForFile: async (filePath: string) => {
      oshashCalls.push(filePath);
      return actual.computeOshashForFile(filePath);
    },
  };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DB_ROOT = path.resolve(__dirname, "../../../../packages/db");
const DATABASE_URL = resolveTestDatabaseUrl();

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PKG_DB_ROOT,
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

let db: ReturnType<typeof createDb>;
let mediaDir: string;

beforeAll(async () => {
  run(path.join(PKG_DB_ROOT, "scripts", "migrate.mjs"), ["reset"]);
  db = createDb(DATABASE_URL);
  mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-pipeline-media-"));
});

afterAll(async () => {
  await db?.destroy();
  if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
});

afterEach(() => {
  oshashCalls.length = 0;
});

async function makeLibrary(): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto("libraries")
    .values({ name: `pipeline-lib-${randomUUID()}`, media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A real catalog item + media_files row + a real file on disk whose SIZE
 *  is exactly `bytes.length` — matching's size bucket is keyed on the DB
 *  column, and the oshash tier needs genuine bytes to read. */
async function makeItemWithFile(libraryId: string, basename: string, bytes: Buffer): Promise<{ itemId: string; filePath: string }> {
  const now = Date.now();
  const item = await db
    .insertInto("catalog_items")
    .values({ library_id: libraryId, item_type: "movie", title: basename, sort_title: basename, added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  const filePath = path.join(mediaDir, basename);
  writeFileSync(filePath, bytes);
  await db.insertInto("media_files").values({ item_id: item.id, path: filePath, size_bytes: bytes.length }).execute();
  return { itemId: item.id, filePath };
}

describe("runMatchingPass — S4 lazy-oshash bound (the perf claim, proven by counting real file reads)", () => {
  it("a scene resolved by the PATH tier never causes ANY oshash computation", async () => {
    const libraryId = await makeLibrary();
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);
    const { itemId } = await makeItemWithFile(libraryId, "path-only.mp4", Buffer.alloc(4096, 0x41));

    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: "1", stashPath: "/stash-media/path-only.mp4", stashSizeBytes: 4096, stashOshash: "deadbeefdeadbeef", stashUpdatedAtMs: Date.now() }],
      Date.now()
    );

    const { results } = await runMatchingPass(
      db,
      libraryId,
      [{ stashSceneId: "1", stashPath: "/stash-media/path-only.mp4", stashSizeBytes: 4096, stashOshash: "deadbeefdeadbeef" }],
      Date.now()
    );

    expect(results).toEqual([{ stashSceneId: "1", itemId, mediaFileId: expect.any(String), matchedBy: "path" }]);
    // Nothing is still unmatched, so pass 2 must not run at all.
    expect(oshashCalls).toEqual([]);

    const persisted = await listStashSceneLinksForLibrary(db, libraryId);
    expect(persisted[0]).toMatchObject({ item_id: itemId, matched_by: "path" });
  });

  it("an ALREADY PATH-MATCHED candidate is never hashed, even when its size collides with a still-unmatched scene's", async () => {
    // The exact shape S4's "for unmatched candidates only" exists to bound.
    // Two Loombre files of the SAME size: one already claimed by scene 1
    // through the free path tier, one genuinely unclaimed. Scene 2 has no
    // usable path (no mapping covers it) and carries an oshash, so pass 2
    // runs — and must hash ONLY the unclaimed candidate. Hashing the
    // already-claimed one is pure waste: it cannot be S4's answer for
    // scene 2 (it is already scene 1's file), and at 33k scenes with a
    // common encode size that waste is multiplied by however many files
    // share a byte count.
    const libraryId = await makeLibrary();
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);

    const size = 8192;
    const claimed = await makeItemWithFile(libraryId, "claimed-by-path.mp4", Buffer.alloc(size, 0x41));
    const unclaimed = await makeItemWithFile(libraryId, "unclaimed.mp4", Buffer.alloc(size, 0x42));
    const unclaimedOshash = await computeOshashForFile(unclaimed.filePath);
    oshashCalls.length = 0; // the setup hash above is not part of the measurement

    const scenes = [
      // Path-mapped onto `claimed` — resolves in pass 1 for free.
      { stashSceneId: "1", stashPath: "/stash-media/claimed-by-path.mp4", stashSizeBytes: size, stashOshash: "0000000000000000" },
      // No mapping covers this prefix, so the path tier cannot resolve it;
      // its oshash is `unclaimed`'s, so the oshash tier should.
      { stashSceneId: "2", stashPath: "/elsewhere/moved-away.mp4", stashSizeBytes: size, stashOshash: unclaimedOshash },
    ];
    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      scenes.map((s) => ({ ...s, stashUpdatedAtMs: Date.now() })),
      Date.now()
    );

    const { results } = await runMatchingPass(db, libraryId, scenes, Date.now());

    expect(results.find((r) => r.stashSceneId === "1")).toMatchObject({ itemId: claimed.itemId, matchedBy: "path" });
    expect(results.find((r) => r.stashSceneId === "2")).toMatchObject({ itemId: unclaimed.itemId, matchedBy: "oshash" });

    // THE BOUND: only the unclaimed candidate's bytes were ever read.
    expect(oshashCalls).toEqual([unclaimed.filePath]);
  });

  it("a candidate whose size matches NO still-unmatched scene is never hashed", async () => {
    const libraryId = await makeLibrary();
    const wrongSize = await makeItemWithFile(libraryId, "wrong-size.mp4", Buffer.alloc(1024, 0x43));
    const target = await makeItemWithFile(libraryId, "right-size.mp4", Buffer.alloc(2048, 0x44));
    const targetOshash = await computeOshashForFile(target.filePath);
    oshashCalls.length = 0;

    const scenes = [{ stashSceneId: "1", stashPath: "/unmapped/x.mp4", stashSizeBytes: 2048, stashOshash: targetOshash }];
    await upsertStashSceneLinksFromInventory(db, libraryId, scenes.map((s) => ({ ...s, stashUpdatedAtMs: Date.now() })), Date.now());

    const { results } = await runMatchingPass(db, libraryId, scenes, Date.now());

    expect(results[0]).toMatchObject({ itemId: target.itemId, matchedBy: "oshash" });
    expect(oshashCalls).toEqual([target.filePath]);
    expect(oshashCalls).not.toContain(wrongSize.filePath);
  });

  it("no scene carries a (size, oshash) pair at all — pass 2 is skipped entirely, zero file reads", async () => {
    const libraryId = await makeLibrary();
    await makeItemWithFile(libraryId, "never-read.mp4", Buffer.alloc(512, 0x45));

    const scenes = [{ stashSceneId: "1", stashPath: "/unmapped/no-fingerprint.mp4", stashSizeBytes: 512, stashOshash: null }];
    await upsertStashSceneLinksFromInventory(db, libraryId, scenes.map((s) => ({ ...s, stashUpdatedAtMs: Date.now() })), Date.now());

    const { results } = await runMatchingPass(db, libraryId, scenes, Date.now());

    expect(results[0]).toMatchObject({ itemId: null, matchedBy: null }); // unmatched, visible (S4)
    expect(oshashCalls).toEqual([]);
  });

  it("an unreadable candidate file leaves that one candidate unhashed without failing the whole pass", async () => {
    const libraryId = await makeLibrary();
    const now = Date.now();
    const ghost = await db
      .insertInto("catalog_items")
      .values({ library_id: libraryId, item_type: "movie", title: "ghost", sort_title: "ghost", added_at_ms: now, updated_at_ms: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    // A media_files row pointing at a file that no longer exists — the
    // "real, unremarkable state" pipeline.ts's own comment describes.
    await db.insertInto("media_files").values({ item_id: ghost.id, path: path.join(mediaDir, "vanished.mp4"), size_bytes: 3072 }).execute();
    const real = await makeItemWithFile(libraryId, "still-here.mp4", Buffer.alloc(3072, 0x46));
    const realOshash = await computeOshashForFile(real.filePath);
    oshashCalls.length = 0;

    const scenes = [{ stashSceneId: "1", stashPath: "/unmapped/x.mp4", stashSizeBytes: 3072, stashOshash: realOshash }];
    await upsertStashSceneLinksFromInventory(db, libraryId, scenes.map((s) => ({ ...s, stashUpdatedAtMs: Date.now() })), Date.now());

    const { results } = await runMatchingPass(db, libraryId, scenes, Date.now());
    expect(results[0]).toMatchObject({ itemId: real.itemId, matchedBy: "oshash" });
    expect(oshashCalls.sort()).toEqual([path.join(mediaDir, "still-here.mp4"), path.join(mediaDir, "vanished.mp4")].sort());
  });
});

describe("runMatchingPass — S4 tier bookkeeping persisted", () => {
  it("matched_by records the TIER that actually resolved each scene, and unmatched stays visible", async () => {
    const libraryId = await makeLibrary();
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-media", loombrePrefix: mediaDir }]);

    const byPath = await makeItemWithFile(libraryId, "tier-path.mp4", Buffer.alloc(1500, 0x51));
    const byOshash = await makeItemWithFile(libraryId, "tier-oshash.mp4", Buffer.alloc(2500, 0x52));
    const oshash = await computeOshashForFile(byOshash.filePath);
    oshashCalls.length = 0;

    const scenes = [
      { stashSceneId: "1", stashPath: "/stash-media/tier-path.mp4", stashSizeBytes: 1500, stashOshash: null },
      { stashSceneId: "2", stashPath: "/no-mapping/renamed.mp4", stashSizeBytes: 2500, stashOshash: oshash },
      { stashSceneId: "3", stashPath: "/no-mapping/nothing-like-it.mp4", stashSizeBytes: 999_999, stashOshash: "ffffffffffffffff" },
    ];
    await upsertStashSceneLinksFromInventory(db, libraryId, scenes.map((s) => ({ ...s, stashUpdatedAtMs: Date.now() })), Date.now());

    await runMatchingPass(db, libraryId, scenes, Date.now());

    const persisted = await listStashSceneLinksForLibrary(db, libraryId);
    const byId = new Map(persisted.map((r) => [r.stash_scene_id, r]));
    expect(byId.get("1")).toMatchObject({ item_id: byPath.itemId, matched_by: "path" });
    expect(byId.get("2")).toMatchObject({ item_id: byOshash.itemId, matched_by: "oshash" });
    expect(byId.get("3")).toMatchObject({ item_id: null, matched_by: null });
    expect(persisted).toHaveLength(3); // unmatched row never dropped (S4)
  });
});
