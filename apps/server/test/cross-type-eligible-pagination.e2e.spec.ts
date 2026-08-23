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

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { ensureTestDatabase } from "@loombre/db";
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
}, 60_000);

afterAll(async () => {
  await app?.close();
  delete process.env["LOOMBRE_RATE_SEARCH"];
});

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
