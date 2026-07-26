// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/settings/admin-settings.controller.ts
//
// STATE.md Addendum A, decision A6 (lane S2): GET /admin/settings, GET
// /admin/settings/schema, PUT /admin/settings/{key} — the admin settings
// surface's HTTP wiring around lane S1's SettingsService/ProviderKeysService
// (settings.service.ts / provider-keys.service.ts, FROZEN this lane — see
// settings.service.ts's own header for the PUT /admin/settings/{key} check
// ordering: A10 live-admin re-verify (403) -> unknown/env-only key (404) ->
// env-pin (409) -> schema validation (422) -> F9 cross-field validation
// (422), all inside updateSetting() itself).
//
// Security review F1c (supersedes the original mission spec's "reads can
// stay claim-gated like other admin reads"): the two GETs below were
// claim-gated (req.user.isAdmin from the JWT access-token claim, which can
// be stale for up to the token's 15-minute lifetime after a demotion) —
// database.url's EFFECTIVE VALUE embeds the Postgres password, so a window
// existed where a just-demoted admin could still read it. Both GETs now
// call SettingsService.assertLiveAdmin() (A10's fresh users.is_admin DB
// read, the same check updateSetting() has always used) as their own first
// step. The PUT still does NOT call assertLiveAdmin() here separately:
// SettingsService.updateSetting() calls it internally as ITS first step —
// calling it a second time in this controller would only add a redundant
// extra DB round trip in front of the real check.
//
// GET /admin/settings/schema carries no provider-key statuses: contract's
// AdminSettingsSchemaResponse is the pure registry projection only (no live
// value of any kind, including provider-key status) — see
// AdminSettingSchemaEntryDto's own doc comment in settings.types.ts.
// Provider-key statuses ride on GET /admin/settings's `providerKeys` alone
// (mission spec's "GET never exists for key VALUES anywhere").

import { Body, Controller, Get, Param, Put, Req } from "@nestjs/common";
import { nowMs as clockNowMs } from "@loombre/shared";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { SettingsService } from "./settings.service.js";
import { ProviderKeysService } from "./provider-keys.service.js";
import type {
  AdminSettingsResponseDto,
  AdminSettingsSchemaResponseDto,
  UpdateSettingResponseDto,
} from "./settings.types.js";

@Controller("admin/settings")
export class AdminSettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly providerKeysService: ProviderKeysService,
  ) {}

  @Get()
  async getSettings(@Req() req: AuthenticatedRequest): Promise<AdminSettingsResponseDto> {
    await this.settingsService.assertLiveAdmin(req.user!.userId, req.originalUrl);
    const providerKeys = await this.providerKeysService.allProviderKeyStatuses();
    return this.settingsService.toAdminSettingsResponse(providerKeys);
  }

  @Get("schema")
  async getSchema(@Req() req: AuthenticatedRequest): Promise<AdminSettingsSchemaResponseDto> {
    await this.settingsService.assertLiveAdmin(req.user!.userId, req.originalUrl);
    return this.settingsService.toSchemaResponse();
  }

  @Put(":key")
  async updateSetting(
    @Param("key") key: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<UpdateSettingResponseDto> {
    const body = rawBody ?? {};
    return this.settingsService.updateSetting({
      key,
      value: body["value"],
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }
}
