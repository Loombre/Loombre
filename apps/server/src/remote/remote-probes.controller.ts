// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-probes.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R6/RG6, Wave 0 — lane/remote-base).
// Two ADMIN ops (tag `remote`, packages/contract/openapi.yaml) — the mint
// and poll sides of the reachability proof; the PUBLIC arrival side (GET
// /probe/{token}) lives in probe-page.controller.ts, deliberately
// separate (a different auth posture deserves a different file, same
// reasoning invites.controller.ts's admin-vs-public split inside one
// module documents, applied here as a file split instead of a
// within-class split since this whole module is brand new):
//   - POST /admin/remote/probes         createRemoteProbe
//   - GET  /admin/remote/probes/{id}    getRemoteProbe
//
// CONFORMING 501 SHELLS: every handler runs requireLiveAdmin FIRST, then
// throws notImplemented() — see remote-state.controller.ts's header for
// the full rationale.

import { Controller, Get, Post, Req } from "@nestjs/common";
import { notImplemented } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";

@Controller()
export class RemoteProbesController {
  constructor(private readonly dbProvider: DbProvider) {}

  @Post("admin/remote/probes")
  async createRemoteProbe(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Minting a reachability probe is not implemented yet.", req.originalUrl);
  }

  @Get("admin/remote/probes/:id")
  async getRemoteProbe(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Reachability probe status is not implemented yet.", req.originalUrl);
  }
}
