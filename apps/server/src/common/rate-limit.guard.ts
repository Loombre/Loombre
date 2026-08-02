// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/common/rate-limit.guard.ts
//
// STATE.md P4.15's "reusable limiter guard applied to every UNAUTHENTICATED
// surface" (and, per this wave's report, extended to the authenticated-but-
// heavy export surface too — the sweep's spirit is "every surface that
// needs one", not literally only unauthenticated ones). One declarative
// decorator + one Guard, instead of copy-pasting the manual
// `this.rateLimiter.xxx.attempt(key); if (!allowed) throw ...` pattern
// AuthController/RestrictedController use into every one of catalog's/
// playback's controllers — those two keep their existing hand-rolled
// calls unchanged (P2.1/P2.12 precedent, untouched by this wave); this
// guard is strictly for the NEW P4.15 surfaces, where "apply the same
// three lines to six different controllers across two module boundaries"
// is exactly the kind of repetition a guard exists to remove.
//
// Runs AFTER the global AuthGuard (apps/server/src/gateway/auth.guard.ts,
// registered via APP_GUARD in gateway.module.ts) for every route that
// declares "identity"/"user" as its key strategy — Nest evaluates guards
// Global -> Controller -> Method for a single request, so req.user is
// already populated by the time this guard's canActivate runs, on any
// route this decorates (every one of them requires authentication either
// way — "ip" strategy is used ONLY on the one genuinely public route this
// sweep covers, GET /system/capabilities).

import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthenticatedRequest } from "../gateway/auth.guard.js";
import { SurfaceRateLimiterService } from "./surface-rate-limiter.service.js";
import { tooManyRequests } from "./rate-limit.exception.js";

export type RateLimitPolicyName = "capabilities" | "mediaToken" | "export" | "setup" | "claim";
export type RateLimitKeyStrategy = "ip" | "identity" | "user";

export interface RateLimitMeta {
  policy: RateLimitPolicyName;
  keyStrategy: RateLimitKeyStrategy;
}

export const RATE_LIMIT_METADATA_KEY = "loombre:rateLimit";

/** Apply to a controller method (or class, for every method) to enforce
 *  one of SurfaceRateLimiterService's named policies. `keyStrategy`:
 *    - "ip"       — the resolved client address (same LOOMBRE_TRUST_PROXY-
 *                    gated req.ip AuthController's own limiter uses).
 *    - "identity" — `${userId}:${deviceId}` — the SAME limit regardless of
 *                    whether the caller authenticated via the Authorization
 *                    header or the ?token= fallback (P2.18).
 *    - "user"     — `userId` alone (deviceId doesn't matter for a
 *                    whole-account-scoped surface like export). */
export function RateLimit(policy: RateLimitPolicyName, keyStrategy: RateLimitKeyStrategy): MethodDecorator {
  return SetMetadata(RATE_LIMIT_METADATA_KEY, { policy, keyStrategy } satisfies RateLimitMeta);
}

/** Mirrors apps/server/src/session/auth.controller.ts's own clientIp():
 *  falls back to a fixed key rather than `undefined` so a missing address
 *  still buckets deterministically instead of bypassing the limiter. */
function clientIp(req: Request): string {
  return req.ip && req.ip.length > 0 ? req.ip : "unknown";
}

function resolveKey(strategy: RateLimitKeyStrategy, req: AuthenticatedRequest): string {
  if (strategy === "ip") return clientIp(req);
  const user = req.user;
  // Defensive-only: every route this guard decorates with "identity"/"user"
  // requires authentication via the global AuthGuard, so req.user is
  // always populated in practice — this fallback just avoids an unkeyed
  // bucket rather than assuming the invariant holds.
  if (!user) return "unauthenticated";
  if (strategy === "user") return user.userId;
  return `${user.userId}:${user.deviceId ?? "no-device"}`;
}

@Injectable()
export class SurfaceRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: SurfaceRateLimiterService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<RateLimitMeta | undefined>(RATE_LIMIT_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No @RateLimit() decorator on this route -> not this guard's concern
    // (shouldn't happen in practice: this guard is only ever registered via
    // @UseGuards alongside a @RateLimit() decorator, never globally).
    if (!meta) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const key = resolveKey(meta.keyStrategy, req);
    const result = this.limiter[meta.policy].attempt(key);
    if (!result.allowed) {
      throw tooManyRequests("Too many requests. Try again later.", req.originalUrl, result.retryAfterMs);
    }
    return true;
  }
}
