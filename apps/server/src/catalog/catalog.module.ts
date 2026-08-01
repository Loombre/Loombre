// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module.js";
import { CommonSettingsModule } from "../common/common-settings.module.js";
import { VideoController } from "./video.controller.js";
import { MusicController } from "./music.controller.js";
import { CrossTypeController } from "./cross-type.controller.js";
import { ProgressController } from "./progress.controller.js";
import { PeopleTagsController } from "./people-tags.controller.js";
import { ImagesController } from "./images.controller.js";
import { LibrariesController } from "./libraries.controller.js";
import { UsersController } from "./users.controller.js";
import { DevicesController } from "./devices.controller.js";
import { AdminController } from "./admin.controller.js";
import { DataFreedomController } from "./data-freedom.controller.js";
import { WatchlistController } from "./watchlist.controller.js";
import { ChaptersController } from "./chapters.controller.js";

/**
 * Catalog module: scanner control, metadata, images, search (docs/PLAN.md §3,
 * §8) — and, this wave (P1.17), the full set of catalog/cross-type/progress/
 * people-tags/images/libraries/users/devices/admin/data-freedom REST
 * controllers the mission's "catalog module" umbrella describes, plus
 * watchlist (Phosphor Wave 2 lane L3). Enforced
 * boundary — must never import playback/ or session/ directly;
 * dependency-cruiser fails the build if it does (D2). Every controller here
 * gets its DB handle + ViewerContext + job queue + hash service from
 * CommonModule (apps/server/src/common), a fourth directory the D2 rules
 * don't restrict — see common/common.module.ts's header for why that
 * exists instead of importing session/ directly.
 *
 * Addendum A, lane S3: also imports CommonSettingsModule for
 * ViewerContextProvider/UpdateCheckService/SurfaceRateLimiterService/
 * SurfaceRateLimitGuard (all now SettingsService-dependent, see that
 * module's header) plus SettingsService itself (re-exported by
 * CommonSettingsModule) for controllers reading A3 settings directly
 * (libraries.controller.ts's restricted.enabled check).
 */
@Module({
  imports: [CommonModule, CommonSettingsModule],
  controllers: [
    VideoController,
    MusicController,
    CrossTypeController,
    ProgressController,
    PeopleTagsController,
    ImagesController,
    LibrariesController,
    UsersController,
    DevicesController,
    AdminController,
    DataFreedomController,
    WatchlistController,
    ChaptersController,
  ],
})
export class CatalogModule {}
