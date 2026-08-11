// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/hls-file.controller.ts
//
// GET /playback/sessions/{id}/hls/media.m3u8 + GET
// /playback/sessions/{id}/hls/{file} (Phase 3 §11 step 6b, docs/
// PLAYBACK.md §9). Lane B never touches ffmpeg or drives the pipeline —
// this controller only reads playback_sessions columns the worker writes
// (staging_dir/status/produced_segment) and files under staging_dir the
// worker itself wrote (apps/worker/src/transcode/index.ts's module header,
// §4: "Lane B's GET handler ... just needs
// path.join(staging_dir, requestedRelativePath) — GUARDED exactly like
// this lane's own staging.ts guards").
//
// Route shape: `hls/media.m3u8` is a literal route (declared FIRST in this
// class — Express/Nest match in declaration order, verified empirically
// against this exact ambiguity before writing this file); `hls/*file`
// (Express 5 named wildcard) captures every OTHER `hls/...` request as a
// STRING ARRAY of path segments (`["run0", "s000000.m4s"]`), which this
// controller re-joins with "/" before validating against the strict
// filename pattern below.
//
// SEEK BIND (reported, docs/PLAYBACK.md §9's "outside produced range"
// language does not by itself define "outside" precisely for a segment
// GET): a requested segment index is treated as outside the produced
// window when EITHER (a) it is more than SEEK_LOOKAHEAD_SEGMENTS ahead of
// `produced_segment` (an explicit forward-seek/ABR-jump), OR (b) the file
// simply does not exist on disk yet (ENOENT) despite passing check (a) —
// covering "before the current run's start" (a segment from a run that
// hasn't been (re)started at that number yet, or one already pruned by
// retention, apps/worker/src/transcode/playlist.ts's `pruneRetention`).
// Either condition calls `requestSeek` (packages/db's seam-contract
// function, already implemented by Lane A) and responds 503 + Retry-After
// (hls.js-compatible: it already retries a 503 GET), never 404 — a 404
// would make hls.js treat the segment as permanently gone rather than
// "coming soon after a restart".
//
// SEEK-TARGET DERIVATION (docs/PLAYBACK.md §9 "Seek", C3): the millisecond
// value handed to `requestSeek` is derived from the REAL durations the
// worker actually produced — the `#EXTINF` values in the served
// `media.m3u8` this controller also serves — never from
// `segmentIndex * SEGMENT_DURATION_SEC * 1000`. Nominal arithmetic is
// wrong by construction: `-hls_time {SEG_DUR}` is a LOWER bound and
// `-force_key_frames expr:gte(t,n_forced*{SEG_DUR})`
// (packages/playback-engine/src/args/builder.ts §6) cuts at the first
// keyframe AT OR AFTER each mark, so a real segment is 6.006s..9s+ and the
// error COMPOUNDS with the index — tens of seconds by the middle of a
// feature. The derivation lives in ../common/served-playlist.ts (shared
// with the progress-ingestion path, which needs the same timeline
// arithmetic and cannot import this module across the D2 boundary).
//
// It is anchored PER RUN via migration 0043's `transcode_runs`
// (`getTranscodeRunForSegment`): the owning run supplies the SOURCE origin
// and the run's OWN real `#EXTINF` durations supply the offset within it,
// which makes the answer exact for EVERY run rather than only run 0. Run
// ownership follows the segment counter, never the clock — a backward seek
// starts a later run at an earlier source origin, so `source_origin_ms` is
// not monotonic and `start_segment` is the only key that is. A session with
// no recorded runs (one predating the migration) keeps the playlist-only
// fallback chain, and "no anchor" is never read as "origin 0"; the
// nominal constant survives only as the last resort when no served
// playlist is readable at all. The result is then clamped to
// `[0, durationMs]` — `requestSeek` writes `seek_target_ms` verbatim
// (packages/db/src/query/playback-sessions.ts, deliberately: it never
// re-derives a decision its caller already made), and an unclamped value
// becomes an ffmpeg `-ss` past EOF, i.e. a restart that produces nothing,
// forever.

