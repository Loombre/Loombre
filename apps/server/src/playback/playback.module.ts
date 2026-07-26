// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module.js";
import { CommonSettingsModule } from "../common/common-settings.module.js";
import { PlaybackPlanController } from "./plan.controller.js";
import { PlaybackSessionsController } from "./sessions.controller.js";
import { PlaybackSessionFileController } from "./session-file.controller.js";
import { PlaybackHlsFileController } from "./hls-file.controller.js";
import { PlaybackSubtitleFileController } from "./subtitle-file.controller.js";
import { PlaybackSessionSweeperService } from "./session-sweeper.service.js";

/**
 * Playback module: wraps the pure `@loombre/playback-engine` `plan()`
 * decision function with session management and HLS packaging (docs/
 * PLAN.md §3, §7). Enforced boundary — must never import catalog/ or
 * session/; dependency-cruiser fails the build if it does (D2).
 * Communicates with the other modules only via IDs over the DB and domain
 * events.
 *
 * Phase 3 §11 step 6b (STATE.md P3.7, docs/PLAYBACK.md §9): the Phase-2
 * static compatibility preview is gone — every operation now runs the real
 * `plan()` engine. POST /playback/plan returns the full §5 PlaybackPlan;
 * POST /playback/sessions runs admission control + enqueues the
 * 'transcode'/'subtitle-extract' worker jobs for any non-direct-play
 * decision / hls-vtt subtitle strategy respectively; GET
 * /playback/sessions/{id}/hls/media.m3u8 + /hls/{file} serve the live HLS
 * media playlist + segments the worker produces; GET
 * /playback/sessions/{id}/subtitles/media.m3u8 + /subtitles/{file} serve
 * the segmented-VTT subtitle side-track (STATE.md P3.9(e)). Direct-play
 * sessions still bypass all of the above (docs/PLAYBACK.md §9) and are
 * served exactly as in Phase 2 via PlaybackSessionFileController's range
 * serving.
 *
 * Addendum A, lane S3: also imports CommonSettingsModule — needed for
 * ViewerContextProvider (used by every controller here) and, via that
 * module's re-export of SettingsModule, SettingsService itself for
 * PlaybackSessionSweeperService (sessions.staleCutoffMs/
 * heartbeatSuspendCutoffMs, re-resolved every sweep tick) and for
 * plan.controller.ts/sessions.controller.ts's ServerPolicy assembly
 * (transcode.* knobs, re-resolved per plan/admission request).
 */
@Module({
  imports: [CommonModule, CommonSettingsModule],
  controllers: [
    PlaybackPlanController,
    PlaybackSessionsController,
    PlaybackSessionFileController,
    PlaybackHlsFileController,
    PlaybackSubtitleFileController,
  ],
  providers: [PlaybackSessionSweeperService],
})
export class PlaybackModule {}
