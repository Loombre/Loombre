// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/devices.controller.ts
//
// GET /devices, GET/DELETE /devices/{id} — scoped to the CALLER's own
// devices only (getDeviceForUser/deleteDeviceForUser both take userId as a
// hard filter, not merely a suggestion — see packages/db/src/query/admin.ts).

import { Controller, Delete, Get, Param, Query, Req } from "@nestjs/common";
import { deleteDeviceForUser, getDeviceForUser, listDevicesForUser, type AdminDeviceRow } from "@loombre/db";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { parseListQuery } from "./viewer.js";

function mapDevice(row: AdminDeviceRow) {
  const profile = (row.profile ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    profileId: typeof profile["profileId"] === "string" ? profile["profileId"] : "",
    capabilityProfile: row.profile ?? null,
    lastSeenAtMs: row.last_seen_ms ?? 0,
    createdAtMs: row.created_at_ms,
  };
}

@Controller()
export class DevicesController {
  constructor(private readonly dbProvider: DbProvider) {}

  @Get("devices")
  async listDevices(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const { cursor, limit } = parseListQuery(query);
    const page = await listDevicesForUser(this.dbProvider.db, req.user!.userId, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { items: page.rows.map(mapDevice), nextCursor: page.nextCursor };
  }

  @Get("devices/:id")
  async getDevice(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Device not found.", req.originalUrl);
    const device = await getDeviceForUser(this.dbProvider.db, req.user!.userId, id);
    if (!device) {
      throw notFound("Device not found.", req.originalUrl);
    }
    return mapDevice(device);
  }

  @Delete("devices/:id")
  async revokeDevice(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Device not found.", req.originalUrl);
    const device = await getDeviceForUser(this.dbProvider.db, req.user!.userId, id);
    if (!device) {
      throw notFound("Device not found.", req.originalUrl);
    }
    await deleteDeviceForUser(this.dbProvider.db, req.user!.userId, id);
  }
}
