// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/sessions.controller.ts
//
// POST /playback/sessions, GET /playback/sessions/{id}, DELETE
// /playback/sessions/{id} (Phase 3 §11 step 6b, docs/PLAYBACK.md §9).
// Session create now runs the REAL `plan()` engine (STATE.md P3.7):
//   - decision === 'direct-play'  -> EXACTLY the Phase 2 path (no
//     admission check, no job — createPlaybackSession itself sets initial
//     status 'active').
//   - any OTHER decision (direct-stream/remux/transcode) -> creation runs
//     through transcode-admission.ts's gate, which counts and inserts in
//     one critical section (429 'transcode-slots-exhausted' when the
//     global active-ish-transcode-session count already meets the resolved
//     policy's cap); a genuinely UNPLAYABLE transcode plan (empty
//     ffmpegArgs — tone-map-refused-by-policy or a degenerate empty
//     ladder) is a 409 'media-unplayable' carrying the plan's own reasons
//     instead of a row; otherwise the row is created ('created' status,
//     per packages/db's own decision-branch) and a 'transcode' job is
//     enqueued.
// Independent of decision: a plan whose `subtitle.strategy === 'hls-vtt'`
// ALSO enqueues 'subtitle-extract' (STATE.md P3.9(e) — works for
// direct-play sessions too, docs/PLAYBACK.md §9's "direct-play bypasses
// all of this" is about the VIDEO/AUDIO pipeline only).
//
// Addendum A, lane S3 — THE LAW (A5: "no setting change may ever drop an
// active playback session"): `planInput.policy.maxSimultaneousTranscodes`
// below is resolved from SettingsService FRESH on every call to this
// handler (plan-assembly.ts -> resolve-policy.ts's
// resolveServerPolicyFromSettings), i.e. AT ADMISSION TIME for THIS
// request only. A transcode.maxSimultaneousTranscodes reduction therefore
// only ever changes the outcome of `activeCount >= cap` for a brand-new
// POST here — it can never reach back and touch a playback_sessions row
// that already exists, since nothing in this handler (or anywhere else)
// re-evaluates the cap against an existing row after creation (the gate
// takes the cap as a per-request argument for exactly that reason).

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { plan } from "@loombre/playback-engine";
import {
  countActiveTranscodeSessions,
  createPlaybackSession,
  endPlaybackSession,
  getMediaInfoAssembly,
  getPlaybackSessionForUser,
  getUserSettings,
} from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { DeviceProfileValidatorService } from "../common/device-profile-validator.js";
import { JobQueueProvider } from "../common/job-queue.provider.js";
import { SettingsService } from "../settings/settings.service.js";
import { resolveViewer } from "./viewer.js";
import { parsePlanRequestBody } from "./plan-request.js";
import { assemblePlanInput } from "./plan-assembly.js";
import { UnplayableMediaException } from "./unplayable-media.exception.js";
import { TranscodeSlotsExhaustedException } from "./transcode-slots-exhausted.exception.js";
import { transcodeAdmissionGate } from "./transcode-admission.js";
import { toContractPlaybackSession } from "./session-plan.js";
import { cleanupDirectPlaySubtitleStagingDir } from "./direct-play-subs-cleanup.js";

