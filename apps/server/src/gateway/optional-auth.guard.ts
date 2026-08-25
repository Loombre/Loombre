// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: apps/server/src/gateway/optional-auth.guard.ts
//
// "Optionally authenticated" enhancer for PUBLIC routes whose RESPONSE is
// auth-scoped — currently exactly one: GET /system/capabilities
// (api-restricted-leak-F1, owner ruling 2026-08-24; see
// common/capabilities.ts's resolveRestrictedCapabilityDetail for the
// ruling itself).
//
// The global AuthGuard short-circuits `true` for every PUBLIC_ROUTES entry
// WITHOUT attaching `req.user` — correct for a route that must never 401,
// but it leaves a handler that wants to answer differently for a signed-in
// caller with nothing to read. This guard fills exactly that gap: if a
// Bearer token is present AND verifies, it attaches the same
// `{ userId, isAdmin, deviceId? }` shape AuthGuard attaches; otherwise it
// leaves `req.user` unset. It NEVER throws and NEVER blocks — an absent,
// malformed, expired or wrongly-signed token simply means "anonymous", so
// the route keeps its "public means never gated" posture (a client with a
// stale token must not start getting 401s from feature negotiation).
//
// DELIBERATELY WEAKER THAN AuthGuard, and only usable where that is
// acceptable: it verifies the JWT's signature and expiry (jose HS256, pure
// CPU, no I/O) and stops there — it does NOT do AuthGuard's live
// getUserById/getDeviceById revocation reads (deleted user, password-change
// epoch R-F7, logout/device-revocation epoch AUD-A7b-001), nor the
// must-change-password check. That keeps the capabilities route's
// zero-I/O, Tier-0-friendly posture (CLAUDE.md invariant 9 — it is an
// unauthenticated, rate-limited surface that does no DB work by design)
// while raising its disclosure bar from "anyone at all" to "holds a
// currently-valid session token". Never put anything behind this guard
// that a just-revoked device must not see for the remaining ≤15 minutes of
// its access token's life — for that, use AuthGuard (i.e. don't make the
// route public).

import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { BEARER_PATTERN, type AuthenticatedRequest, type RequestUser } from "./auth.guard.js";
import { TokenService } from "../session/token.service.js";

@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // A non-public route reached its handler only because AuthGuard already
    // verified and attached the caller — never re-verify or overwrite that
    // (AuthGuard's checks are strictly stronger than this one's).
    if (req.user) return true;

    const authHeader = req.headers["authorization"];
    const match = typeof authHeader === "string" ? BEARER_PATTERN.exec(authHeader) : null;
    if (!match) return true;

    try {
      const claims = await this.tokenService.verifyAccessToken(match[1]!);
      const user: RequestUser = { userId: claims.sub, isAdmin: claims.isAdmin };
      if (claims.deviceId !== undefined) {
        user.deviceId = claims.deviceId;
      }
      req.user = user;
    } catch {
      // Anonymous. Deliberately swallowed: this guard's whole contract is
      // "never turn a public route into a 401".
    }

    return true;
  }
}
