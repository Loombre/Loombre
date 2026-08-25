// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/test/cross-type-eligible-pagination.e2e.spec.ts
//
// Remediation adi-F2: GET /search and GET /home/recently-added paginate in
// the DB over EVERY catalog item type, then filter the returned page down
// to the endpoint's schema-eligible subset in the controller — AFTER the
// page has been cut. `SearchResult`'s item discriminator covers
// movie/series/artist/album/track and `RecentlyAddedEntry`'s covers
// movie/series/album (packages/contract/openapi.yaml), so any DB page whose
// visible rows happen to be seasons/episodes/tracks came back SHORT, or
// completely EMPTY, while `nextCursor` kept advancing.
//
// Two consequences this suite pins:
//   1. `limit` must mean "up to N items you can actually use". A page that
//      advertises more (nextCursor !== null) is a FULL page.
//   2. `items: []` must never ship with a non-null `nextCursor` — the
//      common client convention is that an empty page means exhaustion, so
//      an empty page-0 (observed live at ?limit=1) truncates the rail
//      outright for any such client.
//
// The walk is run as CASUAL on purpose: seed.mjs inserts the six music
// tracks LAST among the rows a casual viewer can see (the four newer
// restricted movies are guard-invisible to them), so at ?limit=1 the very
// first recently-added page is one of those ineligible tracks — the exact
// live shape the report captured. Search uses q=the, which matches three
// EPISODES ("Static on the Line", "What the Radio Knew", "The Last
// Checkpoint") plus eligible rows, so its pages interleave the same way.
//
// Self-sufficient: own ensureTestDatabase suffix, own reset+reseed. The
// search rate limiter (60/min per identity, AUD-A7d-002) is raised for this
// file only — a limit=1 walk is intentionally many small requests.
//
// d3-b9 EXTENSION (B/adi-F2-followup): adi-F2 deliberately left the THIRD
// rail — GET /home/continue-watching — post-filtering its already-cut page,
// and logged it. The two describes at the end of this file close that:
//   1. the rail itself, with progress rows inserted DIRECTLY (a container
//      progress row is what shortens it, and such rows exist in real
//      databases regardless of what the write path accepts today), and
//   2. the write path — PUT /progress/{itemId} used to accept a progress
//      row for ANY visible item id, series and seasons included, which is
//      where those rows came from in the first place.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createDb, ensureTestDatabase } from "@loombre/db";
import { AppModule } from "../src/app.module.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG_ROOT = path.resolve(__dirname, "../../../packages/db");
const BASE_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://loombre:loombre@localhost:5442/loombre";

