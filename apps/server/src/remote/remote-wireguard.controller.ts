// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-wireguard.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R1/R2/R3, RG15, Wave 0 —
// lane/remote-base). Six ops (tag `remote`, packages/contract/openapi.yaml):
//   - POST   /admin/remote/wireguard/enable            enableRemoteWireguard
//   - POST   /admin/remote/wireguard/disable            disableRemoteWireguard
//   - GET    /admin/remote/wireguard/status             getRemoteWireguardStatus
//   - GET    /admin/remote/wireguard/devices            listRemoteWireguardDevices
//   - POST   /admin/remote/wireguard/devices            enrollRemoteWireguardDevice
//   - DELETE /admin/remote/wireguard/devices/{id}       revokeRemoteWireguardDevice
//
// Lane WG1: enable/disable/status delegate to RemoteWireguardService
// (./wireguard/remote-wireguard.service.js) — requireAdmin still runs
// FIRST, unchanged from the Wave-0 freeze ("route paths/methods/admin-gate
// ordering are frozen ... do not change"; see remote-wireguard.service.ts's
// own header for why the service does NOT re-check admin a second time).
//
// Lane WG2: the three devices ops (enroll/list/revoke) now delegate to the
// SAME service's listDevices/enrollDevice/revokeDevice methods, replacing
// their Wave-0 501 shells. Body coercion is hand-rolled (no class-validator
// DTOs anywhere in this codebase — remote-tunnel.controller.ts's own header
// states the same house precedent): a bodyless/malformed enroll request
// coerces missing fields to `""`/undefined and lets the SERVICE layer's own
// ordered checks (unknown keys -> field validation -> 404 unknown user ->
// 409 not-enabled -> 422 endpoint-host-unset) produce the right status.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import { notFound, unprocessableEntity } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import { parseLimitParam } from "../common/limit-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";
import {
  RemoteWireguardService,
  type RemoteWireguardStatusDto,
  type RemoteWireguardDevicePageDto,
  type RemoteWireguardEnrollmentDto,
} from "./wireguard/remote-wireguard.service.js";

const ENROLL_BODY_KEYS = new Set(["userId", "name"]);
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface CursorLimitQuery {
  cursor?: string;
  limit?: number;
}

/** Same local pattern apps/server/src/notices/notices.controller.ts's own
 *  parseCursorLimitQuery uses — kept local rather than reused from
 *  apps/server/src/catalog/viewer.ts's parseListQuery, since importing
 *  from catalog/ into a different top-level module (remote/) for a single
 *  three-line helper is not worth the cross-module coupling; both wrap the
 *  SAME shared apps/server/src/common/limit-param.ts primitive. */
function parseCursorLimitQuery(query: Record<string, unknown>): CursorLimitQuery {
  const result: CursorLimitQuery = {};
  if (typeof query["cursor"] === "string") result.cursor = query["cursor"];
  const limit = parseLimitParam(query["limit"]);
  if (limit !== undefined) result.limit = limit;
  return result;
}

@Controller()
export class RemoteWireguardController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly wireguardService: RemoteWireguardService,
  ) {}

  @Post("admin/remote/wireguard/enable")
  @HttpCode(HttpStatus.OK)
  async enableRemoteWireguard(@Req() req: AuthenticatedRequest): Promise<RemoteWireguardStatusDto> {
    await requireAdmin(this.dbProvider.db, req);
    return this.wireguardService.enable(req.user!.userId);
  }

  @Post("admin/remote/wireguard/disable")
  @HttpCode(HttpStatus.OK)
  async disableRemoteWireguard(@Req() req: AuthenticatedRequest): Promise<RemoteWireguardStatusDto> {
    await requireAdmin(this.dbProvider.db, req);
    return this.wireguardService.disable(req.user!.userId);
  }

  @Get("admin/remote/wireguard/status")
  async getRemoteWireguardStatus(@Req() req: AuthenticatedRequest): Promise<RemoteWireguardStatusDto> {
    await requireAdmin(this.dbProvider.db, req);
    return this.wireguardService.status();
  }

  @Get("admin/remote/wireguard/devices")
  async listRemoteWireguardDevices(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<RemoteWireguardDevicePageDto> {
    await requireAdmin(this.dbProvider.db, req);
    return this.wireguardService.listDevices(parseCursorLimitQuery(query));
  }

  @Post("admin/remote/wireguard/devices")
  @HttpCode(HttpStatus.CREATED)
  async enrollRemoteWireguardDevice(
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<RemoteWireguardEnrollmentDto> {
    await requireAdmin(this.dbProvider.db, req);
    const instance = req.originalUrl;
    const body = rawBody ?? {};

    for (const key of Object.keys(body)) {
      if (!ENROLL_BODY_KEYS.has(key)) {
        throw unprocessableEntity(`Unknown property "${key}".`, instance);
      }
    }
    const userId = body["userId"];
    if (typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
      throw unprocessableEntity('"userId" (uuid string) is required.', instance);
    }
    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw unprocessableEntity('"name" is required.', instance);
    }

    return this.wireguardService.enrollDevice({ userId, name, actorUserId: req.user!.userId });
  }

  @Delete("admin/remote/wireguard/devices/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeRemoteWireguardDevice(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await requireAdmin(this.dbProvider.db, req);
    requireUuidParam(id, "Device not found.", req.originalUrl);
    const result = await this.wireguardService.revokeDevice({ deviceId: id, actorUserId: req.user!.userId });
    if (!result) {
      throw notFound("Device not found.", req.originalUrl);
    }
  }
}
