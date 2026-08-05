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
// Lane WG1: enable/disable/status now delegate to RemoteWireguardService
// (./wireguard/remote-wireguard.service.js) — requireAdmin still runs
// FIRST, unchanged from the Wave-0 freeze ("route paths/methods/admin-gate
// ordering are frozen ... do not change"; see remote-wireguard.service.ts's
// own header for why the service does NOT re-check admin a second time).
// The three devices ops STAY 501 shells (WG2's own enrollment work) —
// see remote-state.controller.ts's header for the general 501-shell
// rationale, still true for exactly these three handlers below.

import { Controller, Delete, Get, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { notImplemented } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";
import { RemoteWireguardService, type RemoteWireguardStatusDto } from "./wireguard/remote-wireguard.service.js";

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
  async listRemoteWireguardDevices(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Listing Remote devices is not implemented yet.", req.originalUrl);
  }

  @Post("admin/remote/wireguard/devices")
  async enrollRemoteWireguardDevice(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Enrolling a Remote device is not implemented yet.", req.originalUrl);
  }

  @Delete("admin/remote/wireguard/devices/:id")
  async revokeRemoteWireguardDevice(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Revoking a Remote device is not implemented yet.", req.originalUrl);
  }
}
