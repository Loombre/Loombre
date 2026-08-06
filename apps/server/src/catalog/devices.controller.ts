// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/catalog/devices.controller.ts
//
// GET /devices, GET/DELETE /devices/{id} — scoped to the CALLER's own
// devices only (getDeviceForUser/deleteDeviceForUser both take userId as a
// hard filter, not merely a suggestion — see packages/db/src/query/admin.ts).
//
// RG3 gap closure (STATE.md "Loombre Remote", lane WG2, PRE-EXISTING GAP
// found by the run's own recon): DELETE /devices/{id} used to be a bare
// row delete — it never called revokeRefreshTokensForDevice (only logout
// did), so an outstanding refresh token for a "deleted" device kept
// working until it separately expired. Fixed here for EVERY device kind,
// not just 'remote': revokeDevice below now revokes outstanding refresh
// tokens unconditionally, THEN (kind='remote' only) performs the full WG
// teardown — live peer removal + wg_peers/devices row deletion +
// remote.device.revoked — by delegating to RemoteWireguardService.
// revokeDevice, the SAME orchestration DELETE /admin/remote/wireguard/
// devices/{id} (the admin-scoped sibling endpoint) uses, so the crash-safe
// "live peer removal before DB rows" ordering (see that method's own doc
// comment) is never duplicated or risked drifting between the two routes.

import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Query, Req } from "@nestjs/common";
import { deleteDeviceForUser, getDeviceForUser, listDevicesForUser, revokeRefreshTokensForDevice, type AdminDeviceRow } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { notFound } from "../gateway/problem.exception.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { RemoteWireguardService } from "../remote/wireguard/remote-wireguard.service.js";
import { parseListQuery } from "./viewer.js";

function mapDevice(row: AdminDeviceRow) {
  const profile = (row.profile ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    kind: row.kind,
    profileId: typeof profile["profileId"] === "string" ? profile["profileId"] : "",
    capabilityProfile: row.profile ?? null,
    lastSeenAtMs: row.last_seen_ms ?? 0,
    createdAtMs: row.created_at_ms,
  };
}

@Controller()
export class DevicesController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly remoteWireguardService: RemoteWireguardService,
  ) {}

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
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeDevice(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Device not found.", req.originalUrl);
    const device = await getDeviceForUser(this.dbProvider.db, req.user!.userId, id);
    if (!device) {
      throw notFound("Device not found.", req.originalUrl);
    }

    if (device.kind === "remote") {
      // Full WG teardown (live peer removal ordered before DB rows —
      // RemoteWireguardService.revokeDevice's own doc comment) + refresh-
      // token revocation + remote.device.revoked, all in one call. A
      // self-service revoke of one's OWN enrolled remote device is
      // legitimate (this endpoint stays self-scoped exactly as before —
      // getDeviceForUser above already proved ownership).
      await this.remoteWireguardService.revokeDevice({ deviceId: id, actorUserId: req.user!.userId });
      return;
    }

    // Refresh-token revocation FIRST, device delete SECOND: refresh_tokens.
    // device_id is ON DELETE SET NULL (migrations/0002_phase1_catalog.sql
    // — "a removed device must not destroy the audit trail"), so deleting
    // the device row first would NULL OUT device_id on every one of its
    // still-live tokens before the revoke's own `WHERE device_id = $id`
    // filter ever ran, silently matching zero rows (found by this lane's
    // own e2e test — apps/server/test/remote-wireguard-devices.e2e.spec.ts
    // — asserting the previously-reversed order first, and RED).
    await revokeRefreshTokensForDevice(this.dbProvider.db, req.user!.userId, id, clockNowMs());
    await deleteDeviceForUser(this.dbProvider.db, req.user!.userId, id);
  }
}