function run(script: string, args: string[], databaseUrl: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DB_PKG_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function buildDeviceProfile(profileId: string): Record<string, unknown> {
  return {
    profileId,
    directPlayContainers: ["mp4"],
    hls: { container: "fmp4", supportsFmp4: true, lowLatency: false },
    video: [],
    hdr: { hdr10: false, hlg: false, dolbyVision: false },
    audio: [],
    subtitles: { renderText: [], hlsVtt: true, renderImage: false },
    maxStreamBitrateBps: null,
  };
}

let app: INestApplication;
let casualToken: string;
let rawDb: ReturnType<typeof createDb>;
/** d3-b9 fixture ids, resolved from the API in beforeAll. */
const fixture: {
  seriesWithProgress?: string;
  seriesWithoutProgress?: string;
  seasonId?: string;
  movieIds: string[];
  episodeId?: string;
} = { movieIds: [] };

beforeAll(async () => {
  const databaseUrl = await ensureTestDatabase(BASE_DATABASE_URL, "cross_type_eligible_pages_test");
  run(path.join(DB_PKG_ROOT, "scripts", "migrate.mjs"), ["reset"], databaseUrl);
  run(path.join(DB_PKG_ROOT, "seed", "seed.mjs"), [], databaseUrl);

  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LOOMBRE_JWT_SECRET"] = "cross-type-eligible-pagination-test-secret";
  process.env["LOOMBRE_RATE_SEARCH"] = "100000";

  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const casualLogin = await request(app.getHttpServer()).post("/auth/login").send({
    username: "casual",
    password: "loombre-seed-casual",
    deviceName: "cross-type-eligible-casual",
    deviceProfile: buildDeviceProfile("cross-type-eligible-casual"),
  });
  expect(casualLogin.status, JSON.stringify(casualLogin.body)).toBe(200);
  casualToken = casualLogin.body.accessToken;

  rawDb = createDb(databaseUrl);
  await seedContinueWatchingFixture();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await rawDb?.destroy();
  delete process.env["LOOMBRE_RATE_SEARCH"];
});

/** d3-b9: resolves real ids through the API (so every one of them is
 *  provably VISIBLE to casual — the same guard the rail runs), then writes
 *  the progress rows straight to the table. Direct writes on purpose: the
 *  SERIES row is the shape that shortens the rail, and once d3-b9's write
 *  half lands the API refuses to create it — but rows written before that
 *  (or by any other client of an older build) are still there. Newest
 *  progress FIRST: series, movie, episode, movie. */
async function seedContinueWatchingFixture() {
  const series = await get("/series?limit=10");
  expect(series.status, JSON.stringify(series.body)).toBe(200);
  const seriesIds = series.body.items.map((s: { id: string }) => s.id);
  expect(seriesIds.length, "seed must expose at least two series to casual").toBeGreaterThanOrEqual(2);
  fixture.seriesWithProgress = seriesIds[0];
  fixture.seriesWithoutProgress = seriesIds[1];

  const seasons = await get(`/series/${fixture.seriesWithoutProgress}/seasons?limit=10`);
  expect(seasons.status, JSON.stringify(seasons.body)).toBe(200);
  fixture.seasonId = seasons.body.items[0]?.id;
  expect(fixture.seasonId, "seed must expose a season to casual").toBeTruthy();

  const episodes = await get(`/seasons/${fixture.seasonId}/episodes?limit=10`);
  expect(episodes.status, JSON.stringify(episodes.body)).toBe(200);
  fixture.episodeId = episodes.body.items[0]?.id;
  expect(fixture.episodeId, "seed must expose an episode to casual").toBeTruthy();

  const movies = await get("/movies?limit=10");
  expect(movies.status, JSON.stringify(movies.body)).toBe(200);
  fixture.movieIds = movies.body.items.map((m: { id: string }) => m.id).slice(0, 2);
  expect(fixture.movieIds.length, "seed must expose at least two movies to casual").toBe(2);

  const casual = await rawDb
    .selectFrom("users")
    .select("id")
    .where("username", "=", "casual")
    .executeTakeFirstOrThrow();

  const baseMs = 1_800_000_000_000;
  // Newest first — the rail orders on progress.updated_at_ms DESC.
  const rows = [
    fixture.seriesWithProgress!,
    fixture.movieIds[0]!,
    fixture.episodeId!,
    fixture.movieIds[1]!,
  ];
  for (const [rank, itemId] of rows.entries()) {
    await rawDb
      .insertInto("progress")
      .values({
        user_id: casual.id,
        item_id: itemId,
        position_ms: 30_000,
        state: "in-progress",
        play_count: 0,
        updated_at_ms: baseMs + (rows.length - rank) * 1000,
      })
      .execute();
  }
}

function get(url: string) {
  return request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${casualToken}`);
}

interface WalkedPage {
  index: number;
  count: number;
  nextCursor: string | null;
}

/** Follows `nextCursor` from page 0 until it is null, returning the ids seen
 *  in order plus a per-page shape record. `build` takes the cursor (null on
 *  page 0) and returns the URL to fetch. */
async function walk(
  build: (cursor: string | null) => string,
  idOf: (entry: { item: { id: string } }) => string,
  maxHops = 100,
): Promise<{ ids: string[]; pages: WalkedPage[] }> {
  const ids: string[] = [];
  const pages: WalkedPage[] = [];
  let cursor: string | null = null;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await get(build(cursor));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    ids.push(...res.body.items.map(idOf));
    pages.push({ index: hop, count: res.body.items.length, nextCursor: res.body.nextCursor });
    if (res.body.nextCursor === null) break;
    cursor = res.body.nextCursor;
  }
  expect(pages[pages.length - 1]!.nextCursor, "walk did not terminate within maxHops").toBeNull();
  return { ids, pages };
}

/** The invariant, stated once: a page that says "there is more" must be a
 *  FULL page of `limit` usable items. Pages are allowed to be short/empty
 *  ONLY as the terminal page (nextCursor === null) — that includes the
 *  trailing empty page a page-boundary-exact result set mints, which is
 *  listItems/listProgress's long-standing behaviour (see
 *  packages/db/test/continue-watching-cursor.spec.ts's last case). */
function pagesShortWhileAdvertisingMore(pages: WalkedPage[], limit: number): WalkedPage[] {
  return pages.filter((p) => p.nextCursor !== null && p.count !== limit);
}

const entryId = (entry: { item: { id: string } }) => entry.item.id;

const recentlyAddedUrl = (limit: number) => (cursor: string | null) =>
  cursor === null
    ? `/home/recently-added?limit=${limit}`
    : `/home/recently-added?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;

const searchUrl = (limit: number) => (cursor: string | null) =>
  cursor === null
    ? `/search?q=the&limit=${limit}`
    : `/search?q=the&limit=${limit}&cursor=${encodeURIComponent(cursor)}`;

describe("adi-F2: /home/recently-added pages are cut over ELIGIBLE types", () => {
  it("page 0 at ?limit=1 carries an item (the defect: the newest visible row is an ineligible track, so page 0 was empty)", async () => {
    const res = await get("/home/recently-added?limit=1");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("no page is EMPTY while nextCursor advertises more", async () => {
    const { pages } = await walk(recentlyAddedUrl(1), entryId);
    const empties = pages.filter((p) => p.nextCursor !== null && p.count === 0);
    expect(empties, `empty pages with a non-null nextCursor: ${JSON.stringify(empties)}`).toEqual([]);
  }, 30_000);

  it("?limit=N means N ELIGIBLE items: every page that advertises more is full (limit=1 and limit=3)", async () => {
    for (const limit of [1, 3]) {
      const { pages } = await walk(recentlyAddedUrl(limit), entryId);
      const short = pagesShortWhileAdvertisingMore(pages, limit);
      expect(short, `limit=${limit}: short pages that advertise more: ${JSON.stringify(short)}`).toEqual([]);
    }
  }, 30_000);

  it("the limit=1 walk still reaches every item an unpaginated read returns, in the same order", async () => {
    const all = await get("/home/recently-added?limit=200");
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const allIds = all.body.items.map(entryId);
    expect(allIds.length).toBeGreaterThan(2);

    const { ids } = await walk(recentlyAddedUrl(1), entryId);
    expect(ids).toEqual(allIds);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30_000);

  it("only movie/series/album ever appear (the eligible subset is unchanged by the fix)", async () => {
    const all = await get("/home/recently-added?limit=200");
    for (const entry of all.body.items) {
      expect(["movie", "series", "album"]).toContain(entry.itemType);
    }
  });
});

describe("adi-F2: /search pages are cut over ELIGIBLE types", () => {
  it("no page is EMPTY while nextCursor advertises more (q=the matches three ineligible EPISODES)", async () => {
    const { pages } = await walk(searchUrl(1), entryId);
    const empties = pages.filter((p) => p.nextCursor !== null && p.count === 0);
    expect(empties, `empty pages with a non-null nextCursor: ${JSON.stringify(empties)}`).toEqual([]);
  }, 30_000);

  it("?limit=N means N ELIGIBLE results: every page that advertises more is full", async () => {
    const { pages } = await walk(searchUrl(1), entryId);
    const short = pagesShortWhileAdvertisingMore(pages, 1);
    expect(short, `short pages that advertise more: ${JSON.stringify(short)}`).toEqual([]);
  }, 30_000);

  it("the limit=1 walk still reaches every result an unpaginated read returns, in the same order", async () => {
    const all = await get("/search?q=the&limit=200");
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const allIds = all.body.items.map(entryId);
    expect(allIds.length).toBeGreaterThan(1);

    const { ids } = await walk(searchUrl(1), entryId);
    expect(ids).toEqual(allIds);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30_000);

  it("season/episode never appear, and a title-matching eligible row still does", async () => {
    const all = await get("/search?q=the&limit=200");
    for (const entry of all.body.items) {
      expect(["movie", "series", "artist", "album", "track"]).toContain(entry.itemType);
    }
    expect(all.body.items.some((e: { item: { title: string } }) => e.item.title === "The Quiet Frontier")).toBe(true);
  });
});

const continueWatchingUrl = (limit: number) => (cursor: string | null) =>
  cursor === null
    ? `/home/continue-watching?limit=${limit}`
    : `/home/continue-watching?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;

describe("d3-b9: /home/continue-watching pages are cut over ELIGIBLE types", () => {
  it("page 0 at ?limit=1 carries an entry (the defect: the newest progress row is a SERIES, so page 0 was empty)", async () => {
    const res = await get("/home/continue-watching?limit=1");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].item.id).toBe(fixture.movieIds[0]);
  });

  it("no page is EMPTY while nextCursor advertises more", async () => {
    const { pages } = await walk(continueWatchingUrl(1), entryId);
    const empties = pages.filter((p) => p.nextCursor !== null && p.count === 0);
    expect(empties, `empty pages with a non-null nextCursor: ${JSON.stringify(empties)}`).toEqual([]);
  }, 30_000);

  it("?limit=N means N ELIGIBLE entries: every page that advertises more is full (limit=1 and limit=2)", async () => {
    for (const limit of [1, 2]) {
      const { pages } = await walk(continueWatchingUrl(limit), entryId);
      const short = pagesShortWhileAdvertisingMore(pages, limit);
      expect(short, `limit=${limit}: short pages that advertise more: ${JSON.stringify(short)}`).toEqual([]);
    }
  }, 30_000);

  it("the limit=1 walk reaches every entry an unpaginated read returns, in the same order", async () => {
    const all = await get("/home/continue-watching?limit=200");
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const allIds = all.body.items.map(entryId);
    // This fixture's rows carry the newest updated_at_ms, so they lead;
    // the seed's own in-progress rows follow (hence a prefix assertion,
    // not an exact list).
    expect(allIds.slice(0, 3)).toEqual([fixture.movieIds[0], fixture.episodeId, fixture.movieIds[1]]);

    const { ids } = await walk(continueWatchingUrl(1), entryId);
    expect(ids).toEqual(allIds);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30_000);

  it("only movie/episode/track ever appear (the eligible subset is unchanged by the fix)", async () => {
    const all = await get("/home/continue-watching?limit=200");
    for (const entry of all.body.items) {
      expect(["movie", "episode", "track"]).toContain(entry.itemType);
    }
  });
});

describe("d3-b9: PUT /progress/{itemId} refuses item types that cannot carry progress", () => {
  function put(itemId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .put(`/progress/${itemId}`)
      .set("Authorization", `Bearer ${casualToken}`)
      .set("content-type", "application/json")
      .send(body);
  }

  it("422s on a SERIES id and writes nothing (it used to 200 and mint the row that shortens the rail)", async () => {
    const res = await put(fixture.seriesWithoutProgress!, { positionMs: 1000, state: "in-progress" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(String(res.body.detail)).toMatch(/series/i);

    const read = await get(`/progress/${fixture.seriesWithoutProgress}`);
    expect(read.status, "no progress row may exist after a rejected write").toBe(404);
  });

  it("422s on a SEASON id too", async () => {
    const res = await put(fixture.seasonId!, { positionMs: 1000, state: "in-progress" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.detail)).toMatch(/season/i);
  });

  it("still 404s for an item that is invisible or nonexistent — existence never leaks through the new 422", async () => {
    const res = await put("11111111-1111-4111-8111-111111111111", { positionMs: 1000, state: "in-progress" });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("still 422s on a bad BODY before it ever looks the item up", async () => {
    const res = await put(fixture.movieIds[0]!, { state: "in-progress" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.detail)).toMatch(/positionMs/);
  });

  it("a movie/episode/track write still succeeds (the fix narrows nothing playable)", async () => {
    for (const itemId of [fixture.movieIds[0]!, fixture.episodeId!]) {
      const res = await put(itemId, { positionMs: 42_000, state: "in-progress" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.positionMs).toBe(42_000);
    }
  });
});
