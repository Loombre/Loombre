// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/remote/probe-page.controller.ts
//
// STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
// reachability proof + posture card" (R6/R9, Lane P1). GET /probe/{token}
// (getProbePage) — the ONE public operation this module introduces
// (contract `security: []`). Full M12 quartet already landed at Wave 0
// (contract, auth.guard.ts PUBLIC_ROUTE_PATTERNS, conformance.spec.ts
// PUBLIC_OPERATION_IDS, the `probe` rate-limit policy) — this lane
// replaces the shell's unconditional 404 with real behavior while
// PRESERVING its posture exactly:
//
//   1. Hash the path token (RG6's house pattern M3 — SHA-256 hex, the
//      SAME hash function createRemoteProbe used to mint it).
//   2. DB equality lookup + atomic single-use consume
//      (consumeProbeTokenAndEmit — a compare-and-swap UPDATE, constant-
//      time by construction: never a string compare of a secret).
//   3. valid + unexpired + unused -> mark arrival + emit `probe.arrived`
//      (admin-only, no token in the payload — R9) IN THE SAME transaction
//      -> return the static success page: fixed minimal HTML, ZERO server
//      info (no `res.send()`, which would let Express set an ETag off the
//      body — `res.end()` after manually setting ONLY Content-Type, so
//      the response carries nothing beyond main.ts's own global security
//      headers + the unavoidable Date/Connection/Content-Length HTTP
//      framing).
//   4. anything else (unknown/expired/already-consumed token) -> the
//      SAME bare `NotFoundException()` the shell always threw — byte-
//      identical to the catch-all (conformance.spec.ts's dedicated test
//      already pins this; unchanged by this lane).

import { Controller, Get, NotFoundException, Param, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { createHash } from "node:crypto";
import { consumeProbeTokenAndEmit } from "@loombre/db";
import { nowMs as clockNowMs } from "@loombre/shared";
import { RateLimit, SurfaceRateLimitGuard } from "../common/rate-limit.guard.js";
import { RateLimitExceptionFilter } from "../common/rate-limit-exception.filter.js";
import { DbProvider } from "../common/db.provider.js";

// R6's "zero server info" — no title, no meta beyond charset, no linked
// assets, no server/app name anywhere in the markup. Exported for the
// e2e suite's exact-body assertion (apps/server/test/remote-probes.e2e.spec.ts).
export const PROBE_SUCCESS_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reachable</title></head><body>Reachable.</body></html>';

@Controller()
@UseFilters(RateLimitExceptionFilter)
export class ProbePageController {
  constructor(private readonly dbProvider: DbProvider) {}

  @Get("probe/:token")
  @UseGuards(SurfaceRateLimitGuard)
  @RateLimit("probe", "ip")
  async getProbePage(@Param("token") token: string, @Res() res: Response): Promise<void> {
    const db = this.dbProvider.db;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const nowMs = clockNowMs();

    const result = await consumeProbeTokenAndEmit(db, { tokenHash, nowMs });
    if (!result.ok) {
      // Byte-identical to the catch-all — see this file's header. Thrown,
      // not returned, even though @Res() is bound: NestJS's exception
      // filters still run ahead of any manual response the handler body
      // would otherwise send (the SAME pattern images.controller.ts/
      // session-file.controller.ts/subtitle-file.controller.ts already
      // rely on for their own @Res()-plus-thrown-404 handlers).
      throw new NotFoundException();
    }

    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // res.end(), NOT res.send(): res.send() would let Express compute and
    // set an ETag off the body (R6's "audit what Express/Nest adds and
    // strip what you can") — res.end() bypasses that entirely, so this
    // response carries nothing beyond main.ts's global security headers
    // plus the unavoidable Date/Connection/Content-Length HTTP framing.
    res.end(PROBE_SUCCESS_HTML);
  }
}
