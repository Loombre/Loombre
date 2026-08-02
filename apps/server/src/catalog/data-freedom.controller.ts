// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/data-freedom.controller.ts
//
// GET /export (docs/PLAN.md §8.4) streams @loombre/db's exportData(ctx)
// async generator as chunked JSON — genuinely incremental: libraries/items/
// users are written to the response as the generator yields them, not
// buffered into one giant in-memory array first (only the derived
// `progress` array, whose size is bounded by item count, is accumulated
// in-process and flushed once items are exhausted).
//
// Each 'item' chunk from exportData only carries base fields + provider
// ids + the caller's own progress (packages/db/src/query/export.ts) — not
// the full satellite/genre/image data the contract's discriminated item
// shapes need, so this handler additionally calls getCatalogDetail per item
// (same N+1-acceptable-at-Phase-1-scale tradeoff as cross-type.controller.ts).
//
// { includeDetail: true } (Phase 4 lane E addition): getCatalogDetail
// defaults this OFF for exactly this call site (see its own doc comment,
// packages/db/src/query/catalog-detail.ts) because at gap-closure-lane time
// nothing downstream of export read people[]/mediaFiles[] yet. That changed
// the moment a real import consumer (apps/worker/src/import) landed: id
// preservation for media_files rows and cast/crew credits both need this
// archive to actually carry them — an ExportArchive that never includes
// mediaFiles/people cannot round-trip either. The cost is the same shape as
// every other field already fetched here (one extra batched query per
// EXPORT_ITEM_PAGE_SIZE page via fetchPeopleBatch/fetchMediaFilesBatch, not
// per-row) — bounded, and export already isn't a Tier-0 hot path (see the
// N+1 note above, accepted at this same scale).
//
// POST /import (admin) — apps/worker/src/import owns the real archive-apply
// consumer (Phase 4 lane E; replaces the Phase 1 stub). This endpoint's job
// is unchanged: gate on admin, validate the body is at least archive-shaped
// and hand it to the queue — see that module's header for the conflict-
// policy/id-preservation/transaction design the job itself implements.
//
// Admin gate asymmetry: only POST /import is admin-only (the consumer
// applies the archive's `users[]` rows verbatim, isAdmin included, so a
// non-admin importer is a privilege-escalation path). GET /export stays
// authenticated-but-not-admin — its own admin-only `users` phase is already
// filtered inside packages/db/src/query/export.ts, and the contract
// documents no 403 for it.

