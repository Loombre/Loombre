// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-stash-sync-report.controller.ts
//
// HTTP wiring for GET /admin/libraries/{id}/stash-sync-report
// (packages/contract/openapi.yaml, STATE.md S8/K14). Mirrors
// admin-library-provider-chain.controller.ts's shape — thin,
// `req.user!.userId` handed to the service as actorUserId, requireLiveAdmin
// lives inside the service.

import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { AdminStashSyncReportService, type AdminStashSyncReportDto } from "./admin-stash-sync-report.service.js";

@Controller("admin/libraries")
export class AdminStashSyncReportController {
  constructor(private readonly service: AdminStashSyncReportService) {}

  @Get(":id/stash-sync-report")
  async getReport(
    @Param("id") id: string,
    @Query("unmatchedCursor") unmatchedCursor: string | undefined,
    @Query("staleCursor") staleCursor: string | undefined,
    @Query("unmatchedLoombreFilesCursor") unmatchedLoombreFilesCursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminStashSyncReportDto> {
    const parsedLimit = limit !== undefined ? Number.parseInt(limit, 10) : undefined;
    return this.service.getReport(id, req.user!.userId, {
      ...(unmatchedCursor !== undefined ? { unmatchedCursor } : {}),
      ...(staleCursor !== undefined ? { staleCursor } : {}),
      ...(unmatchedLoombreFilesCursor !== undefined ? { unmatchedLoombreFilesCursor } : {}),
      ...(parsedLimit !== undefined && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
    });
  }
}
