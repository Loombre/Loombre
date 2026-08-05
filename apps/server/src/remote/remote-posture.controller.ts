// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/remote-posture.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R7, S1 lane). DRIFT DECISION #1
// (STATE.md, logged at Wave-0 freeze, S1's to land): the frozen contract
// omitted a posture READ endpoint — R7's card and U3 need one.
//   - GET /admin/remote/posture   getRemotePosture
//
// REAL implementation from day one (not a 501 shell — this op did not
// exist at Wave 0, so there is no interim to replace): requireAdmin
// (live-isAdmin, A10) first, then ./posture/remote-posture.service.ts does
// the actual evaluation. Response shape per the drift decision's own
// literal field list: `checks` (key/grade/detail/fixAction), `overallGrade`,
// `evaluatedAtMs` — deriveCardState's own `active` boolean is NOT
// separately exposed (see this lane's report): `checks: []` is already
// unambiguous, since every non-'none' active path always yields at least
// 5 checks (4 universal + 1 path-specific, posture-model.ts's own
// applicableChecks) — an empty array can only mean 'none'.

import { Controller, Get, Req } from "@nestjs/common";
import { nowMs } from "@loombre/shared";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { DbProvider } from "../common/db.provider.js";
import { requireAdmin } from "./require-admin.js";
import { RemotePostureService } from "./posture/remote-posture.service.js";

@Controller()
export class RemotePostureController {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly postureService: RemotePostureService,
  ) {}

  @Get("admin/remote/posture")
  async getRemotePosture(@Req() req: AuthenticatedRequest) {
    await requireAdmin(this.dbProvider.db, req);

    const path = await this.postureService.resolveActivePath();
    const { card, details } = await this.postureService.evaluate(path);

    return {
      checks: card.checks.map((check) => ({
        key: check.checkKey,
        grade: check.grade,
        detail: details.get(check.checkKey) ?? "",
        fixAction: check.fixAction,
      })),
      overallGrade: card.overallGrade,
      evaluatedAtMs: nowMs(),
    };
  }
}
