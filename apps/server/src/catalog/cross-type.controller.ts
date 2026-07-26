// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/cross-type.controller.ts
//
// GET /search, /home/continue-watching, /home/recently-added.
//
// DECISION BEYOND SPEC (all three): the guarded query layer's search/
// continue-watching/recently-added functions return LIGHTWEIGHT rows (ids +
// a few denormalized fields — see packages/db/src/query/{search,progress,
// items}.ts) — enough to rank/order/scope, not enough to satisfy the
// contract's SearchResult/ContinueWatchingEntry/RecentlyAddedEntry schemas,
// which each embed a FULL discriminated Movie/Series/Artist/Album/Track (or
// Episode) object. This controller enriches each page's rows with
// getCatalogDetail(db, ctx, id) (one extra guarded call per row — Phase 1
// scale, not a Tier-0 request-path CPU concern, just extra guarded reads).
//
// The three response schemas' `item` discriminator each cover ONLY A
// SUBSET of ItemType (SearchResult: movie/series/artist/album/track, no
// season/episode; ContinueWatchingEntry: movie/episode/track only;
// RecentlyAddedEntry: movie/series/album only) — hits of any other
// itemType are silently excluded from the mapped response rather than
// widening the contract. This matches realistic media-browser UX (a
// standalone season/episode is not usually what a "search results" or
// "recently added" row shows) and keeps every response Ajv-valid against
// the closed discriminator.

import { Controller, Get, Query, Req } from "@nestjs/common";
import {
  getCatalogDetail,
  getContinueWatching,
  getRecentlyAdded,
  searchCatalog,
  type CatalogDetail,
  type ItemType,
} from "@loombre/db";
import { unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { resolveViewer, parseListQuery } from "./viewer.js";
import { mapByType } from "./mappers.js";

@Controller()
export class CrossTypeController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  @Get("search")
  async search(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const q = typeof query["q"] === "string" ? query["q"] : "";
    if (q.length === 0) {
      throw unprocessableEntity("q is required and must be non-empty.", req.originalUrl);
    }
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const result = await searchCatalog(this.dbProvider.db, ctx, {
      q,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    const eligible = result.rows.filter((r) =>
      (["movie", "series", "artist", "album", "track"] as ItemType[]).includes(r.itemType),
    );
    const details = await Promise.all(eligible.map((r) => getCatalogDetail(this.dbProvider.db, ctx, r.id)));

    const items = eligible
      .map((r, i) => ({ row: r, detail: details[i] }))
      .filter((x): x is { row: (typeof eligible)[number]; detail: CatalogDetail } => x.detail !== undefined)
      .map(({ row, detail }) => ({ itemType: row.itemType, item: mapByType(row.itemType, detail) }));

    return { items, nextCursor: result.nextCursor };
  }

  @Get("home/continue-watching")
  async continueWatching(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { limit } = parseListQuery(query);
    const rows = await getContinueWatching(this.dbProvider.db, ctx, limit !== undefined ? { limit } : {});

    const eligible = rows.filter((r) => (["movie", "episode", "track"] as ItemType[]).includes(r.itemType));
    const details = await Promise.all(eligible.map((r) => getCatalogDetail(this.dbProvider.db, ctx, r.itemId)));

    const items = eligible
      .map((r, i) => ({ row: r, detail: details[i] }))
      .filter((x): x is { row: (typeof eligible)[number]; detail: CatalogDetail } => x.detail !== undefined)
      .map(({ row, detail }) => ({
        itemType: row.itemType,
        item: mapByType(row.itemType, detail),
        progress: {
          itemId: row.itemId,
          positionMs: row.positionMs,
          state: row.state,
          playCount: row.playCount,
          updatedAtMs: row.updatedAtMs,
        },
      }));

    return { items, nextCursor: null };
  }

  @Get("home/recently-added")
  async recentlyAdded(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await getRecentlyAdded(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    const eligible = page.rows.filter((r) => (["movie", "series", "album"] as ItemType[]).includes(r.item_type));
    const details = await Promise.all(eligible.map((r) => getCatalogDetail(this.dbProvider.db, ctx, r.id)));

    const items = eligible
      .map((r, i) => ({ row: r, detail: details[i] }))
      .filter((x): x is { row: (typeof eligible)[number]; detail: CatalogDetail } => x.detail !== undefined)
      .map(({ row, detail }) => ({ itemType: row.item_type, item: mapByType(row.item_type, detail) }));

    return { items, nextCursor: page.nextCursor };
  }
}
