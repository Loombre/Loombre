// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/playback/plan.controller.ts
//
// POST /playback/plan (Phase 3 §11 step 6b, STATE.md P3.7): resolves the
// item's primary (or explicitly requested) media file via the guarded
// MediaInfo assembly, assembles the full engine PlanInput
// (plan-assembly.ts), and returns the REAL `@loombre/playback-engine`
// `plan()` output — the full docs/PLAYBACK.md §5 PlaybackPlan. This
// REPLACES Phase 2's checkStaticCompat()-based {canDirectPlay,
// wouldBeReasons} preview (STATE.md P2.17), which is deleted along with the
// engine's compat-preview.ts module. Read-only: no session row is created,
// no job is enqueued.

import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { plan } from "@loombre/playback-engine";
import { getMediaInfoAssembly, getUserSettings } from "@loombre/db";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { ViewerContextProvider } from "../common/viewer-context.provider.js";
import { DeviceProfileValidatorService } from "../common/device-profile-validator.js";
import { SettingsService } from "../settings/settings.service.js";
import { resolveViewer } from "./viewer.js";
import { parsePlanRequestBody } from "./plan-request.js";
import { assemblePlanInput } from "./plan-assembly.js";

@Controller()
export class PlaybackPlanController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly viewerContextProvider: ViewerContextProvider,
    private readonly deviceProfileValidator: DeviceProfileValidatorService,
    private readonly settingsService: SettingsService,
  ) {}

  @HttpCode(200)
  @Post("playback/plan")
  async computePlaybackPlan(@Body() rawBody: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = parsePlanRequestBody(rawBody, this.deviceProfileValidator);
    if (!parsed.ok) {
      throw unprocessableEntity(parsed.detail, req.originalUrl);
    }

    const ctx = await resolveViewer(this.viewerContextProvider, req);

    const assembly = await getMediaInfoAssembly(this.dbProvider.db, ctx, {
      itemId: parsed.value.itemId,
      ...(parsed.value.mediaFileId !== undefined ? { fileId: parsed.value.mediaFileId } : {}),
    });
    if (!assembly) {
      throw notFound("Item or media file not found.", req.originalUrl);
    }

    // §2.6 selection's optional language-preference fallback (STATE.md
    // Wave-3 note n4: user_settings.prefs is a free-form JSONB whitelist
    // entry — audioPreferredLanguage has no typed column and PUT
    // /users/me/settings never persists it today, but reading it here
    // costs nothing and honors any future/manual write to that key
    // honestly rather than hard-coding "no preference ever exists").
    const settings = await getUserSettings(this.dbProvider.db, ctx.userId);
    const audioLanguagePref = (settings?.prefs?.["audioPreferredLanguage"] as string | null | undefined) ?? null;

    const planInput = await assemblePlanInput({
      db: this.dbProvider.db,
      req,
      assembly,
      parsed: parsed.value,
      audioLanguagePref,
      settingsService: this.settingsService,
    });

    return plan(planInput);
  }
}