@Controller()
export class PlaybackSessionsController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
    private readonly deviceProfileValidator: DeviceProfileValidatorService,
    private readonly jobQueueProvider: JobQueueProvider,
    private readonly settingsService: SettingsService,
  ) {}

  @Post("playback/sessions")
  async createSession(@Body() rawBody: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = parsePlanRequestBody(rawBody, this.deviceProfileValidator);
    if (!parsed.ok) {
      throw unprocessableEntity(parsed.detail, req.originalUrl);
    }

    const deviceId = req.user?.deviceId;
    if (!deviceId) {
      throw unprocessableEntity("This access token has no associated device.", req.originalUrl);
    }

    const ctx = await resolveViewer(this.viewerContextProvider, req);

    const assembly = await getMediaInfoAssembly(this.dbProvider.db, ctx, {
      itemId: parsed.value.itemId,
      ...(parsed.value.mediaFileId !== undefined ? { fileId: parsed.value.mediaFileId } : {}),
    });
    if (!assembly) {
      throw notFound("Item or media file not found.", req.originalUrl);
    }

    // See plan.controller.ts's computePlaybackPlan for why both prefs are
    // read here (H1, orchestrator adjudication A-5: user_settings.prefs is
    // a real writer now, not a no-op).
    const settings = await getUserSettings(this.dbProvider.db, ctx.userId);
    const audioLanguagePref = (settings?.prefs?.["audioPreferredLanguage"] as string | null | undefined) ?? null;
    const subtitleLanguagePref = (settings?.prefs?.["subtitlePreferredLanguage"] as string | null | undefined) ?? null;

    const planInput = await assemblePlanInput({
      db: this.dbProvider.db,
      req,
      assembly,
      parsed: parsed.value,
      audioLanguagePref,
      subtitleLanguagePref,
      settingsService: this.settingsService,
    });

    const planResult = plan(planInput);

    if (planResult.decision !== "direct-play") {
      // Genuinely unplayable (BIND, reported): decision reached
      // 'transcode' but the engine produced no usable ffmpeg invocation at
      // all — tone-map-refused-by-policy, or a degenerate empty-ladder
      // plan (packages/playback-engine/src/plan.ts's own documented edge
      // case). Every OTHER non-direct-play decision proceeds normally.
      const isUnplayable = planResult.decision === "transcode" && planResult.ffmpegArgs.length === 0;
      if (isUnplayable) {
        throw new UnplayableMediaException(planResult.reasons, req.originalUrl);
      }
    }

    const create = () =>
      createPlaybackSession(this.dbProvider.db, ctx, {
        itemId: assembly.itemId,
        fileId: assembly.fileId,
        deviceId,
        // The `selection` sidecar key is REQUIRED, not part of the engine's
        // own §5 output (apps/worker/src/transcode/plan-shape.ts's header —
        // the seek-restart path needs it back to regenerate ffmpeg args).
        plan: { ...planResult, selection: planInput.selection },
        engineVersion: planResult.engineVersion,
        nowMs: clockNowMs(),
      });

    // Direct-play creates straight through (it occupies no slot); every
    // other decision goes through the gate, which counts AND inserts inside
    // ONE critical section — see transcode-admission.ts's header for why a
    // standalone pre-check here was a check-then-act race that let the cap
    // be exceeded.
    const admission =
      planResult.decision === "direct-play"
        ? ({ admitted: true, created: await create() } as const)
        : await transcodeAdmissionGate.admit({
            cap: planInput.policy.maxSimultaneousTranscodes,
            countActive: () => countActiveTranscodeSessions(this.dbProvider.db),
            create,
          });
    if (!admission.admitted) {
      throw new TranscodeSlotsExhaustedException(req.originalUrl);
    }
    const session = admission.created;
    if (!session) {
      throw notFound("Item or media file not found.", req.originalUrl);
    }

    if (planResult.decision !== "direct-play") {
      await this.jobQueueProvider.queue.enqueue("transcode", { sessionId: session.id });
    }
    // STATE.md P3.9(e): independent of decision — a direct-play session
    // can still carry an hls-vtt subtitle side-track.
    if (planResult.subtitle.strategy === "hls-vtt") {
      await this.jobQueueProvider.queue.enqueue("subtitle-extract", { sessionId: session.id });
    }

    return toContractPlaybackSession(session, assembly.media as unknown as Record<string, unknown>);
  }

  @Get("playback/sessions/:id")
  async getSession(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Playback session not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const session = await getPlaybackSessionForUser(this.dbProvider.db, ctx, id);
    if (!session) {
      throw notFound("Playback session not found.", req.originalUrl);
    }

    // media re-assembled from the session's file each read (not stored on
    // the session row — same "derive, don't duplicate" posture as every
    // other guarded read in this package). Omitted, not 404/500, when the
    // owning file/item can no longer be resolved (module header on
    // playback-sessions.ts: itemId can go null if the file was
    // hard-deleted since the session started) — a diagnosability field
    // going missing is not grounds to fail the whole session read.
    const assembly =
      session.itemId !== null && session.fileId !== null
        ? await getMediaInfoAssembly(this.dbProvider.db, ctx, { itemId: session.itemId, fileId: session.fileId })
        : undefined;

    return toContractPlaybackSession(session, assembly?.media as unknown as Record<string, unknown> | undefined);
  }

  @Delete("playback/sessions/:id")
  @HttpCode(204)
  async endSession(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    requireUuidParam(id, "Playback session not found.", req.originalUrl);
    const ctx = await resolveViewer(this.viewerContextProvider, req);
    const ended = await endPlaybackSession(this.dbProvider.db, ctx, id, clockNowMs());
    if (!ended) {
      throw notFound("Playback session not found.", req.originalUrl);
    }
    // See direct-play-subs-cleanup.ts's header: the ONE case Lane B must
    // still clean up a staging directory on disk itself.
    await cleanupDirectPlaySubtitleStagingDir(ended);
  }
}
