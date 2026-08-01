// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/matching-integration.spec.ts
//
// STATE.md S4 DoD #5's INTEGRATION half: the pure matchStashScenes core
// (matching.spec.ts) wired against REAL Postgres candidate rows (via
// packages/db/src/query/stash-inventory.ts) and REAL files on disk (via
// oshash.ts's computeOshashForFile, exercising the "lazy — only for
// unmatched candidates" two-pass shape matching.ts's own header
// describes) — proving path-mapped matches, oshash fallback matches, and
// unmatched-both-sides visibility end to end, not just at the pure-
// function level.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5442/loombre
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  applyStashSceneMatchResults,
  computePathMappingMatchPreview,
  createDb,
  listCandidateMediaFilesForLibrary,
  listStashSceneLinksForLibrary,
  replaceLibraryPathMappings,
  upsertStashSceneLinksFromInventory,
} from "@loombre/db";
import { computeOshashForFile } from "../../src/stash/oshash.js";
import { matchStashScenes, type LoombreFileCandidate } from "../../src/stash/matching.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DB_ROOT = path.resolve(__dirname, "../../../../packages/db");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://loombre:loombre@localhost:5442/loombre";

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
  mediaDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-matching-media-"));
});

afterAll(async () => {
  await db?.destroy();
  if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
});

