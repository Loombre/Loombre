// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/chapters.controller.ts
//
// GET /items/{id}/chapters (STATE.md Stash run, S7/K9, Lane E) — the
// generic, content-agnostic twin GET /restricted/scenes/{id} embeds
// inline. Follows the exact house pattern video.controller.ts's
// series/{id}/seasons and seasons/{id}/episodes already establish for an
// item-scoped sub-resource: requireUuidParam FIRST (before any DB touch),
// then the guarded query, then notFound() for undefined — the SAME
// notFound() detail string a direct GET on the item itself would use, so
// a restricted-and-uncleared id and a random UUID produce byte-identical
// problem+json bodies (mission spec).

import { Controller, Get, Param, Req } from "@nestjs/common";
import { getChaptersForItem } from "@loombre/db";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { resolveViewerRestrictedSurface } from "./viewer.js";

@Controller()
export class ChaptersController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  @Get("items/:id/chapters")
  async getChapters(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Item not found.", req.originalUrl);
    const ctx = await resolveViewerRestrictedSurface(this.viewerContextProvider, req);
    const chapters = await getChaptersForItem(this.dbProvider.db, ctx, id);
    if (!chapters) {
      throw notFound("Item not found.", req.originalUrl);
    }
    return { items: chapters };
  }
}
