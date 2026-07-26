// SPDX-License-Identifier: AGPL-3.0-only
import { All, Controller, NotFoundException } from "@nestjs/common";

/**
 * Explicit catch-all (STATE.md D21: "catch-all; no per-path controllers
 * yet"). AuthGuard is a NestJS CanActivate, which only runs in the context
 * of a matched route — without SOME route bound for arbitrary /v1 paths,
 * requests to not-yet-implemented endpoints would never reach the guard at
 * all (Express would 404 them before Nest's pipeline runs). This controller
 * exists purely to give the guard something to attach to; it carries no
 * business logic of its own and stands in for "whatever Nest mounts
 * internally for 404 handling" — real per-path controllers replace it
 * incrementally in Phase 1+, at which point this catch-all narrows or is
 * removed.
 *
 * Registered in GatewayModule AFTER HealthController so the literal
 * `/healthz` route is matched first; Express tries routes in registration
 * order and `/*splat` never shadows an exact match registered earlier.
 */
@Controller()
export class NotFoundController {
  @All("*splat")
  catchAll(): never {
    throw new NotFoundException();
  }
}
