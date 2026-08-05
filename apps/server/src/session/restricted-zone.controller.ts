// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/session/restricted-zone.controller.ts
//
// STATE.md Stash run (S9/K4): GET /restricted/home, /restricted/browse,
// /restricted/scenes/{id}, /restricted/performers(+/{id},+/{id}/scenes),
// /restricted/studios(+/{id}), /restricted/search — the dedicated zone
// surface's real, guarded, keyset-paginated reads that SUPERSEDE the old
// "fetch the whole list client-side" GET /restricted/items design (K4;
// see restricted.controller.ts, which now carries only unlock/lock/count).
//
// Lives in session/ (not catalog/), parallel to restricted.controller.ts:
// session/ must never import catalog/ (D2, dependency-cruiser-enforced),
// and every function this controller needs (ViewerContextProvider,
// @loombre/db's restricted-zone query modules, notFound()) is already
// reachable from here without crossing that boundary — restricted.
// controller.ts's own header documents the identical "local resolveViewer
// equivalent, session/ can't import catalog/'s copy" posture this file
// repeats for the exact same reason.
//
// Entitlement -> HTTP mapping, uniform across every op below: every
// packages/db restricted-zone query function returns `undefined` for a
// viewer with NO restricted-library entitlement at all (gates 1-4 never
// all passed) — mapped to 404 here, same "the zone does not exist for
// this viewer" posture GET /restricted/count already established (U10).
// An entitled-but-LOCKED viewer (gate 5 not currently passed) gets a REAL
// response (200) that is simply empty/all-null where restricted content
// would appear — that distinction lives entirely inside packages/db's
// applyGuard, never re-derived here.
//
// Byte-identical 404 (GET /restricted/scenes/{id}, /performers/{id},
// /studios/{id}): getRestrictedSceneDetail/getRestrictedPerformerById/
// getRestrictedStudioById already fold "does not exist", "wrong item
// type/role/kind", and "exists but not visible to ctx" into the SAME
// `undefined` — this controller maps every one of those to the identical
// notFound() call, matching GET /movies/{id}'s house pattern.

