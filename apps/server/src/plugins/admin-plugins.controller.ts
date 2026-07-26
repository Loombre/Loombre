// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-plugins.controller.ts
//
// Lane W5: HTTP wiring for packages/contract/openapi.yaml's "Admin: plugins"
// section around Lane W2's PluginRegistrationService/PluginLifecycleService/
// PluginHealthService, plus this lane's own AdminPluginPreviewService
// (preview, W2 had nothing to fetch-and-not-persist) and
// AdminPluginGrantsService (event-grants, W2 had no grants-only DB
// primitive — see that file's header). Mirrors
// apps/server/src/settings/admin-settings.controller.ts's shape: every
// mutation reads `req.user!.userId` and hands it to the service as
// `actorUserId`; every service call does its OWN requireLiveAdmin as its
// first step (never re-checked a second time here — same reasoning
// admin-settings.controller.ts's header gives for updateSetting()). Reads
// (list/get) go straight through @loombre/db's public barrel — the same DB
// handle W2's services hold (DbProvider is a singleton per Nest module
// tree), never a raw pg/kysely import (dependency-cruiser).
//
// Request bodies are read defensively (`rawBody ?? {}`, individual fields
// coerced with `?? []`/`?? {}` rather than trusted) — same posture
// admin-settings.controller.ts's updateSetting() takes, so a bodyless
// conformance-walk request reaches the FIRST real validation step (404
// "not found" for path-param operations without ever inspecting the body;
// 422 "url is required" for previewAdminPlugin/registerAdminPlugin, which
// have no path param to 404 on first) rather than crashing on `undefined`.
//
// hmacSecret (registerAdminPlugin, rotateAdminPluginHmac) is the ONLY place
// a plugin secret ever appears in a response body — every other route
// returns AdminPluginDto, whose `config` field already excludes secret
// values (LD1, enforced by W2's validatePluginConfig before persistence).
//
// Lane W5b: AdminPluginPseudonymizationService (pseudonymization toggle —
// new route below) joins the two W5 services above; toDto()/list() now also
// resolve each plugin's plugin_delivery_cursors row (getDeliveryCursor) into
// AdminPluginDto's additive deliveryStatus field. Every OTHER
// AdminPluginDto-returning route still calls toAdminPluginDto with its
// deliveryStatus argument omitted (-> null) — see admin-plugin-dto.ts's
// header for why that is intentional, not an oversight.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from "@nestjs/common";
import { nowMs as clockNowMs } from "@loombre/shared";
import { getDeliveryCursor, getPluginById, getPluginEventGrants, listPlugins } from "@loombre/db";
import { DbProvider } from "../common/db.provider.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { notFound } from "../gateway/problem.exception.js";
import { requireLiveAdmin } from "../settings/require-live-admin.js";
import { PluginLifecycleService } from "./plugin-lifecycle.service.js";
import { PluginRegistrationService } from "./plugin-registration.service.js";
import { AdminPluginGrantsService } from "./admin-plugin-grants.service.js";
import { AdminPluginPreviewService } from "./admin-plugin-preview.service.js";
import { AdminPluginPseudonymizationService } from "./admin-plugin-pseudonymization.service.js";
import { toAdminPluginDto } from "./admin-plugin-dto.js";
import type {
  AdminPluginDto,
  AdminPluginListDto,
  PluginManifestPreviewDto,
  RefreshPluginResponseDto,
  RegisterPluginResponseDto,
  RotatePluginHmacResponseDto,
} from "./admin-plugin-dto.js";

