// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/session-file.controller.ts
//
// GET /playback/sessions/{id}/file (STATE.md P2.13, additive contract path):
// HTTP range serving of the session's own media file. The path comes ONLY
// from the media_files row resolved via the session (never from request
// input) — path traversal is impossible by construction, mirroring
// images.controller.ts's own "never trust a client-supplied path" posture.
//
// Authorization: getPlaybackSessionForUser(ctx, id) — own sessions only —
// is the single choke-point, run unconditionally before anything else
// (same discipline as images.controller.ts's getImageEntityAccess). A
// session that isn't the caller's (or doesn't exist) yields the SAME
// notFound() shape either way.
//
// @AllowQueryToken() (P2.18): browser <video>/<audio> elements set `src`
// directly and cannot attach an Authorization header, so this route also
// accepts `?token=`.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Controller, Get, Param, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { getMediaFileForPlaybackSession, getPlaybackSessionForUser } from "@loombre/db";
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

const CONTENT_TYPE_BY_CONTAINER: Record<string, string> = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  ts: "video/mp2t",
  mov: "video/quicktime",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

type RangeResult = { kind: "none" } | { kind: "malformed" } | { kind: "unsatisfiable" } | { kind: "range"; start: number; end: number };

/** Single-range `bytes=` parsing only (no multipart/byteranges — the task
 *  spec asks for single-range 206 only). Suffix ranges (`bytes=-500`) and
 *  open-ended ranges (`bytes=500-`) are both supported. */
export function parseRangeHeader(rangeHeader: string | undefined, sizeBytes: number): RangeResult {
  if (!rangeHeader) return { kind: "none" };
  if (rangeHeader.includes(",")) return { kind: "malformed" }; // multi-range unsupported

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { kind: "malformed" };
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return { kind: "malformed" };

  let start: number;
  let end: number;
  if (startStr === "") {
    const suffixLength = Number.parseInt(endStr!, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: "malformed" };
    start = Math.max(0, sizeBytes - suffixLength);
    end = sizeBytes - 1;
  } else {
    start = Number.parseInt(startStr!, 10);
    end = endStr === "" ? sizeBytes - 1 : Number.parseInt(endStr!, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return { kind: "malformed" };
  if (sizeBytes === 0 || start >= sizeBytes) return { kind: "unsatisfiable" };

  return { kind: "range", start, end: Math.min(end, sizeBytes - 1) };
}

function computeEtag(contentHash: string | null, fallbackId: string): string {
  return `"${contentHash && contentHash.length > 0 ? contentHash : fallbackId}"`;
}

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class PlaybackSessionFileController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  // STATE.md P4.15: one of the four `?token=` media GET families.
  // per-identity, GENEROUS ceiling — Range-request direct-play seeking
  // fires many rapid byte-range GETs; do not break seeking.
  @AllowQueryToken()
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("mediaToken", "identity")
  @Get("playback/sessions/:id/file")
  async getSessionFile(@Param("id") id: string, @Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    requireUuidParam(id, "Playback session not found.", sanitizeInstancePath(req));
    const ctx = await resolveViewer(this.viewerContextProvider, req);

    const session = await getPlaybackSessionForUser(this.dbProvider.db, ctx, id);
    if (!session || !session.fileId) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    const file = await getMediaFileForPlaybackSession(this.dbProvider.db, session.fileId);
    if (!file) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    let fileStat;
    try {
      fileStat = await stat(file.path);
    } catch {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    const sizeBytes = fileStat.size;
    const contentType = (file.container && CONTENT_TYPE_BY_CONTAINER[file.container]) ?? "application/octet-stream";
    const etag = computeEtag(file.contentHash, file.id);

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private");
    res.setHeader("ETag", etag);

    // If-Range: only honor the client-supplied Range when the resource is
    // unchanged (etag still matches) — otherwise safely ignore Range and
    // fall through to a full 200 response (RFC 9110 §13.1.5 allows either
    // honoring or ignoring; ignoring is always safe).
    const ifRange = req.headers["if-range"];
    const ifRangeMatches = typeof ifRange !== "string" || ifRange === etag;

    const range = ifRangeMatches ? parseRangeHeader(req.headers["range"] as string | undefined, sizeBytes) : { kind: "none" as const };

    if (range.kind === "malformed") {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${sizeBytes}`);
      res.end();
      return;
    }

    if (range.kind === "unsatisfiable") {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${sizeBytes}`);
      res.end();
      return;
    }

    if (range.kind === "range") {
      const { start, end } = range;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${sizeBytes}`);
      res.setHeader("Content-Length", end - start + 1);
      createReadStream(file.path, { start, end }).pipe(res);
      return;
    }

    // No range (or a Range we're safely ignoring per If-Range) -> full body.
    res.status(200);
    res.setHeader("Content-Length", sizeBytes);
    createReadStream(file.path).pipe(res);
  }
}
