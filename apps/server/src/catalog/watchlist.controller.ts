// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/watchlist.controller.ts
//
// GET /watchlist, PUT /watchlist/{itemId}, DELETE /watchlist/{itemId}
// (Phosphor Wave 2 lane L3 — design/phosphor/README.md's Watchlist screen,
// Home "Your Watchlist" rail, and the movie/series/album detail-screen
// toggle). Guard semantics live entirely in packages/db/src/query/
// watchlist.ts; this controller only enriches the lightweight guarded rows
// with full item detail and maps them to the contract's WatchlistEntry
// discriminator — the SAME "eligible + getCatalogDetail + mapByType"
// pattern cross-type.controller.ts's recentlyAdded/continueWatching/search
// handlers already establish (see mappers.ts).

import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Put, Query, Req } from "@nestjs/common";
import {
  addToWatchlistAndEmit,
  getCatalogDetail,
  listWatchlist,
  removeFromWatchlistAndEmit,
  type CatalogDetail,
  type ItemType,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { resolveViewer, parseListQuery } from "./viewer.js";
import { mapByType } from "./mappers.js";

// The only itemTypes the toggle can ever add (design/phosphor README.md:
// movie/series/album detail screens) — mirrors RecentlyAddedEntry's own
// eligible-type filter exactly; any other type is silently excluded from
// the mapped page rather than widening WatchlistEntry's discriminator for a
// shape no real UI path produces.
const ELIGIBLE_ITEM_TYPES: readonly ItemType[] = ["movie", "series", "album"];

@Controller()
export class WatchlistController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  @Get("watchlist")
  async listWatchlist(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await listWatchlist(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    // Enrich each guarded row with full detail, same pattern as
    // cross-type.controller.ts's recentlyAdded — getCatalogDetail
    // independently re-derives visibility (getItemById internally), so a
    // row that somehow became invisible between the two calls is simply
    // dropped rather than surfaced half-populated.
    const eligible = page.rows.filter((r) => ELIGIBLE_ITEM_TYPES.includes(r.itemType as ItemType));
    const details = await Promise.all(eligible.map((r) => getCatalogDetail(this.dbProvider.db, ctx, r.itemId)));

    const items = eligible
      .map((r, i) => ({ row: r, detail: details[i] }))
      .filter((x): x is { row: (typeof eligible)[number]; detail: CatalogDetail } => x.detail !== undefined)
      .map(({ row, detail }) => ({
        itemType: row.itemType,
        item: mapByType(row.itemType as ItemType, detail),
        addedAtMs: row.addedAtMs,
      }));

    return { items, nextCursor: page.nextCursor };
  }

  @Put("watchlist/:itemId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async addToWatchlist(@Param("itemId") itemId: string, @Req() req: AuthenticatedRequest): Promise<void> {
    requireUuidParam(itemId, "Item not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const result = await addToWatchlistAndEmit(this.dbProvider.db, ctx, itemId, clockNowMs());
    if (!result) {
      throw notFound("Item not found.", req.originalUrl);
    }
  }

  @Delete("watchlist/:itemId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeFromWatchlist(@Param("itemId") itemId: string, @Req() req: AuthenticatedRequest): Promise<void> {
    requireUuidParam(itemId, "Item not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const result = await removeFromWatchlistAndEmit(this.dbProvider.db, ctx, itemId, clockNowMs());
    if (!result) {
      throw notFound("Item not found.", req.originalUrl);
    }
  }
}
