// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-tunnel.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R4, RG15, Wave 0 — lane/remote-base).
// Six ops (tag `remote`, packages/contract/openapi.yaml):
//   - POST   /admin/remote/tunnel/token      setRemoteTunnelToken
//   - DELETE /admin/remote/tunnel/token      clearRemoteTunnelToken
//   - POST   /admin/remote/tunnel/enable     enableRemoteTunnel
//   - POST   /admin/remote/tunnel/disable    disableRemoteTunnel
//   - GET    /admin/remote/tunnel/status     getRemoteTunnelStatus
//   - GET    /admin/remote/tunnel/logs       getRemoteTunnelLogs
//
// CONFORMING 501 SHELLS: every handler runs requireLiveAdmin FIRST, then
// throws notImplemented() — see remote-state.controller.ts's header for
// the full rationale. The Tunnel lane (R4, BYO Cloudflare token + managed
// cloudflared connector) replaces these bodies with real behavior; route
// paths/methods/admin-gate ordering are frozen here and do not change.

import { Controller, Delete, Get, Post, Req } from "@nestjs/common";
import { notImplemented } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";

@Controller()
export class RemoteTunnelController {
  constructor(private readonly dbProvider: DbProvider) {}

  @Post("admin/remote/tunnel/token")
  async setRemoteTunnelToken(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Setting the Tunnel token is not implemented yet.", req.originalUrl);
  }

  @Delete("admin/remote/tunnel/token")
  async clearRemoteTunnelToken(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Clearing the Tunnel token is not implemented yet.", req.originalUrl);
  }

  @Post("admin/remote/tunnel/enable")
  async enableRemoteTunnel(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Enabling the Tunnel path is not implemented yet.", req.originalUrl);
  }

  @Post("admin/remote/tunnel/disable")
  async disableRemoteTunnel(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Disabling the Tunnel path is not implemented yet.", req.originalUrl);
  }

  @Get("admin/remote/tunnel/status")
  async getRemoteTunnelStatus(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Tunnel status is not implemented yet.", req.originalUrl);
  }

  @Get("admin/remote/tunnel/logs")
  async getRemoteTunnelLogs(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Tunnel connector logs are not implemented yet.", req.originalUrl);
  }
}
