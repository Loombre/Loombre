// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/video.controller.ts
//
// GET /movies, /movies/{id}, /series, /series/{id}, /series/{id}/seasons,
// /seasons/{id}/episodes, /episodes/{id} (mission deliverable, catalog-video
// tag in packages/contract/openapi.yaml). Every read goes through
// @loombre/db's getCatalogDetail/listCatalogItems (CLAUDE.md invariant 4) —
// this controller never imports pg/kysely (dependency-cruiser would fail
// the build if it tried). ViewerContext + a DB handle come from
// apps/server/src/common (see that module's header for why catalog/ can
// import common/ but not session/).
//
// 404 semantics (mission spec): invisible-vs-nonexistent is genuinely
// indistinguishable from getCatalogDetail's return value alone (undefined
// either way) — every not-found response here uses the SAME notFound()
// helper with a fixed, generic detail string per entity kind, so a
// restricted-and-uncleared id and a random UUID produce byte-identical
// problem+json bodies (apart from `instance`).

import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { getCatalogDetail, listCatalogItems } from "@loombre/db";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { resolveViewer, parseListQuery } from "./viewer.js";
import { mapMovie, mapSeries, mapSeason, mapEpisode } from "./mappers.js";

@Controller()
export class VideoController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  @Get("movies")
  async listMovies(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit, libraryId, sort, order } = parseListQuery(query);
    const page = await listCatalogItems(this.dbProvider.db, ctx, {
      itemType: "movie",
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(libraryId !== undefined ? { libraryId } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(order !== undefined ? { order } : {}),
    });
    return { items: page.rows.map(mapMovie), nextCursor: page.nextCursor };
  }

  @Get("movies/:id")
  async getMovie(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Movie not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const detail = await getCatalogDetail(this.dbProvider.db, ctx, id, { includeDetail: true });
    if (!detail || detail.item_type !== "movie") {
      throw notFound("Movie not found.", req.originalUrl);
    }
    return mapMovie(detail);
  }

  @Get("series")
  async listSeries(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit, libraryId, sort, order } = parseListQuery(query);
    const page = await listCatalogItems(this.dbProvider.db, ctx, {
      itemType: "series",
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(libraryId !== undefined ? { libraryId } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(order !== undefined ? { order } : {}),
    });
    return { items: page.rows.map(mapSeries), nextCursor: page.nextCursor };
  }

  @Get("series/:id")
  async getSeries(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Series not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const detail = await getCatalogDetail(this.dbProvider.db, ctx, id, { includeDetail: true });
    if (!detail || detail.item_type !== "series") {
      throw notFound("Series not found.", req.originalUrl);
    }
    return mapSeries(detail);
  }

  @Get("series/:id/seasons")
  async listSeriesSeasons(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Series not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const series = await getCatalogDetail(this.dbProvider.db, ctx, id);
    if (!series || series.item_type !== "series") {
      throw notFound("Series not found.", req.originalUrl);
    }
    const { cursor, limit } = parseListQuery(query);
    const page = await listCatalogItems(this.dbProvider.db, ctx, {
      itemType: "season",
      parentId: id,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { items: page.rows.map(mapSeason), nextCursor: page.nextCursor };
  }

  @Get("seasons/:id/episodes")
  async listSeasonEpisodes(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Season not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const season = await getCatalogDetail(this.dbProvider.db, ctx, id);
    if (!season || season.item_type !== "season") {
      throw notFound("Season not found.", req.originalUrl);
    }
    const { cursor, limit } = parseListQuery(query);
    const page = await listCatalogItems(this.dbProvider.db, ctx, {
      itemType: "episode",
      parentId: id,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { items: page.rows.map(mapEpisode), nextCursor: page.nextCursor };
  }

  @Get("episodes/:id")
  async getEpisode(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Episode not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const detail = await getCatalogDetail(this.dbProvider.db, ctx, id, { includeDetail: true });
    if (!detail || detail.item_type !== "episode") {
      throw notFound("Episode not found.", req.originalUrl);
    }
    return mapEpisode(detail);
  }
}
