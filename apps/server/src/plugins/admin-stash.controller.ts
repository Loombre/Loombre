// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/plugins/admin-stash.controller.ts
//
// STATE.md Stash run: HTTP wiring for GET/PUT/DELETE /admin/libraries/{id}/
// stash-connection, GET/PUT .../stash-path-mappings,
// POST .../stash-path-mappings/preview, POST .../stash-sync. Mirrors
// admin-library-provider-chain.controller.ts's shape exactly — thin,
// `req.user!.userId` handed to the service as actorUserId, requireLiveAdmin
// lives inside the service. DELETE (Stash OPEN ledger item 6 — "forget
// this connection entirely") added alongside GET/PUT, same thin-controller
// shape.
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

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { requireUuidParam } from "../gateway/require-uuid-param.js";
import { AdminStashService } from "./admin-stash.service.js";

@Controller("admin/libraries")
export class AdminStashController {
  constructor(private readonly service: AdminStashService) {}

  @Get(":id/stash-connection")
  async getConnection(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    return this.service.getConnection(id, req.user!.userId);
  }

  @Put(":id/stash-connection")
  async putConnection(
    @Param("id") id: string,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    return this.service.putConnection(id, rawBody, req.user!.userId);
  }

  @Delete(":id/stash-connection")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConnection(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    await this.service.deleteConnection(id, req.user!.userId);
  }

  @Get(":id/stash-path-mappings")
  async getPathMappings(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    return this.service.getPathMappings(id, req.user!.userId);
  }

  @Put(":id/stash-path-mappings")
  async putPathMappings(
    @Param("id") id: string,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    return this.service.putPathMappings(id, rawBody, req.user!.userId);
  }

  @Post(":id/stash-path-mappings/preview")
  @HttpCode(HttpStatus.OK)
  async previewPathMappings(
    @Param("id") id: string,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    return this.service.previewPathMappings(id, rawBody, req.user!.userId);
  }

  @Post(":id/stash-sync")
  @HttpCode(HttpStatus.ACCEPTED)
  async postSync(
    @Param("id") id: string,
    @Body() rawBody: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    requireUuidParam(id, "Library not found.", req.originalUrl);
    return this.service.postSync(id, rawBody, req.user!.userId);
  }
}
