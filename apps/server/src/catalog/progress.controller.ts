// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/progress.controller.ts
//
// PUT /progress/{itemId} (upsert; guarded item-visibility check first —
// writing progress against an invisible item is a 404, see
// packages/db/src/query/progress-write.ts), GET /progress (listProgress).
//
// d3-b9: that visibility check is now followed by an item-TYPE check —
// only movie/episode/track (progress-item-types.ts) may hold a progress
// row. See putProgress below for the ordering and why it matters.
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
//
// REPORTED POSITIONS ARE SOURCE TIME; STORED VERBATIM (docs/PLAYBACK.md
// §9, gap-F6 round 3). Under the V8 seek model every served segment
// carries `EXT-X-PROGRAM-DATE-TIME` whose epoch IS source time (§9.1.5
// rule 7), and the web player's positions — the watched position that
// feeds every /progress write (apps/web lib/watched-progress.ts), the
// displayed clock (lib/source-clock.ts), and every seek target — are
// SOURCE-axis values by construction. This controller stores them exactly
// as sent.
//
// A presentation→source ingestion conversion used to live here (it walked
// the CURRENT served playlist and re-expressed the reported position in
// its owning run), built for a `video.currentTime` reporter. It was
// removed by gap-F6 round 3 because it had become actively harmful:
//   1. It DOUBLE-MAPPED the V8 client's source-axis reports on any
//      multi-run session — live 2026-08-24, an honest watched position of
//      23_880 (0:23.9) was stored as 522_280 (8:42): the phantom resume
//      point of the verify refutation, for content never watched.
//   2. It was unsound even for a presentation reporter once ANY head
//      segment had been retention-pruned: the client's presentation axis
//      is anchored at ITS OWN first playlist load, while the walk started
//      at the CURRENT (post-prune) playlist head — the axes agree only
//      while nothing has pruned, which is precisely when the mapping was
//      the identity anyway.

import { Body, Controller, Get, Param, Put, Query, Req } from "@nestjs/common";
import {
  getItemById,
  getProgressForItem,
  heartbeatPlaybackSession,
  listProgress,
  upsertProgress,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { resolveViewer, parseListQuery } from "./viewer.js";
import { canCarryProgress, PROGRESS_BEARING_ITEM_TYPES } from "./progress-item-types.js";

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
    // V1-009: contract declares positionMs/durationMs `type: integer` and
    // both flow unmodified into a BIGINT column (upsertProgress ->
    // progress-write.ts, no rounding anywhere in that file) — a non-integer
    // number (e.g. 12.5) used to sail past this check and hit Postgres as
    // an unhandled 500 instead of a 422 here. Number.isSafeInteger, not
    // isInteger: isInteger(1e20) is true but 1e20 overflows BIGINT
    // (Postgres: "bigint out of range" — the same 500 class), and any
    // integer above MAX_SAFE_INTEGER was lossy the moment JSON.parse
    // produced it anyway. MAX_SAFE_INTEGER ms ≈ 285k years, so the
    // tighter-than-int64 bound rejects nothing legitimate.
    if (typeof body.positionMs !== "number" || !Number.isSafeInteger(body.positionMs) || body.positionMs < 0) {
      throw unprocessableEntity("positionMs (non-negative integer) is required.", req.originalUrl);
    }
    if (typeof body.state !== "string" || !VALID_STATES.has(body.state)) {
      throw unprocessableEntity("state must be one of unplayed|in-progress|played.", req.originalUrl);
    }
    if (
      body.durationMs !== undefined &&
      body.durationMs !== null &&
      (typeof body.durationMs !== "number" || !Number.isSafeInteger(body.durationMs))
    ) {
      throw unprocessableEntity("durationMs must be an integer or null.", req.originalUrl);
    }
    if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
      throw unprocessableEntity("sessionId must be a string.", req.originalUrl);
    }

    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const nowMs = clockNowMs();

    // Remediation d3-b9: only PLAYABLE LEAF types carry progress. This
    // used to accept ANY visible item id, so a client could store a
    // progress row against a series/season/artist/album — a position on
    // something that has no playable position. Such a row surfaces
    // nowhere useful and actively harmed one place: GET
    // /home/continue-watching paged over every progress row and then
    // dropped the ineligible ones, so a single container row could empty
    // page 0 of the rail (that half is fixed in
    // packages/db/src/query/progress.ts; this is the half that stops the
    // rows being created).
    //
    // ORDERING IS THE ANTI-ENUMERATION POINT, and it is why this is a
    // separate guarded read rather than a check on upsertProgress's
    // result: the body is validated first (unchanged), then getItemById
    // applies the SAME guard upsertProgress would — an item that does not
    // exist and one the viewer cannot see are the same 404, exactly as
    // before — and only an item the caller could already see can reach
    // the 422 below. A type check derived from a write that already
    // happened would also have had to undo it.
    const item = await getItemById(this.dbProvider.db, ctx, itemId);
    if (!item) {
      throw notFound("Item not found.", req.originalUrl);
    }
    if (!canCarryProgress(item.item_type)) {
      throw unprocessableEntity(
        `Progress cannot be recorded against a ${item.item_type} — only ${PROGRESS_BEARING_ITEM_TYPES.join("/")} items carry a playback position.`,
        req.originalUrl,
      );
    }

    // SOURCE-axis, stored verbatim (this file's header) — the same value
    // is persisted AND carried by the heartbeat's playback.progress
    // payload, so the two can never disagree about where the viewer is.
    const positionMs = body.positionMs;

    const result = await upsertProgress(this.dbProvider.db, ctx, itemId, {
      positionMs,
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
        positionMs,
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
