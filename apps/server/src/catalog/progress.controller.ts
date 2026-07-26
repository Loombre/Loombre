// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/progress.controller.ts
//
// PUT /progress/{itemId} (upsert; guarded item-visibility check first —
// writing progress against an invisible item is a 404, see
// packages/db/src/query/progress-write.ts), GET /progress (listProgress).
//
// P2.14/P2.18 additive: ProgressUpdate.sessionId is an OPTIONAL playback
// session id — when present, this PUT ALSO heartbeats that session
// (heartbeatPlaybackSession, @loombre/db), matching docs/PLAYBACK.md §9's
// "client progress PUT doubles as heartbeat". This does NOT import
// anything from apps/server/src/playback/ (that would violate D2's catalog
// <-> playback module boundary) — heartbeatPlaybackSession is a
// @loombre/db package export, not an apps/server cross-module import, the
// same way progress reads/writes here never import catalog.module.ts's
// sibling controllers either. A sessionId that doesn't resolve (wrong
// owner, already ended, nonexistent) is silently ignored: the progress
// write itself is the primary operation and must not fail because of a
// stale/invalid heartbeat hint.
//
// P2.8 (websocket-presence lane) additive: this request body already has
// positionMs/durationMs validated by the time the heartbeat call happens
// (upsertProgress above already succeeded), so they're threaded straight
// into heartbeatPlaybackSession's optional `progress` param — that's what
// lets it throttle-emit `playback.progress` (at most once per 30s per
// session, see packages/db/src/query/playback-sessions.ts) without this
// controller knowing anything about the throttle itself.

import { Body, Controller, Get, Param, Put, Query, Req } from "@nestjs/common";
import { getProgressForItem, heartbeatPlaybackSession, listProgress, upsertProgress } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { resolveViewer, parseListQuery } from "./viewer.js";

interface ProgressUpdateBody {
  positionMs?: unknown;
  durationMs?: unknown;
  state?: unknown;
  sessionId?: unknown;
}

const VALID_STATES = new Set(["unplayed", "in-progress", "played"]);

@Controller()
export class ProgressController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  @Get("progress/:itemId")
  async getProgress(@Param("itemId") itemId: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(itemId, "Progress not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const result = await getProgressForItem(this.dbProvider.db, ctx, itemId);
    if (!result) {
      throw notFound("Progress not found.", req.originalUrl);
    }
    return result;
  }

  @Put("progress/:itemId")
  async putProgress(
    @Param("itemId") itemId: string,
    @Body() rawBody: ProgressUpdateBody | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(itemId, "Item not found.", req.originalUrl);
    const body = rawBody ?? {};
    if (typeof body.positionMs !== "number" || body.positionMs < 0) {
      throw unprocessableEntity("positionMs (non-negative integer) is required.", req.originalUrl);
    }
    if (typeof body.state !== "string" || !VALID_STATES.has(body.state)) {
      throw unprocessableEntity("state must be one of unplayed|in-progress|played.", req.originalUrl);
    }
    if (body.durationMs !== undefined && body.durationMs !== null && typeof body.durationMs !== "number") {
      throw unprocessableEntity("durationMs must be a number or null.", req.originalUrl);
    }
    if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
      throw unprocessableEntity("sessionId must be a string.", req.originalUrl);
    }

    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const nowMs = clockNowMs();
    const result = await upsertProgress(this.dbProvider.db, ctx, itemId, {
      positionMs: body.positionMs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: body.state as any,
      nowMs,
      ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
    });

    if (!result) {
      throw notFound("Item not found.", req.originalUrl);
    }

    if (typeof body.sessionId === "string") {
      // Best-effort heartbeat — see this file's header for why a stale/
      // invalid sessionId never fails the progress write itself.
      await heartbeatPlaybackSession(this.dbProvider.db, ctx, body.sessionId, nowMs, {
        positionMs: body.positionMs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(body.durationMs !== undefined ? { durationMs: body.durationMs as any } : {}),
      });
    }

    return result;
  }

  @Get("progress")
  async listProgress(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const { cursor, limit } = parseListQuery(query);
    const page = await listProgress(this.dbProvider.db, ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { items: page.rows, nextCursor: page.nextCursor };
  }
}
