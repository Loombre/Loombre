// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/libraries.controller.ts
//
// GET/POST /libraries, GET/PATCH/DELETE /libraries/{id},
// POST /libraries/{id}/scan, GET/PUT /libraries/{id}/permissions.
//
// Admin gate: every write here (POST/PATCH/DELETE/scan/permissions) checks
// `req.user.isAdmin` (attached by AuthGuard from the access-token claim,
// see gateway/auth.guard.ts) and throws 403 Forbidden otherwise — matches
// the contract's documented security description for these operations.
//
// Restricted-library-creation refusal (P1.19, mission spec): when the
// restricted.enabled setting (Addendum A registry; env-pinnable via
// LOOMBRE_RESTRICTED_ENABLED) resolves off, `contentClass: 'restricted'` on
// POST /libraries is refused. The mission text says "409/403 per contract"
// but POST /libraries only documents 401/403/422/default (no 409) — 403 is
// used, matching what's actually in packages/contract/openapi.yaml.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import {
  createLibrary,
  deleteLibraryAdmin,
  getLibraryByIdAdmin,
  getLibraryForViewer,
  getLibraryItemCountsForViewer,
  getLibraryPermissionsAdmin,
  listLibrariesForViewer,
  putLibraryPermissionsAdmin,
  updateLibraryAdmin,
  type ItemType,
  type LibraryPermissionEntry,
  type LibraryRow,
  type ViewerContext,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { forbidden, notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { JobQueueProvider } from "../common/job-queue.provider.js";
import { isRestrictedContentEnabled } from "../common/capabilities.js";
import { SettingsService } from "../settings/settings.service.js";
import { resolveViewer, parseListQuery } from "./viewer.js";

/**
 * Wave 1c (Phosphor retheme, "contract enablers" lane): the ONE item_type
 * a library's headline `itemCount` reads off of — "which row shape is
 * this library's own count" is a display decision made here, not guessed
 * by the data layer (see getLibraryItemCountsForViewer's own doc comment,
 * packages/db/src/query/libraries.ts). A "tv" library's catalog_items span
 * series + season + episode rows; the sidebar wants the SHOW count, not
 * every episode.
 */
function headlineItemTypeForMediaKind(mediaKind: string): ItemType {
  if (mediaKind === "tv") return "series";
  if (mediaKind === "music") return "album";
  return "movie";
}

function mapLibrary(
  row: {
    id: string;
    name: string;
    media_kind: string;
    paths: string[];
    content_class: string;
    created_at_ms: number;
    updated_at_ms: number;
  },
  itemCount: number,
) {
  return {
    id: row.id,
    name: row.name,
    mediaKind: row.media_kind,
    paths: row.paths,
    contentClass: row.content_class,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    itemCount,
  };
}

/** Merges getLibraryItemCountsForViewer's per-(library, item_type) rows
 *  down to one headline count per library row, defaulting to 0 for a
 *  library with no matching rows yet (freshly created, or genuinely
 *  empty) rather than omitting the field. */
async function mapLibrariesWithCounts(
  db: Parameters<typeof getLibraryItemCountsForViewer>[0],
  ctx: ViewerContext,
  rows: LibraryRow[],
) {
  const counts = await getLibraryItemCountsForViewer(
    db,
    ctx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const headline = headlineItemTypeForMediaKind(row.media_kind);
    const count = counts.find((c) => c.libraryId === row.id && c.itemType === headline)?.count ?? 0;
    return mapLibrary(row, count);
  });
}

// L2 (pre-public hardening): claim fast-fail, then a FRESH DB re-read via
// requireLiveAdmin — the JWT isAdmin claim alone can be stale for up to the
// access token's 15-minute lifetime after a demotion.
async function requireAdmin(db: LoombreDb, req: AuthenticatedRequest): Promise<void> {
  if (!req.user?.isAdmin) {
    throw forbidden("Admin privileges are required for this operation.", req.originalUrl);
  }
  await requireLiveAdmin(db, req.user.userId, req.originalUrl);
}

const VALID_MEDIA_KINDS = new Set(["movie", "tv", "music"]);
const VALID_CONTENT_CLASSES = new Set(["general", "restricted"]);

