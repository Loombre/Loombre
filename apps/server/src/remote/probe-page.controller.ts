// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/probe-page.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R6/R9, Wave 0 — lane/remote-base).
// GET /probe/{token} (getProbePage) — the ONE new PUBLIC operation this
// module introduces (contract `security: []`), so it gets its own file
// deliberately separate from the admin-scoped controllers alongside it —
// a different auth posture deserves a different file (same reasoning
// invites.controller.ts documents for its own admin-vs-public split,
// applied here as a file split since this whole module is brand new
// rather than an addition to an existing file).
//
// Full M12 quartet, all four pieces landing together in this Wave-0 commit
// (R9's "one of only three new unauth surfaces" — the other two are the
// WireGuard UDP listener itself and the tunnel connector's inbound edge,
// neither of which is an HTTP route this quartet governs):
//   1. contract `security: []` (packages/contract/openapi.yaml, already
//      frozen in this lane's first commit).
//   2. apps/server/src/gateway/auth.guard.ts's PUBLIC_ROUTE_PATTERNS
//      (modeled on the existing GET/POST /invites/claim/{token} entry).
//   3. apps/server/test/conformance.spec.ts's PUBLIC_OPERATION_IDS.
//   4. the `probe` named policy in SurfaceRateLimiterService (rateLimit.probe,
//      per-IP) with @RateLimit("probe","ip") below.
//
// SHELL == FINAL BEHAVIOR for every case this branch can produce: no probe
// tokens exist yet (the mint side, POST /admin/remote/probes, is itself a
// 501 shell), so an unconditional bare `NotFoundException()` is not a
// placeholder that lies — it is the honestly correct answer for every
// request this route can receive today, and it is BYTE-IDENTICAL to the
// catch-all's own 404 (NotFoundController) and to POST /setup/first-admin's
// post-configuration 404 and to GET/POST /invites/claim/{token}'s invalid-
// token 404 — the same "invisible == nonexistent" enumeration-resistant
// posture (docs/PLAN.md §6.4) applied to this surface. A later lane adds
// the real single-use hashed-token lookup + arrival-marking (RG6) and a
// genuine static success-page body for the one case that becomes possible
// once real tokens exist (`arrived` -> 200 text/html); every other case
// (invalid/expired/already-consumed/well-formed-but-unknown token) keeps
// resolving to this exact same 404, unchanged.

import { Controller, Get, NotFoundException, Param, UseFilters, UseGuards } from "@nestjs/common";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class ProbePageController {
  @Get("probe/:token")
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("probe", "ip")
  getProbePage(@Param("token") _token: string): never {
    throw new NotFoundException();
  }
}
