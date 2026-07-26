// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/music.controller.ts
//
// GET /artists, /artists/{id}, /artists/{id}/albums, /albums/{id},
// /albums/{id}/tracks, /tracks/{id} — the music-side analogue of
// video.controller.ts; see that file's header for the shared conventions
// (404 semantics, ViewerContext resolution, guard-only DB access).

import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { getCatalogDetail, listCatalogItems } from "@loombre/db";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { resolveViewer, parseListQuery } from "./viewer.js";
import { mapArtist, mapAlbum, mapTrack } from "./mappers.js";

@Controller()
export class MusicController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  @Get("artists")
  async listArtists(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit, libraryId, sort, order } = parseListQuery(query);
    const page = await listCatalogItems(this.dbProvider.db, ctx, {
      itemType: "artist",
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(libraryId !== undefined ? { libraryId } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(order !== undefined ? { order } : {}),
    });
    return { items: page.rows.map(mapArtist), nextCursor: page.nextCursor };
  }

  @Get("artists/:id")
  async getArtist(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Artist not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const detail = await getCatalogDetail(this.dbProvider.db, ctx, id, { includeDetail: true });
    if (!detail || detail.item_type !== "artist") {
      throw notFound("Artist not found.", req.originalUrl);
    }
    return mapArtist(detail);
  }

  @Get("artists/:id/albums")
  async listArtistAlbums(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Artist not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const artist = await getCatalogDetail(this.dbProvider.db, ctx, id);
    if (!artist || artist.item_type !== "artist") {
      throw notFound("Artist not found.", req.originalUrl);
    }
    const { cursor, limit, sort, order } = parseListQuery(query);
    const page = await listCatalogItems(this.dbProvider.db, ctx, {
      itemType: "album",
      parentId: id,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(order !== undefined ? { order } : {}),
    });
    return { items: page.rows.map(mapAlbum), nextCursor: page.nextCursor };
  }

  @Get("albums/:id")
  async getAlbum(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Album not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const detail = await getCatalogDetail(this.dbProvider.db, ctx, id);
    if (!detail || detail.item_type !== "album") {
      throw notFound("Album not found.", req.originalUrl);
    }
    return mapAlbum(detail);
  }

  @Get("albums/:id/tracks")
  async listAlbumTracks(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Album not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const album = await getCatalogDetail(this.dbProvider.db, ctx, id);
    if (!album || album.item_type !== "album") {
      throw notFound("Album not found.", req.originalUrl);
    }
    const { cursor, limit, sort, order } = parseListQuery(query);
    const page = await listCatalogItems(this.dbProvider.db, ctx, {
      itemType: "track",
      parentId: id,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(order !== undefined ? { order } : {}),
    });
    return { items: page.rows.map(mapTrack), nextCursor: page.nextCursor };
  }

  @Get("tracks/:id")
  async getTrack(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Track not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const detail = await getCatalogDetail(this.dbProvider.db, ctx, id, { includeDetail: true });
    if (!detail || detail.item_type !== "track") {
      throw notFound("Track not found.", req.originalUrl);
    }
    return mapTrack(detail);
  }
}
