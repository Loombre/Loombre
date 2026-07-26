// SPDX-License-Identifier: AGPL-3.0-only
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { UnauthenticatedException } from "./unauthenticated.exception.js";
import { sanitizeInstancePath } from "./sanitize-instance.js";
import { ALLOW_QUERY_TOKEN_KEY } from "./allow-query-token.decorator.js";
import { TokenService } from "../session/token.service.js";

export interface RequestUser {
  userId: string;
  isAdmin: boolean;
  deviceId?: string;
}

/** Augment Express's Request with the claims AuthGuard attaches on success. */
export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
}

/**
 * Public surface (task spec): /healthz, POST /auth/login, POST /auth/refresh,
 * GET /system/capabilities. Keyed by `METHOD path` so e.g. a hypothetical
 * GET /auth/login would NOT be public — only the documented method is.
 *
 * STATE.md P4.6/P4.10 (lane C, Phase 4 Wave 2) added GET /setup/state and
 * POST /setup/first-admin — both `security: []` in openapi.yaml: the wizard
 * runs before any credentials exist, so both must be reachable
 * unauthenticated. POST /setup/first-admin stays public even AFTER it
 * becomes permanently inert (any user exists) — see
 * apps/server/src/setup/setup.controller.ts's header for why it 404s
 * byte-identically to an unknown route rather than ever answering 401.
 */
const PUBLIC_ROUTES = new Set([
  "GET /healthz",
  "POST /auth/login",
  "POST /auth/refresh",
  "GET /system/capabilities",
  "GET /setup/state",
  "POST /setup/first-admin",
]);

const BEARER_PATTERN = /^Bearer\s+(\S+)$/;

/**
 * Global gateway auth guard (STATE.md D21 -> P1.14 upgrade, registered as
 * APP_GUARD in GatewayModule): every request outside PUBLIC_ROUTES must
 * carry a syntactically valid, signature- and expiry-verified Bearer JWT
 * (TokenService, jose HS256). On success, `{ userId, isAdmin, deviceId? }`
 * is attached to `req.user` for downstream controllers/providers (e.g.
 * ViewerContextProvider) to consume. Any failure — missing header,
 * malformed header, bad signature, expired token — collapses to the same
 * RFC 9457 401 problem+json shape (UnauthenticatedException) so the
 * response never distinguishes *why* auth failed.
 *
 * P2.18 query-token fallback: routes decorated with @AllowQueryToken()
 * (apps/server/src/gateway/allow-query-token.decorator.ts) additionally
 * accept the SAME access JWT via `?token=` when no valid Authorization
 * header is present — browser <img>/<video>/<audio> elements cannot set
 * request headers. The header takes priority when both are present (a
 * client that CAN send a header has no reason to also leak the token into
 * the URL); query-token is only consulted as a fallback, and only on
 * decorated routes — every other route ignores `?token=` entirely, even a
 * syntactically valid one. Every UnauthenticatedException below uses
 * sanitizeInstancePath(), never req.originalUrl directly, so a token
 * presented via the query string is never echoed back in the 401 body.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (PUBLIC_ROUTES.has(`${req.method} ${req.path}`)) {
      return true;
    }

    const authHeader = req.headers["authorization"];
    const match = typeof authHeader === "string" ? BEARER_PATTERN.exec(authHeader) : null;

    if (match) {
      return this.verifyAndAttach(req, match[1]!);
    }

    const allowQueryToken =
      this.reflector.getAllAndOverride<boolean>(ALLOW_QUERY_TOKEN_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    if (allowQueryToken) {
      const queryToken = req.query?.["token"];
      if (typeof queryToken === "string" && queryToken.length > 0) {
        return this.verifyAndAttach(req, queryToken);
      }
    }

    throw new UnauthenticatedException(sanitizeInstancePath(req));
  }

  private async verifyAndAttach(req: AuthenticatedRequest, token: string): Promise<boolean> {
    try {
      const claims = await this.tokenService.verifyAccessToken(token);
      const user: RequestUser = { userId: claims.sub, isAdmin: claims.isAdmin };
      if (claims.deviceId !== undefined) {
        user.deviceId = claims.deviceId;
      }
      req.user = user;
      return true;
    } catch {
      throw new UnauthenticatedException(sanitizeInstancePath(req));
    }
  }
}
