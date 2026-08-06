// SPDX-License-Identifier: AGPL-3.0-only
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { getDeviceById, getUserById } from "@loombre/db";
import { UnauthenticatedException } from "./unauthenticated.exception.js";
import { MustChangePasswordException } from "./must-change-password.exception.js";
import { sanitizeInstancePath } from "./sanitize-instance.js";
import { ALLOW_QUERY_TOKEN_KEY } from "./allow-query-token.decorator.js";
import { TokenService } from "../session/token.service.js";
import { DbProvider } from "../common/db.provider.js";

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
 *
 * "Optional mail transport + invitation & reset flows" E2/M12 (Lane A)
 * added GET/POST /invites/claim/{token} — also `security: []`, and also
 * public PERMANENTLY for a given token even after it's expired/claimed/
 * revoked, same "invisible == nonexistent" posture as setup's own
 * byte-identical 404 — see PUBLIC_ROUTE_PATTERNS below for why these two
 * need a SEPARATE matching mechanism from the literal-string Set above.
 * F1 (opus adversarial review, fix wave): mounted under /invites, NOT bare
 * /claim/{token} — that path collided with the Next.js web PAGE route at
 * apps/web/src/app/claim/[token] under docs/ops/remote-access/reverse-proxy.md's
 * routing (see invites.controller.ts's header for the full story).
 * STATE.md "Optional mail transport + invitation & reset flows" (E3b/M12,
 * Lane B) added POST /auth/forgot-password and POST /auth/reset-password —
 * both `security: []`, the self-service email-tier recovery surface.
 */
const PUBLIC_ROUTES = new Set([
  "GET /healthz",
  "POST /auth/login",
  "POST /auth/refresh",
  "GET /system/capabilities",
  "GET /setup/state",
  "POST /setup/first-admin",
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
]);

/**
 * E3a/M14 (STATE.md "Optional mail transport + invitation & reset flows"):
 * the ONLY routes a `must_change_password`-flagged user may reach. Login/
 * refresh are already in PUBLIC_ROUTES above (never gated at all); logout
 * and the two profile routes are ordinary authenticated routes that must
 * stay reachable so the user can actually SEE the flag (GET /users/me),
 * clear it (PATCH /users/me), or bail out (POST /auth/logout). Every other
 * authenticated route 403s with MustChangePasswordException while flagged
 * — see verifyAndAttach below.
 */
const MUST_CHANGE_PASSWORD_ALLOWED_ROUTES = new Set([
  "POST /auth/logout",
  "GET /users/me",
  "PATCH /users/me",
]);

/**
 * "Optional mail transport + invitation & reset flows", E2/M12 (Lane A):
 * GET/POST /invites/claim/{token} are public, but — unlike every PUBLIC_ROUTES
 * entry above — carry a variable path segment (the raw invite token),
 * which a literal-string Set can never match. This is the FIRST dynamic
 * public route in the codebase; extending the guard with a small parallel
 * pattern list (rather than rewriting PUBLIC_ROUTES into a router) keeps
 * every existing literal entry's matching untouched and keeps the new
 * behavior narrowly scoped to the one new shape. `[^/]+` deliberately
 * matches ANY non-empty single path segment (never validated as a real
 * token shape here) — a syntactically-wrong token is indistinguishable
 * from an unknown one by the time it reaches the controller (byte-
 * identical 404, invites.controller.ts), so this guard has no reason to
 * pre-filter it.
 *
 * STATE.md "Loombre Remote — embedded WireGuard + three-path wizard +
 * reachability proof + posture card" (R6/R9, Wave 0 — lane/remote-base)
 * adds GET /probe/{token} — also `security: []`, same dynamic-path-segment
 * shape and same "public means never gated, not always successful"
 * posture (apps/server/src/remote/probe-page.controller.ts always 404s
 * this wave — the shell IS the final behavior for every case reachable
 * before real probe tokens exist, see that file's header). One of only
 * three new unauthenticated surfaces this subsystem introduces (R9) — the
 * other two (the WireGuard UDP listener and the tunnel connector's inbound
 * edge) are not HTTP routes this guard governs at all.
 */
const PUBLIC_ROUTE_PATTERNS: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/invites\/claim\/[^/]+$/ },
  { method: "POST", pattern: /^\/invites\/claim\/[^/]+$/ },
  { method: "GET", pattern: /^\/probe\/[^/]+$/ },
];

