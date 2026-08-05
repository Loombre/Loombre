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
// CONFORMING 501 SHELLS: every handler runs requireLiveAdmin FIRST, then
// throws notImplemented() — see remote-state.controller.ts's header for
// the full rationale. The WG lane (R1/R2, embedded userspace WireGuard)
// replaces these bodies with real behavior; route paths/methods/admin-gate
// ordering are frozen here and do not change.

import { Controller, Delete, Get, Post, Req } from "@nestjs/common";
import { notImplemented } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";

@Controller()
export class RemoteWireguardController {
  constructor(private readonly dbProvider: DbProvider) {}

  @Post("admin/remote/wireguard/enable")
  async enableRemoteWireguard(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Enabling Loombre Remote is not implemented yet.", req.originalUrl);
  }

  @Post("admin/remote/wireguard/disable")
  async disableRemoteWireguard(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Disabling Loombre Remote is not implemented yet.", req.originalUrl);
  }

  @Get("admin/remote/wireguard/status")
  async getRemoteWireguardStatus(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Loombre Remote status is not implemented yet.", req.originalUrl);
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