import { Controller, Get, Post, Body, HttpCode, HttpStatus, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { exportData, getCatalogDetail } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { forbidden, unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider, type LoombreDb } from "../common/db.provider.js";
import { requireLiveAdmin } from "../common/require-live-admin.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { JobQueueProvider } from "../common/job-queue.provider.js";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { resolveViewer } from "./viewer.js";
import { mapByType } from "./mappers.js";

// L2 (pre-public hardening): claim fast-fail, then a FRESH DB re-read via
// requireLiveAdmin — the JWT isAdmin claim alone can be stale for up to the
// access token's 15-minute lifetime after a demotion.
async function requireAdmin(db: LoombreDb, req: AuthenticatedRequest): Promise<void> {
  if (!req.user?.isAdmin) {
    throw forbidden("Admin privileges are required for this operation.", req.originalUrl);
  }
  await requireLiveAdmin(db, req.user.userId, req.originalUrl);
}

function mapExportLibrary(lib: {
  id: string;
  name: string;
  mediaKind: string;
  contentClass: string;
  paths: string[];
  createdAtMs: number;
}) {
  return {
    id: lib.id,
    name: lib.name,
    mediaKind: lib.mediaKind,
    paths: lib.paths,
    contentClass: lib.contentClass,
    createdAtMs: lib.createdAtMs,
    updatedAtMs: lib.createdAtMs,
  };
}

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class DataFreedomController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
    private readonly jobQueueProvider: JobQueueProvider,
  ) {}

  // STATE.md P4.15's "export surface review" (task spec: "authenticated but
  // heavy — per-user bucket, document"): a full catalog + progress + user
  // dump, streamed but still real DB/CPU work per request. per-USER (not
  // per-device — the whole account shares one budget), TIGHT ceiling
  // (SurfaceRateLimiterService.export, default 5/hour) — nothing about
  // normal product usage calls this endpoint repeatedly in a short window.
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("export", "user")
  @Get("export")
  async exportArchive(@Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    const ctx = await resolveViewer(this.viewerContextProvider, req);

    res.status(200);
    res.setHeader("Content-Type", "application/json");
    res.write(`{"exportedAtMs":${clockNowMs()}`);

    // exportData() yields in three STRICTLY SEQUENTIAL phases (all
    // 'library' chunks, then all 'item' chunks, then — admin only — all
    // 'user' chunks; see packages/db/src/query/export.ts). PHASES lists
    // them in that order; `cursor` tracks which phase index is currently
    // open (or -1 before the first has been opened), `phaseClosed` tracks
    // whether PHASES[cursor]'s own `[...]` has already been closed (true
    // right after auto-closing an empty skipped phase, so the NEXT
    // iteration must not close it a second time). openPhase(target) closes
    // whatever is currently open and walks forward opening (and, for any
    // phase strictly between the previous one and `target` that produced
    // zero chunks, immediately closing) each phase up to `target`.
    const PHASES = ["libraries", "items", "users"] as const;
    let cursor = -1;
    let phaseClosed = true;
    let wroteFirstInPhase = false;

    function openPhase(target: number): void {
      while (cursor < target) {
        if (cursor >= 0 && !phaseClosed) res.write("]");
        cursor += 1;
        wroteFirstInPhase = false;
        res.write(`,"${PHASES[cursor]}":[`);
        phaseClosed = false;
        if (cursor < target) {
          res.write("]");
          phaseClosed = true;
        }
      }
    }

    const progressEntries: unknown[] = [];

    for await (const chunk of exportData(this.dbProvider.db, ctx)) {
      if (chunk.kind === "library") {
        openPhase(0);
        res.write(`${wroteFirstInPhase ? "," : ""}${JSON.stringify(mapExportLibrary(chunk.library))}`);
        wroteFirstInPhase = true;
      } else if (chunk.kind === "item") {
        openPhase(1);
        const detail = await getCatalogDetail(this.dbProvider.db, ctx, chunk.item.id, { includeDetail: true });
        if (detail) {
          res.write(`${wroteFirstInPhase ? "," : ""}${JSON.stringify(mapByType(chunk.item.itemType, detail))}`);
          wroteFirstInPhase = true;
        }
        if (chunk.item.progress) {
          progressEntries.push({
            itemId: chunk.item.id,
            positionMs: chunk.item.progress.positionMs,
            state: chunk.item.progress.state,
            playCount: chunk.item.progress.playCount,
            updatedAtMs: chunk.item.progress.updatedAtMs,
          });
        }
      } else if (chunk.kind === "user") {
        openPhase(2);
        res.write(
          `${wroteFirstInPhase ? "," : ""}${JSON.stringify({
            id: chunk.user.id,
            username: chunk.user.username,
            email: chunk.user.email,
            displayName: chunk.user.displayName,
            isAdmin: chunk.user.isAdmin,
            createdAtMs: chunk.user.createdAtMs,
          })}`,
        );
        wroteFirstInPhase = true;
      }
    }

    // Close whichever phase was left open, and backfill any phase(s) that
    // never received a single chunk (including all three, if this viewer
    // has zero visible libraries).
    openPhase(2);
    if (!phaseClosed) res.write("]");

    res.write(`,"progress":${JSON.stringify(progressEntries)},"playlists":[]}`);
    res.end();
  }

  @Post("import")
  @HttpCode(HttpStatus.ACCEPTED)
  async importArchive(@Body() rawBody: Record<string, unknown> | undefined, @Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);
    const body = rawBody ?? {};
    if (typeof body["exportedAtMs"] !== "number" || !Array.isArray(body["items"])) {
      throw unprocessableEntity("Body must be an ExportArchive (exportedAtMs, items[], ...).", req.originalUrl);
    }

    const jobId = await this.jobQueueProvider.queue.enqueue(
      "import",
      { archive: body, requestedByUserId: req.user!.userId },
      { subjectItemId: null },
    );
    return { jobId };
  }
}