import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Controller, Get, Param, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  getMediaInfoAssembly,
  getPlaybackSessionForUser,
  getTranscodeRunForSegment,
  requestSeek,
  updateRequestedSegment,
} from "@loombre/db";
import type { ViewerContext } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import { AllowQueryToken } from "../gateway/allow-query-token.decorator.js";
import { sanitizeInstancePath } from "../gateway/sanitize-instance.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import {
  clampSeekTargetMs,
  deriveSegmentStartMs,
  parseServedSegmentDurations,
  withMediaSequence,
  type RunAnchor,
  type ServedSegmentEntry,
} from "../common/served-playlist.js";
import { resolveViewer } from "./viewer.js";

const MANIFEST_POLL_TIMEOUT_MS = 8_000;
const MANIFEST_POLL_INTERVAL_MS = 250;
const SEGMENT_DURATION_SEC = 6;
const SEEK_LOOKAHEAD_SEGMENTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strictly matches the worker's own on-disk layout (apps/worker/src/
 *  transcode/staging.ts + playlist.ts's served-playlist rendering):
 *  `runN/sNNNNNN.{m4s,ts}` or `runN/init.mp4`. Anything else is rejected
 *  outright (traversal-safe by construction — no "..", no absolute path,
 *  no extra segments can ever match). */
const SEGMENT_FILE_PATTERN = /^run(\d+)\/(?:s(\d{6})\.(m4s|ts)|init\.mp4)$/;

interface ParsedSegmentFile {
  runIndex: number;
  segmentIndex: number | undefined; // undefined for init.mp4
  extension: "m4s" | "ts" | "mp4";
}

function parseSegmentFile(fileRelativePath: string): ParsedSegmentFile | undefined {
  const match = SEGMENT_FILE_PATTERN.exec(fileRelativePath);
  if (!match) return undefined;
  const runIndex = Number.parseInt(match[1]!, 10);
  if (match[2] !== undefined) {
    return { runIndex, segmentIndex: Number.parseInt(match[2], 10), extension: match[3] as "m4s" | "ts" };
  }
  return { runIndex, segmentIndex: undefined, extension: "mp4" };
}

const CONTENT_TYPE_BY_EXTENSION: Record<"m4s" | "ts" | "mp4", string> = {
  m4s: "video/iso.segment",
  ts: "video/mp2t",
  mp4: "video/mp4",
};

/** Guards a resolved candidate path stays strictly under `root` — mirrors
 *  apps/worker/src/transcode/staging.ts's own guard (this app cannot,
 *  and should not, import that OTHER app's internals — the check itself
 *  is small and worth duplicating rather than reaching across the
 *  apps/server<->apps/worker process boundary the seam contract forbids
 *  any other channel across). Defense in depth on top of
 *  SEGMENT_FILE_PATTERN already making traversal structurally
 *  impossible. */
