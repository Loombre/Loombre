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
//
// PRESENTATION -> SOURCE MAPPING (docs/PLAYBACK.md §9): a player reports
// `video.currentTime` — its position in the SERVED PLAYLIST's timeline,
// which runs continuously across every `EXT-X-DISCONTINUITY`. Each seek run
// is spawned with `-ss` and no `-copyts`, so its own output timestamps
// restart at zero, and the two timelines diverge by exactly the accumulated
// seek offsets. Progress, resume points and `positionMs` everywhere else in
// this system are SOURCE-timeline values, so a post-seek heartbeat stored
// verbatim points at the wrong place in the file.
//
// The conversion happens HERE, at ingestion, and the client is left
// untouched: it reports what its own media element knows, and the server —
// which owns the run map (`transcode_runs`, migration 0043) and the served
// playlist — is the only party that CAN reconcile the two. It is
// best-effort in the strictest sense: any missing input (no sessionId, no
// runs, no readable playlist, a position past the playlist's end) keeps the
// client's value exactly as sent, and for a single-run or direct-play
// session the mapping is the identity anyway.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Body, Controller, Get, Param, Put, Query, Req } from "@nestjs/common";
import {
  getPlaybackSessionForUser,
  getProgressForItem,
  heartbeatPlaybackSession,
  listProgress,
  listTranscodeRuns,
  upsertProgress,
} from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { parseServedSegmentDurations, presentationToSourceMs } from "../common/served-playlist.js";
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

    // Presentation -> source (see this file's header). Resolved BEFORE the
    // write so the mapped value is what gets persisted AND what the
    // heartbeat's playback.progress payload carries — the two must never
    // disagree about where the viewer is.
    const positionMs =
      typeof body.sessionId === "string"
        ? await this.toSourcePositionMs(ctx, body.sessionId, body.positionMs)
        : body.positionMs;

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

  /**
   * Converts a client-reported PRESENTATION position into a SOURCE-timeline
   * position for `sessionId` — this file's header explains why the two
   * differ and why only the server can reconcile them.
   *
   * Returns `presentationMs` UNCHANGED whenever the mapping cannot be made
   * with certainty: no such session (or not this viewer's), no staging dir,
   * an unreadable served playlist, no recorded runs, or a position past the
   * playlist's end. That is the safe direction — the client's own value is
   * already correct for every direct-play session and for every transcode
   * session that has not seeked, which is the overwhelming majority of
   * heartbeats. A wrong guess here would corrupt a resume point silently;
   * leaving it alone merely fails to improve one.
   *
   * Never throws: the progress write is the primary operation and must not
   * fail over a mapping refinement (same posture as the heartbeat call
   * below it, see this file's header).
   */
  private async toSourcePositionMs(ctx: ViewerContext, sessionId: string, presentationMs: number): Promise<number> {
    try {
      const session = await getPlaybackSessionForUser(this.dbProvider.db, ctx, sessionId);
      if (!session?.stagingDir) return presentationMs;

      const runs = await listTranscodeRuns(this.dbProvider.db, sessionId);
      // A single run means origin 0 and an identity mapping — skip the file
      // read entirely rather than doing it to compute `presentationMs`.
      if (runs.length < 2) return presentationMs;

      const entries = parseServedSegmentDurations(await readFile(join(session.stagingDir, "media.m3u8"), "utf8"));
      return presentationToSourceMs(entries, runs, presentationMs) ?? presentationMs;
    } catch {
      return presentationMs;
    }
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
