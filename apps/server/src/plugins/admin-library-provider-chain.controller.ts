// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-library-provider-chain.controller.ts
//
// Lane W5b: HTTP wiring for GET/PUT /admin/libraries/{id}/provider-chain
// (packages/contract/openapi.yaml). Mirrors admin-plugins.controller.ts's
// shape — thin, `req.user!.userId` handed to the service as actorUserId,
// requireLiveAdmin lives inside the service (see
// admin-library-provider-chain.service.ts's own header for why this file
// lives under apps/server/src/plugins/ rather than apps/server/src/catalog/
// alongside LibrariesController's other /libraries/{id}/* routes).
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

import { Body, Controller, Get, Param, Put, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import { AdminLibraryProviderChainService } from "./admin-library-provider-chain.service.js";
import type { AdminLibraryProviderChainDto } from "./admin-library-provider-chain-dto.js";

@Controller("admin/libraries")
export class AdminLibraryProviderChainController {
  constructor(private readonly service: AdminLibraryProviderChainService) {}

  @Get(":id/provider-chain")
  async getChain(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<AdminLibraryProviderChainDto> {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    return this.service.getChain(id, req.user!.userId);
  }

  @Put(":id/provider-chain")
  async putChain(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminLibraryProviderChainDto> {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    const body = rawBody ?? {};
    return this.service.putChain(id, body["entries"], req.user!.userId);
  }
}