function isPublicRoute(method: string, path: string): boolean {
  if (PUBLIC_ROUTES.has(`${method} ${path}`)) return true;
  return PUBLIC_ROUTE_PATTERNS.some((entry) => entry.method === method && entry.pattern.test(path));
}

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
 *
 * E3a/M14: also enforces `must_change_password` — SERVER-SIDE, not merely
 * advisory (unlike TokenService's own `restrictedUnlocked` claim, which is
 * explicitly advisory-only and re-verified elsewhere). A live DB read
 * (getUserById, the same primary-key lookup ViewerContextProvider already
 * does per catalog request — not a Tier-0-violating cost) happens ONLY for
 * routes outside MUST_CHANGE_PASSWORD_ALLOWED_ROUTES, so the common case
 * (an unflagged user hitting an allow-listed route, or ANY user hitting
 * one of the three always-open routes) never pays for it. This live read
 * is also what makes "PATCH /users/me clears the flag -> the very next
 * request with the SAME still-live access token gets full access" true
 * without requiring a fresh login/refresh — a JWT claim baked at sign time
 * could not do that.
 *
 * R-F7 (opus adversarial review, fix wave — STATE.md "Current-password
 * re-auth on self-changes + the email-collision signal"): a credentials-
 * changed epoch, `users.password_changed_at_ms` (migration 0026). F3's
 * self-service password change revokes every OTHER device's REFRESH
 * token, but a revoked device's ACCESS token is a self-contained JWT that
 * otherwise keeps full API access until its own ≤15-minute expiry — the
 * web copy "Other devices have been signed out." was false for that whole
 * window. Fix: a SEPARATE, unconditional live read (below) rejects any
 * access token whose `iat` claim is strictly before the caller's current
 * `password_changed_at_ms`, on EVERY route — deliberately NOT nested
 * inside the `MUST_CHANGE_PASSWORD_ALLOWED_ROUTES` branch above, because
 * R-F7's own regression (GET /users/me, one of those three routes, from a
 * device whose session was just revoked by an ordinary self-service
 * change) has to be caught there too. It IS skipped while
 * `must_change_password` is true, for a load-bearing reason distinct from
 * R-F7: the admin/CLI temporary-password reset flow (E3a/M14) deliberately
 * lets a flagged user's PRE-reset access token keep authenticating them
 * (as "this exact user", not as "already re-proven") on the narrow
 * allow-listed surface while they re-prove identity with the temporary
 * password via `requireCurrentPassword` — rejecting that same token by
 * epoch here, before `requireCurrentPassword` ever runs, would 401 the
 * legitimate recovery flow itself (see admin-reset-password.e2e.spec.ts's
 * full-loop test, and reauth-review-findings.e2e.spec.ts's "G3: the
 * must-change-password hole stays closed" — both pin this exemption).
 * Once the flag clears, the epoch applies again on the very next request,
 * same as any other password change; a client relying on `iat`-stale
 * access token from that point on needs one refresh, exactly like a
 * revoked-elsewhere device does.
 *
 * AUD-A7b-001 (audit fafa47f, Fix Wave 3): R-F7's epoch was per-USER only,
 * so it did nothing for the two other revocation triggers — POST
 * /auth/logout and DELETE /devices/{id} — which killed a device's refresh
 * token but left its already-issued access token live until its own
 * ≤15-minute expiry. Closed the same way: DELETE /devices/{id} already
 * deletes the device row (both teardown paths), so the device-existence
 * check below rejects it for free; logout keeps the row, so it stamps a
 * device-scoped sibling epoch (`devices.access_revoked_at_ms`, migration
 * 0034) that gets the identical iat comparison. See
 * apps/server/test/device-access-revocation.e2e.spec.ts.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly reflector: Reflector,
    private readonly dbProvider: DbProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (isPublicRoute(req.method, req.path)) {
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
    let claims;
    try {
      claims = await this.tokenService.verifyAccessToken(token);
    } catch {
      throw new UnauthenticatedException(sanitizeInstancePath(req));
    }

    const user: RequestUser = { userId: claims.sub, isAdmin: claims.isAdmin };
    if (claims.deviceId !== undefined) {
      user.deviceId = claims.deviceId;
    }
    req.user = user;

    // R-F7: unconditional (every route, including the must-change-password
    // allow-list) — see this class's own doc comment for why. One live
    // read serves BOTH this check and the must-change-password check
    // below, so the common "unflagged, epoch-clear" case still pays for
    // exactly one getUserById per request outside the three always-open
    // PUBLIC_ROUTES, same as before this fix.
    //
    // AUD-A7b (audit fafa47f, Fix Wave 3 opus review, lane R3-guard-
    // roundtrips): this getUserById and the getDeviceById below (AUD-A7b's
    // own device-scoped check) are fully independent point lookups — neither
    // reads the other's result — so they are fired CONCURRENTLY via
    // Promise.all instead of one-after-the-other. That halves the auth
    // path's DB latency for every device-bound token (invariant 9). The
    // device fetch stays CONDITIONAL on claims.deviceId, exactly as before
    // (Promise.all resolves that array slot to `undefined` synchronously
    // for admin/CLI tokens with no deviceId claim, so they still pay for
    // exactly one round trip). Only the I/O moved — every check below still
    // runs in the EXACT same order as before (user epoch -> device ->
    // must-change-password), so which check throws first, and therefore
    // which error a caller sees when BOTH the user and the device are
    // invalid, is unchanged. See auth.guard.spec.ts's concurrency +
    // ordering matrix.
    const [dbUser, device] = await Promise.all([
      getUserById(this.dbProvider.db, claims.sub),
      claims.deviceId !== undefined ? getDeviceById(this.dbProvider.db, claims.deviceId) : undefined,
    ]);

    if (
      dbUser &&
      !dbUser.must_change_password &&
      dbUser.password_changed_at_ms !== null &&
      claims.iat < Math.ceil(dbUser.password_changed_at_ms / 1000)
    ) {
      // `iat` is JWT's NumericDate — whole SECONDS, no sub-second
      // resolution (RFC 7519; jose's setIssuedAt always floors). Rounding
      // the epoch UP (Math.ceil, not floor) to the next second boundary
      // means a token whose iat-second is AMBIGUOUS with the epoch (minted
      // in the exact same wall-clock second, before OR after the change)
      // is treated as stale — the only conservative choice a 1-second-
      // resolution comparison can make; ties resolve to "reject", never
      // "accept". A token minted a full second or more after the change
      // always passes; ceil never rejects one minted before an EXACT
      // second-boundary change either (Math.ceil is a no-op when
      // password_changed_at_ms % 1000 === 0).
      throw new UnauthenticatedException(sanitizeInstancePath(req));
    }

    // AUD-A7b-001: the device-scoped sibling of the epoch check above.
    // Unconditional whenever the token carries a deviceId — every route,
    // including the must-change-password allow-list, same reasoning as
    // R-F7 (a device an owner just signed out of must lose access
    // immediately even on GET /users/me). A SECOND live read, by design:
    // getUserById above already answers "does this user still exist / has
    // their password changed", not "is THIS device still live" — folding
    // both into one query would mean changing getUserById's shared
    // signature (used by many unrelated callers) just for this guard.
    // getDeviceById is a primary-key point lookup (indexed, same cost
    // class as getUserById's own PK lookup), so this doubles — not
    // multiplies — the per-request DB round trips, and only for
    // device-bound tokens (every ordinary login; admin/CLI-issued tokens
    // with no deviceId claim skip it entirely, same as before this fix).
    // `device` was already fetched CONCURRENTLY with dbUser above (this
    // lane's fix) — this block only makes the decision, it issues no I/O.
    if (claims.deviceId !== undefined) {
      if (
        !device ||
        device.user_id !== claims.sub ||
        (device.access_revoked_at_ms !== null && claims.iat < Math.ceil(device.access_revoked_at_ms / 1000))
      ) {
        // Covers BOTH revocation triggers AUD-A7b-001 named:
        //   - DELETE /devices/{id} deletes the row outright (both the
        //     plain and the kind='remote' teardown paths) -> `!device`.
        //   - POST /auth/logout keeps the row but stamps
        //     access_revoked_at_ms (migration 0034, RefreshTokenService.
        //     logout()) -> the epoch branch, same tie-break rule as the
        //     password check above (ties reject; see its comment).
        // NOT logout-only: login also stamps this same column on
        // device-row reuse (packages/db/src/query/identity.js's
        // updateDeviceForLogin, via loginAccessEpochMs — nowMs floored to
        // the second), so the fresh login token itself always clears this
        // check. R4 (Fix Wave 3) added that second write after finding
        // the two single-writer alternatives each broke something: leaving
        // the prior logout epoch in place DOA'd the new token; clearing it
        // to NULL resurrected a stolen pre-logout one. See identity.js's
        // doc comments on updateDeviceForLogin/loginAccessEpochMs.
        throw new UnauthenticatedException(sanitizeInstancePath(req));
      }
    }

    if (!MUST_CHANGE_PASSWORD_ALLOWED_ROUTES.has(`${req.method} ${req.path}`)) {
      if (dbUser?.must_change_password) {
        throw new MustChangePasswordException(sanitizeInstancePath(req));
      }
    }

    return true;
  }
}
