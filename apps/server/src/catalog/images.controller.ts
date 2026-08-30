// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/images.controller.ts
//
// GET /images/{entityType}/{id}/{kind} — Tier-0 law (CLAUDE.md invariant 9):
// this handler does ZERO image CPU work. It picks among ALREADY pre-scaled
// `images` rows and streams bytes straight off disk.
//
// Authorization FIRST, always, before anything else (including the 304
// short-circuit) — getImageEntityAccess(db, ctx, ...) is the single choke-
// point (packages/db/src/query/images.ts); an empty result is
// indistinguishable from "entity doesn't exist" (mission spec) so every
// failure path below returns the SAME notFound() shape.
//
// entityType mapping: the contract's ImageEntityType enum (movie/series/
// season/episode/artist/album/track/person/tag) is a DIFFERENT vocabulary
// from @loombre/db's ImageEntityType ('catalog_item'|'person'|'tag'|
// 'library') — see packages/db/src/query/images.ts's header, which
// explicitly calls this mapping "the future image controller's job". Every
// contract value maps to 'catalog_item' EXCEPT 'person' (Phosphor Wave 2
// lane L3 addition, for the /people/[id] route's portrait) and 'tag'
// (STATE.md Stash run, S9: studio logos — a studio is a kind=studio tag,
// migrations/0019, and its logo is ingested at entity_type='tag'; packages/
// db's guard for this branch already existed, unreachable until now because
// this controller hardcoded 'catalog_item' regardless of the path param).
// `library` images remain unreachable via this REST path — the contract's
// enum still doesn't include that one value.
//
// Nearest-width selection: among rows for the requested kind, the largest
// width <= the requested `width` query param wins; if none qualify (all
// scaled variants are larger than requested, or no width was requested at
// all) the original (width IS NULL) row wins if present, else the smallest
// available scaled variant — see pickVariant() below.
//
// Format negotiation: DECISION BEYOND SPEC — the `images` table has ONE row
// per (entity, kind, width) with no separate format dimension (0001_init.sql
// UNIQUE constraint, migrations/0004's NULLS NOT DISTINCT fix) — there is
// no PER-FORMAT row to choose between yet (the image pipeline, apps/worker,
// writes one file per size). `format`/Accept therefore only influence the
// ADVERTISED Content-Type when it's unambiguous from the stored file's own
// extension; they cannot conjure a variant that was never ingested. True
// multi-format content negotiation is a future wave once ingest writes
// distinct format rows (or a format column is added — additive contract
// change, not attempted here).
//
// ETag = sha256(imageRow.id + ':' + imageRow.created_at_ms + ':' +
// clearanceDigest(ctx)).slice(0, 16) — mixing clearanceDigest in means a
// stale cached copy from a MORE-privileged past session can never be served
// via If-None-Match to a LESS-privileged current one (a 304 still requires
// re-running the authorization check above on every request, which this
// handler does unconditionally before ever comparing ETags).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Controller, Get, Param, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { clearanceDigest, getImageEntityAccess, type ImageRow } from "@loombre/db";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { AllowQueryToken } from "../gateway/allow-query-token.decorator.js";
import { sanitizeInstancePath } from "../gateway/sanitize-instance.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { resolveViewerRestrictedSurface } from "./viewer.js";

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

function pickVariant(rows: ImageRow[], requestedWidth: number | undefined): ImageRow | undefined {
  if (rows.length === 0) return undefined;
  const sized = rows.filter((r) => r.width !== null).sort((a, b) => (a.width as number) - (b.width as number));
  const original = rows.find((r) => r.width === null);

  if (requestedWidth === undefined) {
    return original ?? sized[sized.length - 1];
  }
  const candidates = sized.filter((r) => (r.width as number) <= requestedWidth);
  if (candidates.length > 0) return candidates[candidates.length - 1];
  return original ?? sized[0];
}

function computeEtag(row: ImageRow, ctxDigest: string): string {
  return createHash("sha256")
    .update(`${row.id}:${row.created_at_ms}:${ctxDigest}`)
    .digest("hex")
    .slice(0, 16);
}

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class ImagesController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  // STATE.md P4.15 (Phase 4 lane G1's rate-limit sweep): one of the four
  // `?token=` media GET families. per-identity (userId:deviceId), GENEROUS
  // ceiling (SurfaceRateLimiterService.mediaToken, default 600/min) — a
  // poster grid can fire dozens of concurrent image requests on one page
  // load/scroll; this must never be tight enough to be mistaken for a
  // browse-page regression.
  @AllowQueryToken()
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("mediaToken", "identity")
  @Get("images/:entityType/:id/:kind")
  async getImage(
    @Param("entityType") _entityType: string,
    @Param("id") id: string,
    @Param("kind") kind: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    requireUuidParam(id, "Image not found.", sanitizeInstancePath(req));
    const ctx = await resolveViewerRestrictedSurface(this.viewerContextProvider, req);

    // Every documented ImageEntityType value maps to the DB's
    // 'catalog_item' EXCEPT 'person' and 'tag' — see module header (STATE.md
    // Stash run, S9: studios are kind=studio tags with their logo stored at
    // entity_type='tag', migrations/0019). getImageEntityAccess itself is
    // the authorization choke-point; it runs unconditionally, before
    // anything else in this handler.
    const dbEntityType = _entityType === "person" ? "person" : _entityType === "tag" ? "tag" : "catalog_item";
    const rows = await getImageEntityAccess(this.dbProvider.db, ctx, {
      entityType: dbEntityType,
      entityId: id,
    });
    const forKind = rows.filter((r) => r.kind === kind);
    if (forKind.length === 0) {
      throw notFound("Image not found.", sanitizeInstancePath(req));
    }

    const requestedWidthRaw = query["width"];
    const requestedWidth =
      typeof requestedWidthRaw === "string" && Number.isFinite(Number.parseInt(requestedWidthRaw, 10))
        ? Number.parseInt(requestedWidthRaw, 10)
        : undefined;

    const variant = pickVariant(forKind, requestedWidth);
    if (!variant) {
      throw notFound("Image not found.", sanitizeInstancePath(req));
    }

    const etag = computeEtag(variant, clearanceDigest(ctx));
    const ifNoneMatch = req.headers["if-none-match"];
    if (typeof ifNoneMatch === "string" && ifNoneMatch === etag) {
      res.status(304);
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.end();
      return;
    }

    let fileStat;
    try {
      fileStat = await stat(variant.file_path);
    } catch {
      throw notFound("Image not found.", sanitizeInstancePath(req));
    }

    const ext = path.extname(variant.file_path).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";

    res.status(200);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", fileStat.size);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("ETag", etag);

    const stream = createReadStream(variant.file_path);
    stream.pipe(res);
  }
}