import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import {
  getRestrictedPerformerById,
  getRestrictedSceneDetail,
  getRestrictedStudioById,
  getRestrictedZoneHome,
  listRestrictedBrowse,
  listRestrictedPerformerScenes,
  listRestrictedPerformers,
  listRestrictedStudios,
  resolveEntitledRestrictedLibraryIds,
  searchRestrictedZone,
  type RestrictedBrowseFilterParams,
  type RestrictedBrowseItemRow,
  type RestrictedBrowseOrder,
  type RestrictedBrowseSort,
  type RestrictedPerformerRow,
  type RestrictedResolutionBand,
  type RestrictedSceneDetail,
  type RestrictedStudioRow,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { parseLimitParam } from "../common/limit-param.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";

// ============================================================================
// Query-param parsing
// ============================================================================

/** Splits a comma-separated query param into trimmed, non-empty segments —
 *  deliberately NOT filtering out non-uuid-shaped entries here: the house
 *  rule (packages/db/src/query/restricted-browse.ts, catalog-detail.ts:
 *  741-751's precedent) is that a malformed filter id answers with an
 *  EMPTY PAGE from the query layer, never a silently dropped filter — that
 *  check belongs in listRestrictedBrowse itself (allUuids), not duplicated
 *  (and potentially drifting) here. */
function parseCsv(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function parseNumberParam(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}


const VALID_RESOLUTION_BANDS: ReadonlySet<string> = new Set<RestrictedResolutionBand>(["SD", "HD", "FHD", "UHD"]);

function parseResolutionBands(raw: unknown): RestrictedResolutionBand[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const bands = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is RestrictedResolutionBand => VALID_RESOLUTION_BANDS.has(s));
  return bands.length > 0 ? bands : undefined;
}

const VALID_SORTS: ReadonlySet<string> = new Set<RestrictedBrowseSort>(["added", "date", "title", "rating", "duration"]);
const VALID_ORDERS: ReadonlySet<string> = new Set<RestrictedBrowseOrder>(["asc", "desc"]);

interface ParsedBrowseQuery extends RestrictedBrowseFilterParams {
  cursor?: string;
  limit?: number;
  sort?: RestrictedBrowseSort;
  order?: RestrictedBrowseOrder;
}

function parseBrowseQuery(query: Record<string, unknown>): ParsedBrowseQuery {
  const result: ParsedBrowseQuery = {};
  if (typeof query["cursor"] === "string") result.cursor = query["cursor"];
  const limit = parseLimitParam(query["limit"]);
  if (limit !== undefined) result.limit = limit;
  if (typeof query["sort"] === "string" && VALID_SORTS.has(query["sort"])) {
    result.sort = query["sort"] as RestrictedBrowseSort;
  }
  if (typeof query["order"] === "string" && VALID_ORDERS.has(query["order"])) {
    result.order = query["order"] as RestrictedBrowseOrder;
  }

  const performerIds = parseCsv(query["performerIds"]);
  if (performerIds) result.performerIds = performerIds;
  const studioTagIds = parseCsv(query["studioTagIds"]);
  if (studioTagIds) result.studioTagIds = studioTagIds;
  const tagIds = parseCsv(query["tagIds"]);
  if (tagIds) result.tagIds = tagIds;

  const ratingMin = parseNumberParam(query["ratingMin"]);
  if (ratingMin !== undefined) result.ratingMin = ratingMin;
  const ratingMax = parseNumberParam(query["ratingMax"]);
  if (ratingMax !== undefined) result.ratingMax = ratingMax;
  const durationMinMs = parseNumberParam(query["durationMinMs"]);
  if (durationMinMs !== undefined) result.durationMinMs = durationMinMs;
  const durationMaxMs = parseNumberParam(query["durationMaxMs"]);
  if (durationMaxMs !== undefined) result.durationMaxMs = durationMaxMs;
  const yearMin = parseNumberParam(query["yearMin"]);
  if (yearMin !== undefined) result.yearMin = yearMin;
  const yearMax = parseNumberParam(query["yearMax"]);
  if (yearMax !== undefined) result.yearMax = yearMax;

  const resolution = parseResolutionBands(query["resolution"]);
  if (resolution) result.resolution = resolution;

  return result;
}

function parseCursorLimit(query: Record<string, unknown>): { cursor?: string; limit?: number } {
  const result: { cursor?: string; limit?: number } = {};
  if (typeof query["cursor"] === "string") result.cursor = query["cursor"];
  const limit = parseLimitParam(query["limit"]);
  if (limit !== undefined) result.limit = limit;
  return result;
}

// ============================================================================
// DB row -> wire DTO mapping
// ============================================================================

function toQualityDto(resolution: RestrictedResolutionBand | null, hdr: string | null) {
  return { is4k: resolution === "UHD", hdr: hdr ?? "none", resolution };
}

function toBrowseItemDto(row: RestrictedBrowseItemRow) {
  return {
    id: row.id,
    libraryId: row.libraryId,
    itemType: "movie" as const,
    title: row.title,
    sortTitle: row.sortTitle,
    year: row.year,
    communityRating: row.communityRating,
    contentClass: row.contentClass,
    addedAtMs: row.addedAtMs,
    updatedAtMs: row.updatedAtMs,
    premiereAtMs: row.premiereAtMs,
    durationMs: row.durationMs,
    genres: row.genres,
    images: row.images,
    quality: toQualityDto(row.resolution, row.hdr),
    studio: row.studio,
  };
}

function toSceneDto(detail: RestrictedSceneDetail) {
  return {
    id: detail.id,
    libraryId: detail.libraryId,
    itemType: "movie" as const,
    title: detail.title,
    sortTitle: detail.sortTitle,
    year: detail.year,
    communityRating: detail.communityRating,
    contentClass: detail.contentClass,
    addedAtMs: detail.addedAtMs,
    updatedAtMs: detail.updatedAtMs,
    premiereAtMs: detail.premiereAtMs,
    contentRating: detail.contentRating,
    runtimeMs: detail.runtimeMs,
    durationMs: detail.durationMs,
    overview: detail.overview,
    tagline: detail.tagline,
    tags: detail.tags,
    studio: detail.studio,
    performers: detail.performers,
    images: detail.images,
    markers: detail.chapters.map((c) => ({ id: c.id, title: c.title, startMs: c.startMs })),
    progress: detail.progress,
    quality: toQualityDto(detail.resolution, detail.hdr),
  };
}

function toPerformerDto(row: RestrictedPerformerRow) {
  return { id: row.id, name: row.name, contentClass: row.contentClass, sceneCount: row.sceneCount, images: row.images };
}

function toStudioDto(row: RestrictedStudioRow) {
  return { id: row.id, name: row.name, contentClass: row.contentClass, sceneCount: row.sceneCount, images: row.images };
}

@Controller("restricted")
export class RestrictedZoneController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  private async resolveCtx(req: AuthenticatedRequest) {
    return this.viewerContextProvider.resolve(req.user!.userId, clockNowMs());
  }

  // GET /restricted/items — DEPRECATED (contract: `deprecated: true`,
  // CLAUDE.md's additive-only evolution policy: a removed operation is
  // deprecated for a release window, never hard-deleted mid-major — see
  // openapi.yaml's own comment on this op for the oasdiff finding this
  // closes). Thin delegation to listRestrictedBrowse (the SAME query, no
  // filters, `added`-sorted — the old endpoint's implicit order) rather
  // than a second, divergent implementation kept alive. No `Sunset` value
  // is set yet (no removal date decided) — the header stays absent, which
  // the contract's response schema permits (not `required`).
  @Get("items")
  async legacyItems(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await this.resolveCtx(req);
    const { cursor, limit } = parseCursorLimit(query);
    const page = await listRestrictedBrowse(this.dbProvider.db, ctx, {
      sort: "added",
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!page) {
      throw notFound("Not found.", req.originalUrl);
    }
    return { items: page.rows.map(toBrowseItemDto), nextCursor: page.nextCursor };
  }

  @Get("home")
  async home(@Req() req: AuthenticatedRequest) {
    const ctx = await this.resolveCtx(req);
    const home = await getRestrictedZoneHome(this.dbProvider.db, ctx);
    if (!home) {
      throw notFound("Not found.", req.originalUrl);
    }
    return {
      continueWatchingInZone: home.continueWatchingInZone.map((entry) => ({
        item: toBrowseItemDto(entry.item),
        progress: entry.progress,
      })),
      recentlyAddedInZone: home.recentlyAddedInZone.map(toBrowseItemDto),
      studios: home.studios.map(toStudioDto),
      performers: home.performers.map(toPerformerDto),
    };
  }

  @Get("browse")
  async browse(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await this.resolveCtx(req);
    const params = parseBrowseQuery(query);
    const page = await listRestrictedBrowse(this.dbProvider.db, ctx, params);
    if (!page) {
      throw notFound("Not found.", req.originalUrl);
    }
    return { items: page.rows.map(toBrowseItemDto), nextCursor: page.nextCursor };
  }

  @Get("scenes/:id")
  async scene(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Not found.", req.originalUrl);
    const ctx = await this.resolveCtx(req);
    const detail = await getRestrictedSceneDetail(this.dbProvider.db, ctx, id);
    if (!detail) {
      throw notFound("Not found.", req.originalUrl);
    }
    return toSceneDto(detail);
  }

  @Get("performers")
  async performers(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await this.resolveCtx(req);
    const { cursor, limit } = parseCursorLimit(query);
    const q = typeof query["q"] === "string" ? query["q"] : undefined;
    const page = await listRestrictedPerformers(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(q !== undefined ? { q } : {}),
    });
    if (!page) {
      throw notFound("Not found.", req.originalUrl);
    }
    return { items: page.rows.map(toPerformerDto), nextCursor: page.nextCursor };
  }

  @Get("performers/:id")
  async performer(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Not found.", req.originalUrl);
    const ctx = await this.resolveCtx(req);
    const performer = await getRestrictedPerformerById(this.dbProvider.db, ctx, id);
    if (!performer) {
      throw notFound("Not found.", req.originalUrl);
    }
    return toPerformerDto(performer);
  }

  @Get("performers/:id/scenes")
  async performerScenes(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Not found.", req.originalUrl);
    const ctx = await this.resolveCtx(req);
    const { cursor, limit } = parseCursorLimit(query);
    const page = await listRestrictedPerformerScenes(this.dbProvider.db, ctx, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!page) {
      throw notFound("Not found.", req.originalUrl);
    }
    return { items: page.rows.map(toBrowseItemDto), nextCursor: page.nextCursor };
  }

  @Get("studios")
  async studios(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await this.resolveCtx(req);
    const { cursor, limit } = parseCursorLimit(query);
    const q = typeof query["q"] === "string" ? query["q"] : undefined;
    const page = await listRestrictedStudios(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(q !== undefined ? { q } : {}),
    });
    if (!page) {
      throw notFound("Not found.", req.originalUrl);
    }
    return { items: page.rows.map(toStudioDto), nextCursor: page.nextCursor };
  }

  @Get("studios/:id")
  async studio(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Not found.", req.originalUrl);
    const ctx = await this.resolveCtx(req);
    const studio = await getRestrictedStudioById(this.dbProvider.db, ctx, id);
    if (!studio) {
      throw notFound("Not found.", req.originalUrl);
    }
    return toStudioDto(studio);
  }

  // Entitlement is checked BEFORE `q` (undefined page -> 404 wins over a
  // missing-q 422) — see this file's header and the contract op's own
  // description for why: the zone's non-existence for an unentitled viewer
  // must never depend on whether they also happened to omit `q`.
  @Get("search")
  async search(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await this.resolveCtx(req);
    const { cursor, limit } = parseCursorLimit(query);
    const qRaw = query["q"];

    // A missing/empty q still needs an entitlement check first (see
    // header) — resolveEntitledRestrictedLibraryIds is the SAME resolver
    // searchRestrictedZone itself calls internally, so this never drifts
    // from the real op's own entitlement answer.
    if (typeof qRaw !== "string" || qRaw.length === 0) {
      const restrictedLibraryIds = await resolveEntitledRestrictedLibraryIds(this.dbProvider.db, ctx);
      if (restrictedLibraryIds.length === 0) {
        throw notFound("Not found.", req.originalUrl);
      }
      throw unprocessableEntity("q is required.", req.originalUrl);
    }

    const page = await searchRestrictedZone(this.dbProvider.db, ctx, {
      q: qRaw,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!page) {
      throw notFound("Not found.", req.originalUrl);
    }
    return { items: page.rows.map(toBrowseItemDto), nextCursor: page.nextCursor };
  }
}
