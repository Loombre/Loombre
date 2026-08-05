// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-direct.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5, RG12, RG15, Wave 0 —
// lane/remote-base). Three ops (tag `remote`, packages/contract/openapi.yaml):
//   - POST /admin/remote/direct/acme-test   testRemoteDirectAcme
//   - POST /admin/remote/direct/enable      enableRemoteDirect
//   - POST /admin/remote/direct/disable     disableRemoteDirect
//
// CONFORMING 501 SHELLS: every handler runs requireLiveAdmin FIRST, then
// throws notImplemented() — see remote-state.controller.ts's header for
// the full rationale. The Direct lane (R5, guided ACME/reverse-proxy +
// router instruction cards) replaces these bodies with real behavior;
// route paths/methods/admin-gate ordering are frozen here and do not
// change.

import { Controller, Post, Req } from "@nestjs/common";
import { notImplemented } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";

@Controller()
export class RemoteDirectController {
  constructor(private readonly dbProvider: DbProvider) {}

  @Post("admin/remote/direct/acme-test")
  async testRemoteDirectAcme(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("The Direct path's staged ACME test is not implemented yet.", req.originalUrl);
  }

  @Post("admin/remote/direct/enable")
  async enableRemoteDirect(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Enabling the Direct path is not implemented yet.", req.originalUrl);
  }

  @Post("admin/remote/direct/disable")
  async disableRemoteDirect(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Disabling the Direct path is not implemented yet.", req.originalUrl);
  }
}