@Controller()
export class LibrariesController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
    private readonly jobQueueProvider: JobQueueProvider,
    private readonly settingsService: SettingsService,
  ) {}

  @Get("libraries")
  async listLibraries(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await listLibrariesForViewer(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const items = await mapLibrariesWithCounts(this.dbProvider.db, ctx, page.rows);
    return { items, nextCursor: page.nextCursor };
  }

  @Post("libraries")
  async createLibrary(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const body = rawBody ?? {};
    const instance = req.originalUrl;

    if (typeof body["name"] !== "string" || body["name"].length === 0) {
      throw unprocessableEntity("name is required.", instance);
    }
    if (typeof body["mediaKind"] !== "string" || !VALID_MEDIA_KINDS.has(body["mediaKind"])) {
      throw unprocessableEntity("mediaKind must be one of movie|tv|music.", instance);
    }
    if (!Array.isArray(body["paths"]) || body["paths"].length === 0 || !body["paths"].every((p) => typeof p === "string")) {
      throw unprocessableEntity("paths must be a non-empty array of strings.", instance);
    }
    let contentClass: "general" | "restricted" | undefined;
    if (body["contentClass"] !== undefined) {
      if (typeof body["contentClass"] !== "string" || !VALID_CONTENT_CLASSES.has(body["contentClass"])) {
        throw unprocessableEntity("contentClass must be general or restricted.", instance);
      }
      contentClass = body["contentClass"] as "general" | "restricted";
    }

    if (contentClass === "restricted" && !isRestrictedContentEnabled(this.settingsService)) {
      throw forbidden(
        "Restricted-content libraries cannot be created: restricted.enabled is off on this instance (docs/PLAN.md §6.4 gate 1).",
        instance,
      );
    }

    const lib = await createLibrary(this.dbProvider.db, {
      name: body["name"],
      mediaKind: body["mediaKind"] as "movie" | "tv" | "music",
      paths: body["paths"] as string[],
      ...(contentClass !== undefined ? { contentClass } : {}),
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
    });
    // A freshly created library has no items yet — 0 without a query.
    return mapLibrary(lib, 0);
  }

  @Get("libraries/:id")
  async getLibrary(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const lib = await getLibraryForViewer(this.dbProvider.db, ctx, id);
    if (!lib) {
      throw notFound("Library not found.", req.originalUrl);
    }
    const [mapped] = await mapLibrariesWithCounts(this.dbProvider.db, ctx, [lib]);
    return mapped;
  }

  @Patch("libraries/:id")
  async updateLibrary(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const body = rawBody ?? {};
    const instance = req.originalUrl;

    if (body["name"] !== undefined && (typeof body["name"] !== "string" || body["name"].length === 0)) {
      throw unprocessableEntity("name must be a non-empty string.", instance);
    }
    if (
      body["paths"] !== undefined &&
      (!Array.isArray(body["paths"]) || body["paths"].length === 0 || !body["paths"].every((p) => typeof p === "string"))
    ) {
      throw unprocessableEntity("paths must be a non-empty array of strings.", instance);
    }

    const updated = await updateLibraryAdmin(this.dbProvider.db, id, {
      ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
      ...(Array.isArray(body["paths"]) ? { paths: body["paths"] as string[] } : {}),
      nowMs: clockNowMs(),
    });
    if (!updated) {
      throw notFound("Library not found.", instance);
    }
    // itemCount through THIS ADMIN'S OWN ViewerContext — same posture as
    // admin.controller.ts's listActiveSessionsAdmin (never a synthetic
    // "admin sees everything" context; an admin without this library's own
    // gate-5 unlock sees the same guarded count any other viewer would).
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const [mapped] = await mapLibrariesWithCounts(this.dbProvider.db, ctx, [updated]);
    return mapped;
  }

  @Delete("libraries/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLibrary(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const existing = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("Library not found.", req.originalUrl);
    }
    await deleteLibraryAdmin(this.dbProvider.db, id);
  }

  @Post("libraries/:id/scan")
  @HttpCode(HttpStatus.ACCEPTED)
  async scanLibrary(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const existing = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("Library not found.", req.originalUrl);
    }
    const full = (rawBody ?? {})["full"] === true;
    const jobId = await this.jobQueueProvider.queue.enqueue("scan", { libraryId: id, full }, { subjectItemId: null });
    return { jobId };
  }

  @Get("libraries/:id/permissions")
  async getLibraryPermissions(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const existing = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("Library not found.", req.originalUrl);
    }
    const permissions = await getLibraryPermissionsAdmin(this.dbProvider.db, id);
    return { libraryId: id, permissions };
  }

  @Put("libraries/:id/permissions")
  async putLibraryPermissions(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const instance = req.originalUrl;
    const existing = await getLibraryByIdAdmin(this.dbProvider.db, id);
    if (!existing) {
      throw notFound("Library not found.", instance);
    }

    const body = rawBody ?? {};
    if (!Array.isArray(body["permissions"])) {
      throw unprocessableEntity("permissions must be an array.", instance);
    }
    const entries: LibraryPermissionEntry[] = [];
    for (const raw of body["permissions"] as unknown[]) {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as Record<string, unknown>)["userId"] !== "string" ||
        typeof (raw as Record<string, unknown>)["granted"] !== "boolean"
      ) {
        throw unprocessableEntity("Each permission entry requires userId (string) and granted (boolean).", instance);
      }
      entries.push({
        userId: (raw as Record<string, unknown>)["userId"] as string,
        granted: (raw as Record<string, unknown>)["granted"] as boolean,
      });
    }

    const permissions = await putLibraryPermissionsAdmin(this.dbProvider.db, id, entries, clockNowMs());
    return { libraryId: id, permissions };
  }
}
