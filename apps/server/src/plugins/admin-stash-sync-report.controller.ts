// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-stash-sync-report.controller.ts
//
// HTTP wiring for GET /admin/libraries/{id}/stash-sync-report
// (packages/contract/openapi.yaml, STATE.md S8/K14). Mirrors
// admin-library-provider-chain.controller.ts's shape — thin,
// `req.user!.userId` handed to the service as actorUserId, requireLiveAdmin
// lives inside the service.
//
// api-validation-F1: every :id handler below now opens with
// requireUuidParam — the FIRST-statement policy
// apps/server/src/gateway/require-uuid-param.ts's header states and the
// other twenty controller files in this app already follow. Without it a
// syntactically-invalid uuid reached a uuid-column comparison, Postgres
// raised 22P02 inside the driver, and ProblemJsonExceptionFilter's
// catch-all could only render that client input mistake as a generic 500
// (packages/db/src/query/cursor.ts:66-67: "Client input is never a 500").
// The detail strings match this module's own notFound() calls for the
// nonexistent-id case, so malformed and merely-absent ids are
// indistinguishable (STATE.md's invisible == nonexistent posture).

import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import { parseLimitParam } from "../common/limit-param.js";
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
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const parsedLimit = parseLimitParam(limit);
    return this.service.getReport(id, req.user!.userId, {
      ...(unmatchedCursor !== undefined ? { unmatchedCursor } : {}),
      ...(staleCursor !== undefined ? { staleCursor } : {}),
      ...(unmatchedLoombreFilesCursor !== undefined ? { unmatchedLoombreFilesCursor } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
  }
}
