// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-diagnosis.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R5/R6/RG11, Wave 0 —
// lane/remote-base). One op (tag `remote`, packages/contract/openapi.yaml):
//   - POST /admin/remote/diagnosis   diagnoseRemote
//
// CONFORMING 501 SHELL: requireLiveAdmin runs first, then this throws
// notImplemented() — see remote-state.controller.ts's header for the full
// rationale. The pure classification function this endpoint will call
// already exists and is frozen (packages/shared/src/remote/diagnosis.ts's
// classifyReachability, RG11) — whichever lane wires the real endpoint
// only needs to gather ReachabilityInput and call it; that lane replaces
// this handler's body.

import { Controller, Post, Req } from "@nestjs/common";
import { notImplemented } from "../gateway/problem.exception.js";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";

@Controller()
export class RemoteDiagnosisController {
  constructor(private readonly dbProvider: DbProvider) {}

  @Post("admin/remote/diagnosis")
  async diagnoseRemote(@Req() req: AuthenticatedRequest): Promise<never> {
    await requireAdmin(this.dbProvider.db, req);
    throw notImplemented("Remote-access diagnosis is not implemented yet.", req.originalUrl);
  }
}
