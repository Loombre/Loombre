// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/worker/test/metadata/providers/stash.spec.ts
//
// K7: provider name `stash`, contentClass `restricted`, kinds `['movie']`.
// fetchDetails maps a real fixture scene through the read-model into
// MovieProviderDetails (the lossy generic-path mapping — see stash.ts's
// header for what's authoritative instead). search()/fetchImages() are
// proven to be deliberate no-ops. externalId encoding
// ("<libraryId>:<stashSceneId>") is unit-tested standalone.
//
// Connection: DATABASE_URL env var, default
//   postgres://loombre:loombre@localhost:5432/loombre
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createDb, upsertLibraryStashConnectionConfig } from "@loombre/db";
import {
  InvalidStashExternalIdError,
  StashLibraryUnavailableError,
  StashSceneNotFoundError,
  buildStashExternalId,
  createStashProvider,
  parseStashExternalId,
} from "../../../src/metadata/providers/stash.js";
import { buildFixtureDb } from "../../stash/fixtures/build-fixture-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DB_ROOT = path.resolve(__dirname, "../../../../../packages/db");
const FIXTURES_DIR = path.resolve(__dirname, "../../stash/fixtures");
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
let workDir: string;

beforeAll(async () => {
  run(path.join(PKG_DB_ROOT, "scripts", "migrate.mjs"), ["reset"]);
  db = createDb(DATABASE_URL);
  workDir = mkdtempSync(path.join(tmpdir(), "loombre-stash-provider-"));
});

afterAll(async () => {
  await db?.destroy();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
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

describe("externalId encoding", () => {
  it("round-trips libraryId + stashSceneId", () => {
    const externalId = buildStashExternalId("018f6f1e-0000-7000-8000-000000000002", "42");
    expect(parseStashExternalId(externalId)).toEqual({ libraryId: "018f6f1e-0000-7000-8000-000000000002", stashSceneId: "42" });
  });

  it("throws InvalidStashExternalIdError for a malformed ref (no colon)", () => {
    expect(() => parseStashExternalId("no-colon-here")).toThrow(InvalidStashExternalIdError);
  });

  it("throws for an empty libraryId or empty stashSceneId", () => {
    expect(() => parseStashExternalId(":scene1")).toThrow(InvalidStashExternalIdError);
    expect(() => parseStashExternalId("lib1:")).toThrow(InvalidStashExternalIdError);
  });
});

describe("createStashProvider", () => {
  it("has the K7-mandated identity: name, contentClass, kinds", () => {
    const provider = createStashProvider({ db });
    expect(provider.name).toBe("stash");
    expect(provider.contentClass).toBe("restricted");
    expect(provider.kinds).toEqual(["movie"]);
    expect(provider.enabled).toBe(true);
  });

  it("search() always returns an empty array (S4: matching is path/oshash, never title search)", async () => {
    const provider = createStashProvider({ db });
    await expect(provider.search({ mediaKind: "movie", title: "anything" })).resolves.toEqual([]);
  });

  it("fetchImages() always returns an empty array (Stash covers are local bytes, not fetchable URLs)", async () => {
    const provider = createStashProvider({ db });
    await expect(provider.fetchImages({ provider: "stash", externalId: "lib:1", mediaKind: "movie" })).resolves.toEqual([]);
  });

  it("fetchDetails maps a real fixture scene into MovieProviderDetails", async () => {
    const libraryId = await makeLibrary();
    const sqlitePath = path.join(workDir, `${randomUUID()}.sqlite`);
    const built = buildFixtureDb(path.join(FIXTURES_DIR, "schema-v85-supported-max.sql"), sqlitePath);
    built.close();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath, nowMs: Date.now() });

    const provider = createStashProvider({ db });
    const ref = { provider: "stash", externalId: buildStashExternalId(libraryId, "1"), mediaKind: "movie" as const };
    const details = await provider.fetchDetails(ref);

    expect(details).toMatchObject({
      itemType: "movie",
      title: "Scene One",
      sortTitle: "Scene One",
      year: 2023,
      overview: "Details for scene one.",
      communityRating: 8.5, // rating100=85 / 10
      contentRating: null,
      genres: [],
      runtimeMs: null,
      tagline: null,
    });
    expect(details.tags.sort()).toEqual(["Action", "Fight Scene"]);
    if (details.itemType === "movie") {
      expect(details.people).toEqual([
        { name: "Jane Doe", role: "performer", order: 0 },
        { name: "John Smith", role: "performer", order: 1 },
      ]);
    }
  });

  it("fetchDetails throws StashSceneNotFoundError for an unknown scene id", async () => {
    const libraryId = await makeLibrary();
    const sqlitePath = path.join(workDir, `${randomUUID()}.sqlite`);
    const built = buildFixtureDb(path.join(FIXTURES_DIR, "schema-v85-supported-max.sql"), sqlitePath);
    built.close();
    await upsertLibraryStashConnectionConfig(db, { libraryId, sqlitePath, nowMs: Date.now() });

    const provider = createStashProvider({ db });
    const ref = { provider: "stash", externalId: buildStashExternalId(libraryId, "999999"), mediaKind: "movie" as const };
    await expect(provider.fetchDetails(ref)).rejects.toThrow(StashSceneNotFoundError);
  });

  it("fetchDetails throws StashLibraryUnavailableError when the library has no Stash connection configured", async () => {
    const libraryId = await makeLibrary();
    const provider = createStashProvider({ db });
    const ref = { provider: "stash", externalId: buildStashExternalId(libraryId, "1"), mediaKind: "movie" as const };
    await expect(provider.fetchDetails(ref)).rejects.toThrow(StashLibraryUnavailableError);
  });
});