async function makeLibrary(): Promise<string> {
  const now = Date.now();
  const row = await db
    .insertInto("libraries")
    .values({ name: `lib-${randomUUID()}`, media_kind: "movie", paths: [], content_class: "restricted", created_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makeCatalogItemWithFile(libraryId: string, filePath: string, bytes: Buffer): Promise<{ itemId: string }> {
  const now = Date.now();
  const item = await db
    .insertInto("catalog_items")
    .values({ library_id: libraryId, item_type: "movie", title: `item-${randomUUID()}`, sort_title: "item", added_at_ms: now, updated_at_ms: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db.insertInto("media_files").values({ item_id: item.id, path: filePath, size_bytes: bytes.length }).execute();
  writeFileSync(filePath, bytes);
  return { itemId: item.id };
}

describe("S4 matching — full pipeline (real Postgres + real files)", () => {
  it("path-mapped match: resolves via the rewritten path with zero oshash computation needed", async () => {
    const libraryId = await makeLibrary();
    await replaceLibraryPathMappings(db, libraryId, [{ stashPrefix: "/stash-mnt", loombrePrefix: mediaDir }]);
    const { itemId } = await makeCatalogItemWithFile(libraryId, path.join(mediaDir, "path-match.mp4"), Buffer.from("path-tier content"));

    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: "s1", stashPath: "/stash-mnt/path-match.mp4", stashSizeBytes: null, stashOshash: null, stashUpdatedAtMs: Date.now() }],
      Date.now()
    );

    const mappings = [{ stashPrefix: "/stash-mnt", loombrePrefix: mediaDir }];
    const sceneLinks = await listStashSceneLinksForLibrary(db, libraryId);
    const candidateRows = await listCandidateMediaFilesForLibrary(db, libraryId);
    const candidates: LoombreFileCandidate[] = candidateRows.map((c) => ({ ...c, oshash: null }));

    const results = matchStashScenes(
      sceneLinks.map((s) => ({ stashSceneId: s.stash_scene_id, stashPath: s.stash_path, stashSizeBytes: s.stash_size_bytes, stashOshash: s.stash_oshash })),
      mappings,
      candidates
    );
    expect(results).toEqual([{ stashSceneId: "s1", itemId, mediaFileId: expect.any(String), matchedBy: "path" }]);

    await applyStashSceneMatchResults(db, libraryId, results, Date.now());
    const persisted = await listStashSceneLinksForLibrary(db, libraryId);
    expect(persisted[0]).toMatchObject({ item_id: itemId, matched_by: "path" });
  });

  it("oshash fallback: path tier misses (file relocated), lazy oshash computation resolves it", async () => {
    const libraryId = await makeLibrary();
    const bytes = Buffer.alloc(20, 0x7);
    const { itemId } = await makeCatalogItemWithFile(libraryId, path.join(mediaDir, "relocated-target.mp4"), bytes);
    const trueOshash = await computeOshashForFile(path.join(mediaDir, "relocated-target.mp4"));

    // No path mapping configured at all — the path tier can never
    // resolve this scene; only oshash can.
    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: "s2", stashPath: "/stash-mnt/original-name.mp4", stashSizeBytes: bytes.length, stashOshash: trueOshash, stashUpdatedAtMs: Date.now() }],
      Date.now()
    );

    const sceneLinks = await listStashSceneLinksForLibrary(db, libraryId);
    const candidateRows = await listCandidateMediaFilesForLibrary(db, libraryId);

    // Pass 1: no mappings, oshash left null everywhere — proves the path
    // tier alone cannot resolve this scene.
    const pass1 = matchStashScenes(
      sceneLinks.map((s) => ({ stashSceneId: s.stash_scene_id, stashPath: s.stash_path, stashSizeBytes: s.stash_size_bytes, stashOshash: s.stash_oshash })),
      [],
      candidateRows.map((c) => ({ ...c, oshash: null }))
    );
    expect(pass1[0]?.matchedBy).toBeNull();

    // Pass 2: lazily compute oshash ONLY for same-size candidates (S4's
    // "lazy" requirement) — here there's exactly one.
    const sameSizeCandidates = candidateRows.filter((c) => c.sizeBytes === bytes.length);
    const withOshash: LoombreFileCandidate[] = await Promise.all(
      candidateRows.map(async (c) => ({
        ...c,
        oshash: sameSizeCandidates.some((s) => s.mediaFileId === c.mediaFileId) ? await computeOshashForFile(c.path) : null,
      }))
    );
    const pass2 = matchStashScenes(
      sceneLinks.map((s) => ({ stashSceneId: s.stash_scene_id, stashPath: s.stash_path, stashSizeBytes: s.stash_size_bytes, stashOshash: s.stash_oshash })),
      [],
      withOshash
    );
    expect(pass2).toEqual([{ stashSceneId: "s2", itemId, mediaFileId: expect.any(String), matchedBy: "oshash" }]);
  });

  it("unmatched-both-sides visibility: an unclaimed Stash scene and an unclaimed Loombre file are both still visible", async () => {
    const libraryId = await makeLibrary();
    await makeCatalogItemWithFile(libraryId, path.join(mediaDir, "orphan-loombre-file.mp4"), Buffer.from("never claimed"));

    await upsertStashSceneLinksFromInventory(
      db,
      libraryId,
      [{ stashSceneId: "s3", stashPath: "/stash-mnt/orphan-stash-scene.mp4", stashSizeBytes: 12345, stashOshash: null, stashUpdatedAtMs: Date.now() }],
      Date.now()
    );

    const sceneLinks = await listStashSceneLinksForLibrary(db, libraryId);
    const candidateRows = await listCandidateMediaFilesForLibrary(db, libraryId);
    const results = matchStashScenes(
      sceneLinks.map((s) => ({ stashSceneId: s.stash_scene_id, stashPath: s.stash_path, stashSizeBytes: s.stash_size_bytes, stashOshash: s.stash_oshash })),
      [],
      candidateRows.map((c) => ({ ...c, oshash: null }))
    );

    // The Stash scene: visible, unmatched.
    expect(results).toEqual([{ stashSceneId: "s3", itemId: null, mediaFileId: null, matchedBy: null }]);
    await applyStashSceneMatchResults(db, libraryId, results, Date.now());
    const persisted = await listStashSceneLinksForLibrary(db, libraryId);
    expect(persisted).toHaveLength(1); // row still exists — never dropped

    // The Loombre file: visible via computePathMappingMatchPreview's own
    // candidate listing (it was never claimed by any scene).
    const claimedIds = new Set(results.map((r) => r.mediaFileId).filter(Boolean));
    const unclaimedLoombreFiles = candidateRows.filter((c) => !claimedIds.has(c.mediaFileId));
    expect(unclaimedLoombreFiles).toHaveLength(1);

    const preview = await computePathMappingMatchPreview(db, libraryId);
    expect(preview.totalStashScenes).toBe(1);
    expect(preview.unmatchedCount).toBe(1);
  });
});
