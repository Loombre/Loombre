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

import { Body, Controller, Get, Param, Put, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { AdminLibraryProviderChainService } from "./admin-library-provider-chain.service.js";
import type { AdminLibraryProviderChainDto } from "./admin-library-provider-chain-dto.js";

@Controller("admin/libraries")
export class AdminLibraryProviderChainController {
  constructor(private readonly service: AdminLibraryProviderChainService) {}

  @Get(":id/provider-chain")
  async getChain(@Param("id") id: string, @Req() req: AuthenticatedRequest): Promise<AdminLibraryProviderChainDto> {
    return this.service.getChain(id, req.user!.userId);
  }

  @Put(":id/provider-chain")
  async putChain(
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown> | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminLibraryProviderChainDto> {
    const body = rawBody ?? {};
    return this.service.putChain(id, body["entries"], req.user!.userId);
  }
}
