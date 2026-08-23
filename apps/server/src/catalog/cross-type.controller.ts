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
// itemType are excluded rather than widening the contract. This matches
// realistic media-browser UX (a standalone season/episode is not usually
// what a "search results" or "recently added" row shows) and keeps every
// response Ajv-valid against the closed discriminator.
//
// Remediation adi-F2 — WHERE that subset is applied is load-bearing. It
// used to be a `.filter()` over the page the query layer had ALREADY cut,
// so the keyset LIMIT was spent on rows this handler then discarded: pages
// came back short, and at ?limit=1 routinely EMPTY, while `nextCursor`
// kept advancing (a client using the usual "empty page means exhausted"
// convention truncated the rail at page 0). The eligible set is now a
// query PARAMETER (`itemTypes`, packages/db/src/query/{items,search}.ts),
// so the database pages over eligible rows only and `limit` means "up to N
// items you can actually use". Keep the two constants below as the single
// source of that subset — if a contract discriminator gains a type, this
// is the one place to widen. continue-watching is deliberately OUT of
// adi-F2's scope (the finding names /search and /home/recently-added) and
// still post-filters to movie/episode/track below: `progress` accepts a
// row for ANY visible item id (progress.controller.ts's PUT does not check
// item_type), so that rail can short-page the same way and is logged as a
// separate finding — the fix shape there is this same `itemTypes` param on
// getContinueWatching.

import { Controller, Get, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
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
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { resolveViewer, parseListQuery } from "./viewer.js";
import { mapByType } from "./mappers.js";

/** The itemTypes packages/contract/openapi.yaml's `SearchResult.item`
 *  discriminator admits — passed INTO the query so pages are cut over
 *  eligible rows only (adi-F2). */
const SEARCH_ELIGIBLE_TYPES: readonly ItemType[] = ["movie", "series", "artist", "album", "track"];

/** Likewise for `RecentlyAddedEntry.item` (adi-F2). */
const RECENTLY_ADDED_ELIGIBLE_TYPES: readonly ItemType[] = ["movie", "series", "album"];

/** ContinueWatchingEntry.item's subset. NOT pushed into the query — see
 *  this file's header (adi-F2 scope note). */
const CONTINUE_WATCHING_ELIGIBLE_TYPES: readonly ItemType[] = ["movie", "episode", "track"];

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class CrossTypeController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  // Fix Wave 3 (audit fafa47f, AUD-A7d-002): this endpoint carried NO
  // rate limiter at all despite an N+1 getCatalogDetail fetch per row
  // below — one shared "search" bucket with restricted-zone.controller.ts's
  // own GET /restricted/search, per-identity, generous ceiling (typeahead
  // bursts are normal use), mirroring images.controller.ts's
  // @RateLimit precedent.
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("search", "identity")
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
      itemTypes: SEARCH_ELIGIBLE_TYPES,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    const rows = result.rows;
    const details = await Promise.all(rows.map((r) => getCatalogDetail(this.dbProvider.db, ctx, r.id)));

    // The remaining filter is NOT the type filter (that is `itemTypes`
    // above, applied before the page was cut) — it drops a row whose
    // detail read came back undefined, which after a guarded page means
    // the item was deleted between the two reads. A rare race, not a
    // systematic shortening.
    const items = rows
      .map((r, i) => ({ row: r, detail: details[i] }))
      .filter((x): x is { row: (typeof rows)[number]; detail: CatalogDetail } => x.detail !== undefined)
      .map(({ row, detail }) => ({ itemType: row.itemType, item: mapByType(row.itemType, detail) }));

    return { items, nextCursor: result.nextCursor };
  }

  @Get("home/continue-watching")
  async continueWatching(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await getContinueWatching(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    const eligible = page.rows.filter((r) => CONTINUE_WATCHING_ELIGIBLE_TYPES.includes(r.itemType));
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

    // Remediation adi-F1: `nextCursor` is the QUERY page's cursor, never
    // one derived from `items` — the itemType/detail filtering above can
    // shrink a page, and pagination must keep advancing over the rows the
    // database actually returned (exactly what search/recentlyAdded either
    // side of this handler do). Before this fix the handler destructured
    // only `{ limit }` and returned a hardcoded `nextCursor: null`, so
    // `?limit=1` made every later entry unreachable and `?cursor=…` was
    // silently ignored instead of 422'ing via MalformedCursorError.
    return { items, nextCursor: page.nextCursor };
  }

  @Get("home/recently-added")
  async recentlyAdded(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await getRecentlyAdded(this.dbProvider.db, ctx, {
      itemTypes: RECENTLY_ADDED_ELIGIBLE_TYPES,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    const rows = page.rows;
    const details = await Promise.all(rows.map((r) => getCatalogDetail(this.dbProvider.db, ctx, r.id)));

    // Detail-race filter only — see the same block in search() above.
    const items = rows
      .map((r, i) => ({ row: r, detail: details[i] }))
      .filter((x): x is { row: (typeof rows)[number]; detail: CatalogDetail } => x.detail !== undefined)
      .map(({ row, detail }) => ({ itemType: row.item_type, item: mapByType(row.item_type, detail) }));

    return { items, nextCursor: page.nextCursor };
  }
}
