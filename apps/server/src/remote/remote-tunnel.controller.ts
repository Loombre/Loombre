// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-tunnel.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R4/R9/RG7, lane T1). Six ops (tag
// `remote`, packages/contract/openapi.yaml):
//   - POST   /admin/remote/tunnel/token      setRemoteTunnelToken
//   - DELETE /admin/remote/tunnel/token      clearRemoteTunnelToken
//   - POST   /admin/remote/tunnel/enable     enableRemoteTunnel
//   - POST   /admin/remote/tunnel/disable    disableRemoteTunnel
//   - GET    /admin/remote/tunnel/status     getRemoteTunnelStatus
//   - GET    /admin/remote/tunnel/logs       getRemoteTunnelLogs
//
// Real behavior (replaces the Wave-0 conforming 501 shells, RG15): every
// handler still runs requireAdmin FIRST (fast-fail on the JWT claim, then
// requireLiveAdmin's fresh DB read, A10) exactly as the shell did, then
// delegates to tunnel-token.service.ts / tunnel/remote-tunnel.service.ts —
// which, for the three mutating ops (set/clear token, enable/disable),
// re-verify admin themselves too (defense in depth, the SAME double-gate
// apps/server/src/mail/admin-mail.controller.ts's setCredentials/
// clearCredentials already establishes by delegating straight to a
// service that does its own requireLiveAdmin).
//
// Body coercion: hand-rolled, no class-validator DTOs anywhere in this
// codebase (admin-mail.controller.ts's own setCredentials is the house
// precedent) — a bodyless/malformed request coerces missing fields to `""`
// and lets the SERVICE layer's own ordered checks (admin -> business rule
// -> emptiness) produce the right status, rather than a validation
// pipeline rejecting the shape before those checks ever run.

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query, Req } from "@nestjs/common";
import { nowMs as clockNowMs } from "@loombre/shared";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";
import { RemoteTunnelService, type RemoteTunnelStatusDto } from "./tunnel/remote-tunnel.service.js";
import { TunnelTokenService, type SetTunnelTokenResult } from "./tunnel/tunnel-token.service.js";

const DEFAULT_LOGS_LIMIT = 200;
const MAX_LOGS_LIMIT = 500;

/** Same lenient-parse-then-clamp posture as apps/server/src/common/
 *  limit-param.ts's parseLimitParam (R-F9's repo-wide precedent) — kept
 *  local rather than reused because that helper is explicitly scoped to
 *  the shared cursor-list `Limit` parameter (max 200), a different
 *  contract parameter than `lines` (max 500, default 200) here. */
function parseLogsLimit(value: unknown): number {
  if (typeof value !== "string") return DEFAULT_LOGS_LIMIT;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOGS_LIMIT;
  return Math.min(n, MAX_LOGS_LIMIT);
}

@Controller()
export class RemoteTunnelController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly tunnelTokenService: TunnelTokenService,
    private readonly remoteTunnelService: RemoteTunnelService,
  ) {}

  @Post("admin/remote/tunnel/token")
  @HttpCode(HttpStatus.OK)
  async setRemoteTunnelToken(
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<SetTunnelTokenResult> {
    await requireAdmin(this.dbProvider.db, req);
    const body = rawBody ?? {};
    const token = typeof body["token"] === "string" ? body["token"] : "";
    return this.tunnelTokenService.setToken({
      token,
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }

  @Delete("admin/remote/tunnel/token")
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearRemoteTunnelToken(@Req() req: AuthenticatedRequest): Promise<void> {
    await requireAdmin(this.dbProvider.db, req);
    await this.tunnelTokenService.clearToken({
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }

  @Post("admin/remote/tunnel/enable")
  @HttpCode(HttpStatus.OK)
  async enableRemoteTunnel(
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<RemoteTunnelStatusDto> {
    await requireAdmin(this.dbProvider.db, req);
    const body = rawBody ?? {};
    const hostname = typeof body["hostname"] === "string" ? body["hostname"] : "";
    return this.remoteTunnelService.enableRemoteTunnel({
      hostname,
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }

  @Post("admin/remote/tunnel/disable")
  @HttpCode(HttpStatus.OK)
  async disableRemoteTunnel(@Req() req: AuthenticatedRequest): Promise<RemoteTunnelStatusDto> {
    await requireAdmin(this.dbProvider.db, req);
    return this.remoteTunnelService.disableRemoteTunnel({
      actorUserId: req.user!.userId,
      nowMs: clockNowMs(),
      instancePath: req.originalUrl,
    });
  }

  @Get("admin/remote/tunnel/status")
  async getRemoteTunnelStatus(@Req() req: AuthenticatedRequest): Promise<RemoteTunnelStatusDto> {
    await requireAdmin(this.dbProvider.db, req);
    return this.remoteTunnelService.getRemoteTunnelStatus();
  }

  @Get("admin/remote/tunnel/logs")
  async getRemoteTunnelLogs(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<{ lines: string[] }> {
    await requireAdmin(this.dbProvider.db, req);
    const limit = parseLogsLimit(query["lines"]);
    return this.remoteTunnelService.getRemoteTunnelLogs(limit);
  }
}