@Controller("admin/plugins")
export class AdminPluginsController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly registrationService: PluginRegistrationService,
    private readonly lifecycleService: PluginLifecycleService,
    private readonly previewService: AdminPluginPreviewService,
    private readonly grantsService: AdminPluginGrantsService,
    private readonly pseudonymizationService: AdminPluginPseudonymizationService,
  ) {}

  /** GET handlers have no mutating W2 service call to piggyback a live-admin
   *  check on (every mutation below re-verifies as ITS OWN first step,
   *  mirroring admin-settings.controller.ts's own updateSetting() —
   *  see this file's header) — so both read routes call requireLiveAdmin
   *  directly here, exactly like admin-settings.controller.ts's
   *  getSettings()/getSchema() call settingsService.assertLiveAdmin(). */
  private async toDto(pluginId: string, actorUserId: string): Promise<AdminPluginDto> {
    await requireLiveAdmin(this.dbProvider.db, actorUserId, `/admin/plugins/${pluginId}`);
    const plugin = await getPluginById(this.dbProvider.db, pluginId);
    if (!plugin) throw notFound("Plugin not found.", `/admin/plugins/${pluginId}`);
    const eventGrants = await getPluginEventGrants(this.dbProvider.db, pluginId);
    const deliveryCursor = (await getDeliveryCursor(this.dbProvider.db, pluginId)) ?? null;
    return toAdminPluginDto(plugin, eventGrants, deliveryCursor);
  }

  @Post("preview")
  @HttpCode(HttpStatus.OK)
  async preview(
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<PluginManifestPreviewDto> {
    const body = rawBody ?? {};
    const lanAllowlist = Array.isArray(body["lanAllowlist"]) ? (body["lanAllowlist"] as string[]) : [];
    return this.previewService.preview(body["url"], lanAllowlist, req.user!.userId);
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<AdminPluginListDto> {
    await requireLiveAdmin(this.dbProvider.db, req.user!.userId, "/admin/plugins");
    const rows = await listPlugins(this.dbProvider.db);
    const items = await Promise.all(
      rows.map(async (plugin) => {
        const eventGrants = await getPluginEventGrants(this.dbProvider.db, plugin.id);
        const deliveryCursor = (await getDeliveryCursor(this.dbProvider.db, plugin.id)) ?? null;
        return toAdminPluginDto(plugin, eventGrants, deliveryCursor);
      }),
    );
    return { items };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<RegisterPluginResponseDto> {
    const body = rawBody ?? {};
    const outcome = await this.registrationService.registerPlugin({
      baseUrl: body["url"] as string,
      grantedCapabilityTypes: Array.isArray(body["grantedCapabilityTypes"]) ? (body["grantedCapabilityTypes"] as string[]) : [],
      eventTypeGrants: Array.isArray(body["eventTypeGrants"]) ? (body["eventTypeGrants"] as string[]) : [],
      configValues: (body["config"] as Record<string, unknown> | undefined) ?? {},
      lanAllowlist: Array.isArray(body["lanAllowlist"]) ? (body["lanAllowlist"] as string[]) : [],
      ...(typeof body["manifestDigest"] === "string" ? { manifestDigest: body["manifestDigest"] } : {}),
      actorUserId: req.user!.userId,
    });
    return {
      plugin: toAdminPluginDto(outcome.plugin, outcome.eventGrants),
      hmacSecret: outcome.hmacSecret,
    };
  }

  @Get(":id")
  async get(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<AdminPluginDto> {
    return this.toDto(id, req.user!.userId);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.lifecycleService.removePlugin(id, req.user!.userId, clockNowMs());
  }

  @Put(":id/config")
  async updateConfig(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminPluginDto> {
    const body = rawBody ?? {};
    const config = (body["config"] as Record<string, unknown> | undefined) ?? {};
    const plugin = await this.lifecycleService.updateConfig(id, config, req.user!.userId, clockNowMs());
    const eventGrants = await getPluginEventGrants(this.dbProvider.db, id);
    return toAdminPluginDto(plugin, eventGrants);
  }

  @Put(":id/event-grants")
  async updateEventGrants(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminPluginDto> {
    const body = rawBody ?? {};
    const eventTypeGrants = Array.isArray(body["eventTypeGrants"]) ? (body["eventTypeGrants"] as string[]) : [];
    const plugin = await this.grantsService.setEventGrants(id, eventTypeGrants, req.user!.userId, clockNowMs());
    const eventGrants = await getPluginEventGrants(this.dbProvider.db, id);
    return toAdminPluginDto(plugin, eventGrants);
  }

  @Put(":id/pseudonymization")
  async updatePseudonymization(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminPluginDto> {
    const body = rawBody ?? {};
    const plugin = await this.pseudonymizationService.setPseudonymization(id, body["enabled"], req.user!.userId, clockNowMs());
    const eventGrants = await getPluginEventGrants(this.dbProvider.db, id);
    return toAdminPluginDto(plugin, eventGrants);
  }

  @Post(":id/enable")
  @HttpCode(HttpStatus.OK)
  async enable(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<AdminPluginDto> {
    const plugin = await this.lifecycleService.setEnabled(id, true, req.user!.userId, clockNowMs());
    const eventGrants = await getPluginEventGrants(this.dbProvider.db, id);
    return toAdminPluginDto(plugin, eventGrants);
  }

  @Post(":id/disable")
  @HttpCode(HttpStatus.OK)
  async disable(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<AdminPluginDto> {
    const plugin = await this.lifecycleService.setEnabled(id, false, req.user!.userId, clockNowMs());
    const eventGrants = await getPluginEventGrants(this.dbProvider.db, id);
    return toAdminPluginDto(plugin, eventGrants);
  }

  @Post(":id/refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<RefreshPluginResponseDto> {
    const outcome = await this.registrationService.refreshPlugin(id, req.user!.userId, clockNowMs());
    const eventGrants = await getPluginEventGrants(this.dbProvider.db, id);
    return {
      plugin: toAdminPluginDto(outcome.plugin, eventGrants),
      expanded: outcome.expanded,
      reasons: outcome.reasons,
    };
  }

  @Post(":id/reapprove")
  @HttpCode(HttpStatus.OK)
  async reapprove(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminPluginDto> {
    const body = rawBody ?? {};
    const plugin = await this.registrationService.reapprovePlugin(
      id,
      {
        grantedCapabilityTypes: Array.isArray(body["grantedCapabilityTypes"]) ? (body["grantedCapabilityTypes"] as string[]) : [],
        eventTypeGrants: Array.isArray(body["eventTypeGrants"]) ? (body["eventTypeGrants"] as string[]) : [],
        ...(typeof body["manifestDigest"] === "string" ? { manifestDigest: body["manifestDigest"] } : {}),
      },
      req.user!.userId,
      clockNowMs(),
    );
    const eventGrants = await getPluginEventGrants(this.dbProvider.db, id);
    return toAdminPluginDto(plugin, eventGrants);
  }

  @Post(":id/rotate-hmac")
  @HttpCode(HttpStatus.OK)
  async rotateHmac(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<RotatePluginHmacResponseDto> {
    const hmacSecret = await this.lifecycleService.rotateHmac(id, req.user!.userId, clockNowMs());
    return { hmacSecret };
  }
}
