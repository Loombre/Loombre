// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/stash/read-model.spec.ts
//
// Typed reads against BOTH pinned-range boundary fixtures (v67: no
// `folders.basename`; v85: `folders.basename` present) — run as a single
// parametrized suite so any behavioral drift between the two schema
// shapes shows up immediately. Field coverage matches the recon pointer's
// list: scenes (title/details/date/rating100/updated_at), performers
// (aliases/birthdate/country/measurements), studios (parent+image), tags
// (hierarchy), markers (seconds+title+primary tag), files
// (path/size/oshash fingerprints), cover image refs.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtureDb } from "./fixtures/build-fixture-db.js";
import { openStashConnection, type StashConnection } from "../../src/stash/adapter.js";
import {
  getBlob,
  getScene,
  getSceneFiles,
  getSceneMarkers,
  getScenePerformers,
  getSceneTags,
  getStudio,
  getTag,
  listScenesForInventory,
} from "../../src/stash/read-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

let workDir: string;
const openConns: StashConnection[] = [];

afterAll(() => {
  for (const conn of openConns) conn.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function openFixture(sqlFileName: string): Promise<StashConnection> {
  if (!workDir) workDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-read-model-"));
  const dbPath = path.join(workDir, `${sqlFileName}-${randomUUID()}.sqlite`);
  const built = buildFixtureDb(path.join(FIXTURES_DIR, sqlFileName), dbPath);
  built.close();
  const conn = await openStashConnection({ path: dbPath });
  openConns.push(conn);
  return conn;
}

describe.each([
  ["schema-v67-supported-min.sql (no folders.basename)"],
  ["schema-v85-supported-max.sql (folders.basename present)"],
])("read-model against %s", (label) => {
  const fixtureFile = label.startsWith("schema-v67") ? "schema-v67-supported-min.sql" : "schema-v85-supported-max.sql";

  it("getScene reads a fully-populated scene", async () => {
    const conn = await openFixture(fixtureFile);
    const scene = getScene(conn.db, "1");
    expect(scene).toMatchObject({
      id: "1",
      title: "Scene One",
      details: "Details for scene one.",
      date: "2023-06-15",
      rating100: 85,
      studioId: "1",
      code: "ABC-123",
      director: "Some Director",
      organized: true,
      coverBlobChecksum: "scene1cover",
    });
    expect(scene?.updatedAtMs).toBeGreaterThan(0);
  });

  it("getScene reads a minimally-populated scene without throwing on NULLs", async () => {
    const conn = await openFixture(fixtureFile);
    const scene = getScene(conn.db, "2");
    expect(scene).toMatchObject({
      id: "2",
      title: "Scene Two",
      details: null,
      date: null,
      rating100: null,
      studioId: null,
      coverBlobChecksum: null,
      organized: false,
    });
  });

  it("getScene returns null for a nonexistent scene id", async () => {
    const conn = await openFixture(fixtureFile);
    expect(getScene(conn.db, "999")).toBeNull();
  });

  it("getSceneFiles reconstructs the full absolute path (folder.path + basename) and reads size/oshash", async () => {
    const conn = await openFixture(fixtureFile);
    const files = getSceneFiles(conn.db, "1");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "/data/videos/scene-one.mp4",
      basename: "scene-one.mp4",
      sizeBytes: 104857600,
      isPrimary: true,
      oshash: "a1b2c3d4e5f6a7b8",
      md5: "deadbeefdeadbeefdeadbeefdeadbeef",
    });
  });

  it("getSceneFiles reconstructs a NESTED folder's path identically regardless of folders.basename presence", async () => {
    const conn = await openFixture(fixtureFile);
    const files = getSceneFiles(conn.db, "2");
    expect(files[0]?.path).toBe("/data/videos/sub/scene-two.mkv");
    expect(files[0]?.oshash).toBe("ffeeddccbbaa9988");
    expect(files[0]?.md5).toBeNull();
  });

  it("getSceneFiles does not throw when a file carries a phash int64 fingerprint out of JS safe-integer range (real-DB regression)", () => {
    // The v85 fixture's files carry a real-shaped phash row (a raw signed
    // int64 in the blob-affinity fingerprint column). Before the type-
    // filtered SELECT in readFingerprints, node:sqlite threw ERR_OUT_OF_RANGE
    // materializing that value — crashing the whole apply phase on any real
    // Stash library. Both fixtures must read cleanly; only oshash/md5 (text)
    // are ever surfaced, phash is never touched.
    return openFixture(fixtureFile).then((conn) => {
      expect(() => getSceneFiles(conn.db, "1")).not.toThrow();
      const files = getSceneFiles(conn.db, "1");
      expect(files[0]?.oshash).toBe("a1b2c3d4e5f6a7b8");
      expect(files[0]).not.toHaveProperty("phash");
    });
  });

  it("getScenePerformers includes aliases/birthdate/country/measurements", async () => {
    const conn = await openFixture(fixtureFile);
    const performers = getScenePerformers(conn.db, "1");
    expect(performers).toHaveLength(2);
    const jane = performers.find((p) => p.name === "Jane Doe");
    expect(jane).toMatchObject({
      id: "1",
      birthdate: "1990-05-01",
      country: "USA",
      measurements: "34-24-35",
    });
    expect(jane?.aliases.sort()).toEqual(["JD", "Jane D."]);

    const john = performers.find((p) => p.name === "John Smith");
    expect(john?.aliases).toEqual([]);
    expect(john?.birthdate).toBeNull();
  });

  it("getStudio includes parent linkage (null here) and image ref", async () => {
    const conn = await openFixture(fixtureFile);
    const studio = getStudio(conn.db, "1");
    expect(studio).toMatchObject({ id: "1", name: "Acme Studios", parentId: null, rating100: 80, imageBlobChecksum: "studio1img" });
  });

  it("getSceneTags preserves hierarchy (parentIds/childIds via tags_relations)", async () => {
    const conn = await openFixture(fixtureFile);
    const tags = getSceneTags(conn.db, "1");
    expect(tags.map((t) => t.name).sort()).toEqual(["Action", "Fight Scene"]);
    const action = tags.find((t) => t.name === "Action")!;
    const fight = tags.find((t) => t.name === "Fight Scene")!;
    expect(action.parentIds).toEqual([]);
    expect(action.childIds).toEqual(["2"]);
    expect(fight.parentIds).toEqual(["1"]);
    expect(fight.childIds).toEqual([]);
  });

  it("getTag works standalone (not scene-scoped) and matches getSceneTags", async () => {
    const conn = await openFixture(fixtureFile);
    const tag = getTag(conn.db, "2");
    expect(tag).toMatchObject({ id: "2", name: "Fight Scene", parentIds: ["1"] });
  });

  it("getSceneMarkers reads seconds/title/primary tag", async () => {
    const conn = await openFixture(fixtureFile);
    const markers = getSceneMarkers(conn.db, "1");
    expect(markers).toEqual([
      { id: "1", title: "Marker One", startSeconds: 30.5, endSeconds: 45, primaryTagId: "2" },
    ]);
  });

  it("a scene with no markers returns an empty array, not null/throw", async () => {
    const conn = await openFixture(fixtureFile);
    expect(getSceneMarkers(conn.db, "2")).toEqual([]);
  });

  it("getBlob reads cover bytes by checksum", async () => {
    const conn = await openFixture(fixtureFile);
    const blob = getBlob(conn.db, "scene1cover");
    expect(blob).not.toBeNull();
    expect(blob!.checksum).toBe("scene1cover");
    expect(Buffer.isBuffer(blob!.bytes)).toBe(true);
    expect(blob!.bytes!.length).toBeGreaterThan(0);
  });

  it("getBlob returns null for an unknown checksum", async () => {
    const conn = await openFixture(fixtureFile);
    expect(getBlob(conn.db, "does-not-exist")).toBeNull();
  });

  it("listScenesForInventory returns every scene's primary-file facts (K10 inventory pass)", async () => {
    const conn = await openFixture(fixtureFile);
    const inventory = listScenesForInventory(conn.db);
    expect(inventory).toHaveLength(2);
    const one = inventory.find((s) => s.stashSceneId === "1")!;
    expect(one).toMatchObject({
      stashSceneId: "1",
      path: "/data/videos/scene-one.mp4",
      sizeBytes: 104857600,
      oshash: "a1b2c3d4e5f6a7b8",
    });
    expect(one.updatedAtMs).toBeGreaterThan(0);
    const two = inventory.find((s) => s.stashSceneId === "2")!;
    expect(two.path).toBe("/data/videos/sub/scene-two.mkv");
  });
});
