// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-stash.controller.ts
//
// STATE.md Stash run: HTTP wiring for GET/PUT /admin/libraries/{id}/
// stash-connection, GET/PUT .../stash-path-mappings,
// POST .../stash-path-mappings/preview, POST .../stash-sync. Mirrors
// admin-library-provider-chain.controller.ts's shape exactly — thin,
// `req.user!.userId` handed to the service as actorUserId, requireLiveAdmin
// lives inside the service.

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { AdminStashService } from "./admin-stash.service.js";

@Controller("admin/libraries")
export class AdminStashController {
  constructor(private readonly service: AdminStashService) {}

  @Get(":id/stash-connection")
  async getConnection(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.service.getConnection(id, req.user!.userId);
  }

  @Put(":id/stash-connection")
  async putConnection(
    @Param("id") id: string,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.putConnection(id, rawBody, req.user!.userId);
  }

  @Get(":id/stash-path-mappings")
  async getPathMappings(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.service.getPathMappings(id, req.user!.userId);
  }

  @Put(":id/stash-path-mappings")
  async putPathMappings(
    @Param("id") id: string,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.putPathMappings(id, rawBody, req.user!.userId);
  }

  @Post(":id/stash-path-mappings/preview")
  @HttpCode(HttpStatus.OK)
  async previewPathMappings(
    @Param("id") id: string,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.previewPathMappings(id, rawBody, req.user!.userId);
  }

  @Post(":id/stash-sync")
  @HttpCode(HttpStatus.ACCEPTED)
  async postSync(
    @Param("id") id: string,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.postSync(id, rawBody, req.user!.userId);
  }
}
