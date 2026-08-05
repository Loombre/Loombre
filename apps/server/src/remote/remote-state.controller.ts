// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-state.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (RG15, Wave 0 — lane/remote-base).
// GET /admin/remote/state (getRemoteState) — the wizard re-entry read.
//
// CONFORMING 501 SHELL: requireLiveAdmin runs first (a real admin gets an
// honest "not built yet", never a coincidental catch-all), then this
// throws notImplemented(). Whichever lane implements the real derivation
// (RG15: activePath computed from the three subsystems' own enabled state,
// never stored) replaces this handler's body — the route, method, and
// admin-gate ordering stay exactly as they are here.

import { Controller, Get, Req } from "@nestjs/common";
import { notImplemented } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";

@Controller()
export class RemoteStateController {
  constructor(private readonly dbProvider: DbProvider) {}

  @Get("admin/remote/state")
  async getRemoteState(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Remote-access state is not implemented yet.", req.originalUrl);
  }
}
