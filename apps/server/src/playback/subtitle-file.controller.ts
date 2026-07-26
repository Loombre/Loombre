// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/subtitle-file.controller.ts
//
// GET /playback/sessions/{id}/subtitles/media.m3u8 + GET
// /playback/sessions/{id}/subtitles/{file} (STATE.md P3.9(e), Phase 3 §11
// step 6b). Serves the segmented-VTT subtitle side-track the
// 'subtitle-extract' worker job writes under
// `<staging_dir>/subs/{media.m3u8,sub0.vtt}` — same guard posture as
// hls-file.controller.ts (never trust a client-supplied path; strict
// filename pattern), but no throttle/seek concerns (a single, immutable,
// fully-rendered VOD playlist and its one segment — see
// apps/worker/src/subtitles/playlist.ts's header).
//
// Unlike the video HLS manifest, there is no DB column marking "subs
// ready" (this step's own instructions never added one) — readiness is
// judged directly by whether the file exists on disk yet, checked ONCE per
// request (not an 8s blocking poll like the video manifest — that bound is
// specific to docs/PLAYBACK.md §9's video-startup latency budget, which
// this side-track has no equivalent spec clause for). A single-check-then-
// 503 is a documented interpretation difference from GET .../hls/media.m3u8,
// reported per this step's instructions.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Controller, Get, Param, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { getPlaybackSessionForUser } from "@loombre/db";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import { AllowQueryToken } from "../gateway/allow-query-token.decorator.js";
import { sanitizeInstancePath } from "../gateway/sanitize-instance.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { resolveViewer } from "./viewer.js";

const VTT_SEGMENT_FILENAME = "sub0.vtt";

function isStrictlyUnder(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function respondNotReady(res: Response, instance: string): void {
  res.status(503);
  res.setHeader("Retry-After", "1");
  res.setHeader("Content-Type", "application/problem+json");
  res.send({
    type: "urn:loombre:problem:subtitle-not-ready",
    title: "Subtitle side-track not ready",
    status: 503,
    detail: "The segmented-VTT subtitle side-track has not been extracted yet.",
    instance,
    code: "subtitle-not-ready",
  });
}

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class PlaybackSubtitleFileController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  // STATE.md P4.15: one of the four `?token=` media GET families.
  // per-identity, GENEROUS ceiling — shares the mediaToken policy with the
  // video HLS manifest/segments (same rationale: do not break seeking).
  @AllowQueryToken()
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("mediaToken", "identity")
  @Get("playback/sessions/:id/subtitles/media.m3u8")
  async getManifest(@Param("id") id: string, @Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    requireUuidParam(id, "Playback session not found.", sanitizeInstancePath(req));
    const ctx = await resolveViewer(this.viewerContextProvider, req);

    const session = await getPlaybackSessionForUser(this.dbProvider.db, ctx, id);
    if (!session) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }
    if (!session.stagingDir) {
      respondNotReady(res, sanitizeInstancePath(req));
      return;
    }

    const playlistPath = join(session.stagingDir, "subs", "media.m3u8");
    let text: string;
    try {
      text = await readFile(playlistPath, "utf8");
    } catch {
      respondNotReady(res, sanitizeInstancePath(req));
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(text);
  }

  @AllowQueryToken()
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("mediaToken", "identity")
  @Get("playback/sessions/:id/subtitles/:file")
  async getFile(
    @Param("id") id: string,
    @Param("file") file: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    requireUuidParam(id, "Playback session not found.", sanitizeInstancePath(req));

    // Strict, single allowed filename (module header) — anything else 404s
    // before a session lookup even happens (never trust client input).
    if (file !== VTT_SEGMENT_FILENAME) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const session = await getPlaybackSessionForUser(this.dbProvider.db, ctx, id);
    if (!session || !session.stagingDir) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    const subsDir = join(session.stagingDir, "subs");
    const absolutePath = join(subsDir, file);
    if (!isStrictlyUnder(session.stagingDir, absolutePath)) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    let sizeBytes: number;
    try {
      sizeBytes = (await stat(absolutePath)).size;
    } catch {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    res.status(200);
    res.setHeader("Content-Type", "text/vtt");
    res.setHeader("Cache-Control", "private, immutable");
    res.setHeader("Content-Length", sizeBytes);
    createReadStream(absolutePath).pipe(res);
  }
}