function isStrictlyUnder(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function joinFileParam(file: unknown): string {
  if (Array.isArray(file)) return file.join("/");
  return typeof file === "string" ? file : "";
}

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class PlaybackHlsFileController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
  ) {}

  // Declared BEFORE the wildcard route below — Express/Nest match in
  // declaration order, so this literal path always wins over `hls/*file`
  // for an exact "media.m3u8" request (empirically verified against this
  // exact ambiguity before this file was written).
  //
  // STATE.md P4.15: one of the four `?token=` media GET families.
  // per-identity, GENEROUS ceiling (SurfaceRateLimiterService.mediaToken) —
  // hls.js re-fetches the manifest periodically during live-tail playback;
  // do not break that cadence.
  @AllowQueryToken()
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("mediaToken", "identity")
  @Get("playback/sessions/:id/hls/media.m3u8")
  async getManifest(@Param("id") id: string, @Req() req: AuthenticatedRequest, @Res() res: Response): Promise<void> {
    requireUuidParam(id, "Playback session not found.", sanitizeInstancePath(req));
    const ctx = await resolveViewer(this.viewerContextProvider, req);

    const deadline = Date.now() + MANIFEST_POLL_TIMEOUT_MS;
    for (;;) {
      const session = await getPlaybackSessionForUser(this.dbProvider.db, ctx, id);
      if (!session) {
        throw notFound("Playback session not found.", sanitizeInstancePath(req));
      }
      if (session.status === "ended" || session.status === "failed") {
        throw notFound("Playback session not found.", sanitizeInstancePath(req));
      }

      // "active" OR "suspended" — NOT active-only. migrations/0012's
      // `suspended_by_throttle` column comment documents that
      // `status = 'suspended'` has TWO independent causes sharing the one
      // enum value, and BOTH are exactly the resume path an authed owner's
      // manifest re-fetch needs to serve, not just the first one found:
      //
      //   1. The segment-ahead throttle (docs/PLAYBACK.md §9,
      //      apps/worker/src/transcode/throttle.ts) SIGSTOPs an encode
      //      that is >10 segments ahead and writes status='suspended',
      //      suspended_by_throttle=true; everything already produced
      //      stays on disk, and serving it is the entire point of pausing
      //      ahead. Serving only 'active' here deadlocked real playback
      //      (2026-08-08 owner QA, live-DB verified): hls.js's
      //      event-playlist re-polls 503'd the moment the throttle kicked
      //      in, the client stalled on its first 4-segment snapshot
      //      ("timeline shows 20-24s then pauses"), so requested_segment
      //      never advanced and the throttle's resume condition
      //      (ahead <= 5) was unreachable forever.
      //   2. Heartbeat-staleness: a client that stops sending heartbeats
      //      (backgrounded tab, network drop, ...) gets its session marked
      //      status='suspended', suspended_by_throttle=false by the
      //      server-side sweeper. A client reconnecting — or simply
      //      resuming after a brief stall — issues exactly the same
      //      manifest GET this route handles; refusing to serve it here
      //      would 404/503-loop a perfectly resumable session instead of
      //      letting it pick back up, the identical "serve what's already
      //      on disk" argument as case 1, just for a different root cause.
      //
      // DECISION: keep serving BOTH — this route does not need to (and
      // does not) distinguish suspended_by_throttle at all; "suspended"
      // itself is the servable state, regardless of which side wrote it.
      const manifestServable = session.status === "active" || session.status === "suspended";
      if (manifestServable && session.producedSegment !== null && session.stagingDir) {
        try {
          const text = await readFile(join(session.stagingDir, "media.m3u8"), "utf8");
          if (text.length > 0) {
            res.status(200);
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            res.setHeader("Cache-Control", "private, no-store");
            res.send(withMediaSequence(text));
            return;
          }
        } catch {
          // Raced the DB flip vs the file write, or a stale read during a
          // retention prune — fall through to the poll/503 path below.
        }
      }

      if (Date.now() >= deadline) {
        res.status(503);
        res.setHeader("Retry-After", "1");
        res.setHeader("Content-Type", "application/problem+json");
        res.send({
          type: "urn:loombre:problem:hls-not-ready",
          title: "HLS manifest not ready",
          status: 503,
          detail: "The initial segment has not been produced yet within the poll window.",
          instance: sanitizeInstancePath(req),
          code: "hls-not-ready",
        });
        return;
      }
      await sleep(MANIFEST_POLL_INTERVAL_MS);
    }
  }

  // STATE.md P4.15: per-identity, GENEROUS ceiling — SEEKING fires rapid
  // bursts of segment/range requests as hls.js buffers ahead or jumps
  // around; this must never be tight enough to be mistaken for a seeking
  // regression (the same class of bug as the Phase-3 CSP blob: incident).
  @AllowQueryToken()
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("mediaToken", "identity")
  @Get("playback/sessions/:id/hls/*file")
  async getSegment(
    @Param("id") id: string,
    @Param("file") fileParam: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    requireUuidParam(id, "Playback session not found.", sanitizeInstancePath(req));
    const ctx = await resolveViewer(this.viewerContextProvider, req);

    const relativePath = joinFileParam(fileParam);
    const parsed = parseSegmentFile(relativePath);
    if (!parsed) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    const session = await getPlaybackSessionForUser(this.dbProvider.db, ctx, id);
    if (!session || !session.stagingDir) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    const now = clockNowMs();

    if (parsed.segmentIndex !== undefined) {
      await updateRequestedSegment(this.dbProvider.db, ctx, id, parsed.segmentIndex, now);
    }

    // Seek detection (module header's BIND) — checked BEFORE ever
    // touching the filesystem for a numeric segment index (init.mp4 has
    // no index to seek to; a missing init.mp4 falls through to the plain
    // ENOENT->503 path below instead).
    if (parsed.segmentIndex !== undefined) {
      const ahead = session.producedSegment === null ? Number.POSITIVE_INFINITY : parsed.segmentIndex - session.producedSegment;
      if (ahead > SEEK_LOOKAHEAD_SEGMENTS) {
        const targetMs = await this.resolveSeekTargetMs(ctx, session, parsed.segmentIndex);
        await requestSeek(this.dbProvider.db, ctx, id, targetMs, now);
        this.respondSeekRetry(res, sanitizeInstancePath(req));
        return;
      }
    }

    const absolutePath = join(session.stagingDir, relativePath);
    if (!isStrictlyUnder(session.stagingDir, absolutePath)) {
      throw notFound("Playback session not found.", sanitizeInstancePath(req));
    }

    let sizeBytes: number;
    try {
      sizeBytes = (await stat(absolutePath)).size;
    } catch {
      // "Before run-start" / already-pruned — module header's BIND part
      // (b): also a seek-worthy condition for a real segment index; for
      // init.mp4 (no index), just ask the client to retry shortly.
      if (parsed.segmentIndex !== undefined) {
        const targetMs = await this.resolveSeekTargetMs(ctx, session, parsed.segmentIndex);
        await requestSeek(this.dbProvider.db, ctx, id, targetMs, now);
      }
      this.respondSeekRetry(res, sanitizeInstancePath(req));
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", CONTENT_TYPE_BY_EXTENSION[parsed.extension]);
    res.setHeader("Cache-Control", "private, immutable");
    res.setHeader("Content-Length", sizeBytes);
    createReadStream(absolutePath).pipe(res);
  }

  /**
   * The ms value handed to `requestSeek` — module header's SEEK-TARGET
   * DERIVATION note. Runs ONLY on a seek path (both call sites are already
   * inside a 503-and-restart branch), never on the hot segment-serving
   * path: CLAUDE.md invariant 9 (Tier-0 — request paths do no CPU-heavy
   * work) is satisfied by rarity plus the work itself being one small
   * text read plus a linear scan of a playlist that retention keeps
   * bounded, not by any caching this would otherwise need.
   *
   * Every failure degrades rather than throws — a seek-restart is the
   * recovery path for a client that is ALREADY stalled, so a 500 here
   * would turn a recoverable stall into a dead session. An unreadable
   * playlist falls back to nominal arithmetic; an unresolvable media
   * assembly drops only the upper clamp.
   */
  private async resolveSeekTargetMs(ctx: ViewerContext, session: { id: string; stagingDir: string | null; itemId: string | null; fileId: string | null }, segmentIndex: number): Promise<number> {
    let entries: ServedSegmentEntry[] = [];
    if (session.stagingDir) {
      try {
        entries = parseServedSegmentDurations(await readFile(join(session.stagingDir, "media.m3u8"), "utf8"));
      } catch {
        // No served playlist yet (or a read that raced the worker's
        // atomic rewrite) — `deriveSegmentStartMs` falls back to nominal.
      }
    }

    // The owning run (migration 0043's transcode_runs, Lane A1) turns the
    // derivation from a presentation-timeline approximation into an EXACT
    // SOURCE-timeline answer for every run, not just run 0 — see
    // served-playlist.ts's `deriveSegmentStartMs`. `undefined` (a session
    // predating the migration, or one whose pipeline never recorded a run)
    // keeps the playlist-only fallback chain: it must never be read as
    // "origin 0".
    let run: RunAnchor | undefined;
    try {
      run = await getTranscodeRunForSegment(this.dbProvider.db, session.id, segmentIndex);
    } catch {
      // Never fail a seek over the run map — degrade to playlist-only.
    }

    const derivedMs = deriveSegmentStartMs(entries, segmentIndex, SEGMENT_DURATION_SEC * 1000, run);

    let durationMs: number | null = null;
    if (session.fileId) {
      try {
        const assembly = await getMediaInfoAssembly(this.dbProvider.db, ctx, {
          fileId: session.fileId,
          ...(session.itemId ? { itemId: session.itemId } : {}),
        });
        durationMs = assembly?.media.durationMs ?? null;
      } catch {
        // Unprobed/vanished file — clamp with the lower bound only.
      }
    }
    return clampSeekTargetMs(derivedMs, durationMs);
  }

  private respondSeekRetry(res: Response, instance: string): void {
    res.status(503);
    res.setHeader("Retry-After", "1");
    res.setHeader("Content-Type", "application/problem+json");
    res.send({
      type: "urn:loombre:problem:hls-segment-not-ready",
      title: "HLS segment not ready",
      status: 503,
      detail: "The requested segment is outside the produced window; a seek restart has been requested.",
      instance,
      code: "hls-segment-not-ready",
    });
  }
}
